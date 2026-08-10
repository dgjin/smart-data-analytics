/**
 * P0 核心改造：SQL 安全执行层。
 * LLM 生成的 SQL 必须通过本层校验后才允许对真实数据源执行：
 * SELECT-only、表名白名单（scope+敏感过滤后的 Schema）、敏感列拒绝、
 * 单语句、强制 LIMIT、执行超时、结果行数截断。
 * 数据源连接按 dataSourceId 建池缓存；配置变更后由路由侧 invalidateExecutorPool 失效。
 */
import mysql from 'mysql2/promise';
import { getPool } from './db';

const MAX_ROWS = 500;
const QUERY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

// 写/DDL/管理类关键字一律拒绝（对剥离注释与字符串后的 SQL 做整词匹配）。
// 注意词表必须避开合法 SELECT 语法内会出现的词：desc（ORDER BY DESC）、replace/use/set/do/call/check/load/show
// 等不在此列——这些语句本就无法出现在 SELECT 内部，"只允许 SELECT 开头"一层已拦截。
// procedure 在列：PROCEDURE ANALYSE 是 SELECT 内真实存在的危险构造。
const FORBIDDEN_PATTERN =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|rename|lock|unlock|exec|execute|outfile|infile|dumpfile|procedure|explain|handler|install|uninstall|kill|shutdown|analyze|optimize|repair|checksum|flush|reset|purge|binlog|prepare|deallocate|release|savepoint|rollback|commit|begin|xa)\b/i;

// 注意：项目 tsconfig 未开启 strictNullChecks，真值窄化（if (!x.ok)）对判别联合不生效，
// 所有使用处必须用 x.ok !== true / x.ok === false 的显式比较（同 queryGuard 的先例）。
export type SqlSafetyResult = { ok: true; sql: string } | { ok: false; reason: string };

/** 剥离单行/块注释与字符串字面量，避免注释或字符串中的关键字干扰结构校验 */
export function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function cleanIdent(raw: string): string {
  const stripped = raw.replace(/[`"]/g, '');
  const parts = stripped.split('.');
  return (parts[parts.length - 1] || '').trim().toLowerCase();
}

/**
 * 提取 SQL 中 FROM/JOIN 引用的全部表名（含子查询，支持反引号与库名前缀、逗号分隔多表）。
 * 返回小写表名清单（不含库名前缀）。
 */
export function extractTableRefs(strippedSql: string): string[] {
  const refs = new Set<string>();
  const KEYWORDS = /^(select|where|on|using|left|right|inner|outer|cross|natural|straight_join|as|join|full)$/i;

  // 主扫描：逐个命中 FROM/JOIN 后紧跟的标识符（全局扫描天然覆盖子查询内部的 FROM）
  const direct = /\b(?:from|join)\s+([`"\w.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = direct.exec(strippedSql))) {
    if (!KEYWORDS.test(m[1])) refs.add(cleanIdent(m[1]));
  }
  // 补充：FROM 子句内逗号分隔的多表（JOIN 链已由主扫描覆盖；到子句终止或右括号为止）
  const fromSeg = /\bfrom\b([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|\bunion\b|\)|;|$)/gi;
  while ((m = fromSeg.exec(strippedSql))) {
    for (const slotRaw of m[1].split(',')) {
      const slot = slotRaw.split(/\bon\b|\busing\b/i)[0];
      const lead = slot.trimStart().match(/^([`"\w.]+)/);
      if (!lead || KEYWORDS.test(lead[1])) continue; // 子查询 (SELECT...) 由主扫描覆盖其内部表
      refs.add(cleanIdent(lead[1]));
    }
  }
  refs.delete('');
  return [...refs];
}

/**
 * 校验 LLM 生成的 SQL 是否允许对真实数据源执行。
 * allowedTables：已通过 scope 白名单与敏感列过滤的 Schema（含列名清单）。
 * sensitiveColumns：被剔除的敏感列名（裸列名），SQL 引用即拒绝。
 * 通过时返回可能被追加/clamp LIMIT 的 SQL。
 */
export function validateSelectSql(
  rawSql: unknown,
  allowedTables: { name: string; columns?: { name: string }[] }[],
  sensitiveColumns: string[] = []
): SqlSafetyResult {
  if (typeof rawSql !== 'string' || !rawSql.trim()) {
    return { ok: false, reason: 'SQL 为空或格式无效' };
  }
  const stripped = stripCommentsAndStrings(rawSql).trim().replace(/\s+/g, ' ');
  // 语句过长直接拒绝（防御畸形输出）
  if (stripped.length > 4000) {
    return { ok: false, reason: 'SQL 长度超出限制' };
  }
  // 单语句：分号只允许出现在末尾
  const withoutTrailing = stripped.replace(/;+\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return { ok: false, reason: '只允许单条 SELECT 语句' };
  }
  if (!/^select\b/i.test(withoutTrailing)) {
    return { ok: false, reason: '只允许 SELECT 查询' };
  }
  if (/\binto\b/i.test(withoutTrailing)) {
    return { ok: false, reason: '禁止 INTO 写文件/表操作' };
  }
  if (FORBIDDEN_PATTERN.test(withoutTrailing)) {
    return { ok: false, reason: 'SQL 包含不允许的关键字（仅支持只读查询）' };
  }
  // 表名白名单
  const allowed = new Set(allowedTables.map((t) => String(t.name || '').toLowerCase()));
  const refs = extractTableRefs(withoutTrailing);
  if (refs.length === 0) {
    return { ok: false, reason: 'SQL 未引用任何数据表' };
  }
  const illegal = refs.filter((r) => !allowed.has(r));
  if (illegal.length > 0) {
    return { ok: false, reason: `SQL 引用了问数范围外的表：${illegal.join(', ')}` };
  }
  // 敏感列拒绝（裸列名整词匹配，覆盖反引号写法）
  for (const col of sensitiveColumns) {
    const name = String(col).split('.').pop() || '';
    if (!name) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(withoutTrailing)) {
      return { ok: false, reason: `SQL 涉及受保护的敏感字段：${name}` };
    }
  }
  // 强制 LIMIT：无 LIMIT 追加；有 LIMIT 则将返回行数 clamp 到 MAX_ROWS
  let finalSql = withoutTrailing;
  const limitRe = /\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+(\d+))?\s*$/i;
  const lm = finalSql.match(limitRe);
  if (!lm) {
    finalSql = `${finalSql} LIMIT ${MAX_ROWS}`;
  } else {
    const count = lm[2] ? Number(lm[2]) : Number(lm[1]);
    const offset = lm[2] ? Number(lm[1]) : lm[3] ? Number(lm[3]) : 0;
    const clamped = Math.min(count, MAX_ROWS);
    finalSql = finalSql.replace(
      limitRe,
      offset > 0 ? `LIMIT ${offset}, ${clamped}` : `LIMIT ${clamped}`
    );
  }
  return { ok: true, sql: finalSql };
}

// ---- 数据源连接池（按数据源 ID 缓存） ----
const dsPools = new Map<string, mysql.Pool>();

/** 数据源配置变更/删除后调用，使连接池失效 */
export function invalidateExecutorPool(dataSourceId?: string): void {
  if (dataSourceId) {
    const p = dsPools.get(dataSourceId);
    dsPools.delete(dataSourceId);
    p?.end().catch(() => undefined);
  } else {
    for (const [id, p] of dsPools) {
      dsPools.delete(id);
      p.end().catch(() => undefined);
    }
  }
}

export interface ExecResult {
  rows: Record<string, any>[];
  rowCount: number;
  /** true 表示结果被 MAX_ROWS 截断 */
  truncated: boolean;
  finalSql: string;
}

export type ExecOutcome =
  | { ok: true; result: ExecResult }
  | { ok: false; reason: string };

/** 读取数据源连接配置（含密码，仅服务端使用） */
async function loadDataSourceConfig(dataSourceId: string): Promise<{ type: string; config: any } | null> {
  const [rows] = await getPool().query('SELECT type, config_json FROM data_sources WHERE id = ?', [dataSourceId]);
  const ds = (rows as any[])[0];
  if (!ds) return null;
  let config = ds.config_json;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { config = {}; }
  }
  return { type: String(ds.type || ''), config: config || {} };
}

function getDsPool(dataSourceId: string, config: any): mysql.Pool {
  let pool = dsPools.get(dataSourceId);
  if (!pool) {
    pool = mysql.createPool({
      host: config?.host || '127.0.0.1',
      port: Number(config?.port) || 3306,
      user: config?.username || 'root',
      password: config?.password || '',
      database: config?.database || undefined,
      connectionLimit: 3,
      connectTimeout: CONNECT_TIMEOUT_MS,
      multipleStatements: false,
      // 只读保障以 SELECT-only 校验 + 单语句为主防线；建议数据源配置只读账号
    });
    dsPools.set(dataSourceId, pool);
  }
  return pool;
}

/**
 * 校验并执行 SQL。dataSourceId 必须是 mysql 类型数据源，否则返回不支持错误（调用方走演示模式）。
 */
export async function executeSafeSql(
  dataSourceId: string,
  rawSql: unknown,
  allowedTables: { name: string; columns?: { name: string }[] }[],
  sensitiveColumns: string[] = []
): Promise<ExecOutcome> {
  const check = validateSelectSql(rawSql, allowedTables, sensitiveColumns);
  if (check.ok !== true) return { ok: false, reason: check.reason };

  const ds = await loadDataSourceConfig(dataSourceId);
  if (!ds) return { ok: false, reason: '数据源不存在' };
  if (ds.type !== 'mysql') {
    return { ok: false, reason: 'NOT_MYSQL' };
  }

  try {
    const pool = getDsPool(dataSourceId, ds.config);
    const [rows] = await pool.query({ sql: check.sql, timeout: QUERY_TIMEOUT_MS });
    const list = (Array.isArray(rows) ? rows : []) as Record<string, any>[];
    return {
      ok: true,
      result: {
        rows: list.slice(0, MAX_ROWS),
        rowCount: list.length,
        truncated: list.length > MAX_ROWS || /LIMIT 500\s*$/i.test(check.sql),
        finalSql: check.sql,
      },
    };
  } catch (err: any) {
    return { ok: false, reason: `SQL 执行失败：${String(err?.message || err).slice(0, 200)}` };
  }
}
