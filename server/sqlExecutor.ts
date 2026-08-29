/**
 * P0 核心改造：SQL 安全执行层。
 * LLM 生成的 SQL 必须通过本层校验后才允许对真实数据源执行：
 * SELECT-only、表名白名单（scope+ 敏感过滤后的 Schema）、敏感列拒绝、
 * 单语句、强制 LIMIT、执行超时、结果行数截断。
 * P0-2: 新增可选自愈入口——校验失败时可调用 LLM 纠偏重试一次，统一审计出口。
 * 数据源连接按 dataSourceId 建池缓存；配置变更后由路由侧 invalidateExecutorPool 失效。
 */
import mysql from 'mysql2/promise';
import pg from 'pg';
// node-sql-parser 是 CJS 包，ESM 下需默认导入后解构（tsx/Node ESM 命名导出不可用）
import sqlParserPkg from 'node-sql-parser';
import { getPool } from './db';
import { decryptSecret } from './secretsCrypto';
import { callLLMJson } from './llmClient';

const { Parser: SqlAstParser } = sqlParserPkg;

/** 执行引擎方言：mysql 走 mysql2；postgresql/greenplum 同属 PG 协议走 pg 驱动 */
export type SqlDialect = 'mysql' | 'pg';

/** 数据源类型 → 执行方言；不支持的类型返回 null */
export function dialectOfDsType(dsType: string): SqlDialect | null {
  if (dsType === 'mysql') return 'mysql';
  if (dsType === 'postgresql' || dsType === 'greenplum') return 'pg';
  return null;
}

// 复用 liveQuery 的方言规则逻辑（简单版，仅 MySQL）
function dialectPromptOf(dsType?: string): { label: string; rules: string } {
  if (dsType === 'greenplum') return { label: 'Greenplum（PostgreSQL 兼容方言）', rules: '- 方言要点：分页仅支持 LIMIT n OFFSET m；标识符用双引号；日期用 EXTRACT/date_trunc；空值用 COALESCE；字符串拼接用 ||；分组聚合用 STRING_AGG' };
  if (dsType === 'postgresql') return { label: 'PostgreSQL', rules: '- 方言要点：分页仅支持 LIMIT n OFFSET m；标识符用双引号；日期用 EXTRACT/date_trunc；空值用 COALESCE；字符串拼接用 ||；分组聚合用 STRING_AGG' };
  return { label: 'MySQL', rules: '' };
}

const MAX_ROWS = 100000; // v0.4.14：500→100000，满足真实记录数输出，保留兜底防 OOM
const QUERY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * P1-9 数据源连接池容量公式化（原硬编码 max=3）。
 * 容量模型：每次问数仅在 SQL 执行阶段持有连接（秒级，QUERY_TIMEOUT_MS 兜底），
 * 端到端延迟由 LLM 生成主导（数十秒级），故数据源连接并发 ≈ 并发用户数 / 4。
 * DS_POOL_MAX 显式配置优先；否则按 EXPECTED_CONCURRENT_USERS 推导，clamp 到 [3, 20]
 * （下限不逊于原硬编码水位，上限防止打爆数据源端 max_connections）。
 */
export function dsPoolMax(): number {
  const raw = process.env.DS_POOL_MAX;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.min(100, Math.floor(n));
  }
  const users = Number(process.env.EXPECTED_CONCURRENT_USERS) || 20;
  return Math.min(20, Math.max(3, Math.ceil(users / 4)));
}

// 写/DDL/管理类关键字一律拒绝（对剥离注释与字符串后的 SQL 做整词匹配）。
// 注意词表必须避开合法 SELECT 语法内会出现的词：desc（ORDER BY DESC）、replace/use/set/do/call/check/load/show
// 等不在此列——这些语句本就无法出现在 SELECT 内部，"只允许 SELECT 开头"一层已拦截。
// procedure 在列：PROCEDURE ANALYSE 是 SELECT 内真实存在的危险构造。
const FORBIDDEN_PATTERN =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|rename|lock|unlock|exec|execute|outfile|infile|dumpfile|procedure|explain|handler|install|uninstall|kill|shutdown|analyze|optimize|repair|checksum|flush|reset|purge|binlog|prepare|deallocate|release|savepoint|rollback|commit|begin|xa)\b/i;

/** M3 应用库中间表查询校验复用同一危险关键字词表 */
export const FORBIDDEN_KEYWORD_RE = FORBIDDEN_PATTERN;

// 注意：项目 tsconfig 未开启 strictNullChecks，真值窄化（if (!x.ok)）对判别联合不生效，
// 所有使用处必须用 x.ok !== true / x.ok === false 的显式比较（同 queryGuard 的先例）。
export type SqlSafetyResult = { ok: true; sql: string; astFallback?: boolean } | { ok: false; reason: string };

/**
 * 剥离单行/块注释与字符串字面量，避免注释或字符串中的关键字干扰结构校验。
 * dialect='pg' 时保留双引号段：PostgreSQL/Greenplum 双引号是标识符（表名/列名），
 * 若当字符串字面量剥掉，表引用提取会丢失 FROM 目标，导致合法 PG SQL 被误拦（v0.9.1 修复）。
 */
export function stripCommentsAndStrings(sql: string, dialect: SqlDialect = 'mysql'): string {
  const out = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
  // MySQL 默认模式下双引号等同字符串字面量（非 ANSI_QUOTES），剥掉防关键字干扰
  return dialect === 'pg' ? out : out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
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
    // 段内含括号（子查询/函数）时逗号分表不可靠：子查询 SELECT 列表的逗号会把列名/聚合函数名
    // （如 SUM/BNTFJE）误当表名拒拦合法 SQL；子查询内部真实表已由主扫描 FROM/JOIN 命中覆盖
    if (/[()]/.test(m[1])) continue;
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

// P1 AST 二道防线：node-sql-parser 语法树级复核。
// 解析成功 → 强校验（所有语句类型必须为 select、AST 提取的表必须全在白名单）；
// 解析失败 → 放行不误伤（MySQL 方言边界），此时第一道正则防线的结论已生效。
const astParser = new SqlAstParser();
export function checkAstSafety(
  sql: string,
  allowedTables: Set<string>,
  dialect: SqlDialect = 'mysql'
): { ok: true; astFallback?: boolean } | { ok: false; reason: string } {
  let entries: string[];
  try {
    entries = astParser.tableList(sql, { database: dialect === 'pg' ? 'PostgreSQL' : 'MySQL' });
  } catch {
    // P1-3：AST 解析失败放行（正则白名单已兜底），但标记 astFallback 供路由层审计
    return { ok: true, astFallback: true };
  }
  for (const entry of entries) {
    // 条目格式：`<action>::<db>::<table>`，如 `select::null::orders`
    const [action, , table] = String(entry).split('::');
    if (action !== 'select') {
      return { ok: false, reason: `SQL 包含非只读操作（${action}）` };
    }
    if (table && table !== 'null' && !allowedTables.has(table.toLowerCase())) {
      return { ok: false, reason: `SQL 引用了问数范围外的表：${table}` };
    }
  }
  return { ok: true };
}

/**
 * 表名纠偏：LLM 常给白名单表名臆加 tbl_/t_ 前缀（导致白名单校验失败降级演示数据），
 * 仅当去前缀后与白名单表名逐字一致时才整词替换回真实表名（不扩大也不缩小可执行范围）。
 */
export function repairTablePrefixes(sql: string, allowedTables: { name: string }[]): string {
  let out = sql;
  for (const t of allowedTables || []) {
    const name = String(t?.name || '').trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b(?:tbl_|t_)(\`${escaped}\`|${escaped})\\b`, 'gi'), (_m, g1: string) =>
      g1.startsWith('`') ? `\`${name}\`` : name
    );
  }
  return out;
}

/**
 * 校验 LLM 生成的 SQL 是否允许对真实数据源执行。
 * allowedTables：已通过 scope 白名单与敏感列过滤的 Schema（含列名清单）。
 * sensitiveColumns：被剔除的敏感列名（裸列名），SQL 引用即拒绝。
 * 通过时返回可能被追加/clamp LIMIT 的 SQL。
 */
export function validateSelectSql(
  rawSqlInput: unknown,
  allowedTables: { name: string; columns?: { name: string }[] }[],
  sensitiveColumns: string[] = [],
  dialect: SqlDialect = 'mysql',
  maxRows: number = MAX_ROWS
): SqlSafetyResult {
  if (typeof rawSqlInput !== 'string' || !rawSqlInput.trim()) {
    return { ok: false, reason: 'SQL 为空或格式无效' };
  }
  const rawSql = repairTablePrefixes(rawSqlInput, allowedTables);
  const stripped = stripCommentsAndStrings(rawSql, dialect).trim().replace(/\s+/g, ' ');
  // 结构安全校验基于 stripped（字符串已置空，防字面量内关键字干扰）；
  // 但最终 SQL 必须保留字符串字面量值（如 WHERE region = '合肥市'），
  // 只剥注释（否则空白归一后行尾注释会吞掉追加的 LIMIT）
  const original = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/;+\s*$/, '');
  // 语句过长直接拒绝（防御畸形输出；v0.4.13 随路由层放宽至 10000）
  if (stripped.length > 10000) {
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
  // P1 AST 二道防线（正则白名单之后）：语法树级复核语句类型与表引用
  const astCheck = checkAstSafety(withoutTrailing, allowed, dialect);
  if (astCheck.ok !== true) {
    return { ok: false, reason: astCheck.reason };
  }
  const astFallback = astCheck.astFallback === true;
  // 敏感列拒绝（裸列名整词匹配，覆盖反引号写法）
  for (const col of sensitiveColumns) {
    const name = String(col).split('.').pop() || '';
    if (!name) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(withoutTrailing)) {
      return { ok: false, reason: `SQL 涉及受保护的敏感字段：${name}` };
    }
  }
  // 强制 LIMIT：无 LIMIT 追加；有 LIMIT 则将返回行数 clamp 到 MAX_ROWS（v0.4.14 放宽至 10 万）
  // 方言差异：MySQL 支持 LIMIT offset,count；PG/Greenplum 仅支持 LIMIT n OFFSET m
  // 注意：基于原文操作，保证字符串字面量（如 WHERE region = '合肥市'）不被篡改
  let finalSql = original;
  const limitRe = /\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+(\d+))?\s*$/i;
  const lm = finalSql.match(limitRe);
  if (!lm) {
    finalSql = `${finalSql} LIMIT ${maxRows}`;
  } else {
    const count = lm[2] ? Number(lm[2]) : Number(lm[1]);
    const offset = lm[2] ? Number(lm[1]) : lm[3] ? Number(lm[3]) : 0;
    const clamped = Math.min(count, maxRows);
    const replacement =
      dialect === 'pg'
        ? offset > 0
          ? `LIMIT ${clamped} OFFSET ${offset}`
          : `LIMIT ${clamped}`
        : offset > 0
          ? `LIMIT ${offset}, ${clamped}`
          : `LIMIT ${clamped}`;
    finalSql = finalSql.replace(limitRe, replacement);
  }
  return { ok: true, sql: finalSql, astFallback };
}

/**
 * P1-3 行级权限：把带行过滤的表在 AST 中包裹为过滤子查询
 * （FROM clients → FROM (SELECT * FROM clients WHERE <谓词>) AS clients），
 * 递归覆盖子查询/UNION 内的引用。谓词解析失败或 AST 回写失败均 fail-closed 拒绝，
 * 安全优先于可用性（此时问数降级演示模式，不泄露受限行）。
 * rowFilters 键为小写实际表名；SQL 未引用受控表时原样返回。
 */
export function injectRowFilters(
  sql: string,
  rowFilters: Record<string, string>,
  dialect: SqlDialect = 'mysql'
): SqlSafetyResult {
  const lower: Record<string, string> = {};
  for (const [name, pred] of Object.entries(rowFilters)) {
    if (name && pred) lower[name.toLowerCase()] = pred;
  }
  if (Object.keys(lower).length === 0) return { ok: true, sql };

  const stripped = stripCommentsAndStrings(sql, dialect);
  const refs = extractTableRefs(stripped.replace(/;+\s*$/, ''));
  if (!refs.some((r) => lower[r])) return { ok: true, sql };

  const opt = { database: dialect === 'pg' ? 'PostgreSQL' : 'MySQL' };
  try {
    const parsed: any = astParser.astify(sql, opt);

    // 谓词 → 派生表 expr：解析 `SELECT * FROM (SELECT * FROM t WHERE pred) AS t`
    // 直接复用解析产物（而非手工拼 AST），保证 sqlify 回写时派生表带括号；
    // 谓词非法自然抛错，fail-closed。
    const wrappedOf = (table: string, pred: string): any => {
      const helper: any = astParser.astify(`SELECT * FROM (SELECT * FROM ${table} WHERE ${pred}) AS ${table}`, opt);
      const h = Array.isArray(helper) ? helper[0] : helper;
      const item = h && Array.isArray(h.from) ? h.from[0] : null;
      if (!item || !item.expr) throw new Error('谓词解析失败');
      return item.expr;
    };

    const wrapFrom = (from: any): void => {
      if (!Array.isArray(from)) return;
      for (const item of from) {
        if (!item) continue;
        // 派生表（FROM (SELECT ...)）递归下钻：5.x 为 { ast, parentheses } 包裹层，旧版直接是 select 节点
        if (item.expr && typeof item.expr === 'object') {
          const inner = item.expr.ast && typeof item.expr.ast === 'object' ? item.expr.ast : item.expr;
          walkNode(inner);
        }
        const tableName = typeof item.table === 'string' ? item.table : '';
        const pred = tableName ? lower[tableName.toLowerCase()] : undefined;
        if (!pred) continue;
        // 未显式起别名时补上原表名，保证外层列引用不变
        if (!item.as) item.as = tableName;
        item.expr = wrappedOf(tableName, pred);
        item.table = null;
        item.db = null;
      }
    };
    const walkNode = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walkNode);
        return;
      }
      if (node.type === 'select') {
        wrapFrom(node.from);
        // WHERE/HAVING 等表达式中的子查询（IN (SELECT ...)、EXISTS 等）
        walkExprSubqueries(node.where);
        walkExprSubqueries(node.having);
        // UNION/UNION ALL 链（node-sql-parser 5.x 用 _next 链 + set_op）
        if (node._next) walkNode(node._next);
      }
    };
    const walkExprSubqueries = (expr: any): void => {
      if (!expr || typeof expr !== 'object') return;
      if (Array.isArray(expr)) {
        expr.forEach(walkExprSubqueries);
        return;
      }
      if (expr.ast && typeof expr.ast === 'object') walkNode(expr.ast);
      walkExprSubqueries(expr.left);
      walkExprSubqueries(expr.right);
      if (expr.value !== undefined) walkExprSubqueries(expr.value);
      if (Array.isArray(expr.args)) walkExprSubqueries(expr.args);
    };

    walkNode(Array.isArray(parsed) ? parsed[0] : parsed);
    const rewritten = astParser.sqlify(parsed, opt);
    if (typeof rewritten !== 'string' || !rewritten.trim()) {
      return { ok: false, reason: '行级权限注入失败，已拒绝该查询' };
    }
    return { ok: true, sql: rewritten };
  } catch {
    return { ok: false, reason: '行级权限注入失败，已拒绝该查询' };
  }
}

// ---- 数据源连接池（按数据源 ID 缓存；mysql 走 mysql2，PG 系走 pg 驱动） ----
type DsPoolEntry = { dialect: 'mysql'; pool: mysql.Pool } | { dialect: 'pg'; pool: pg.Pool };
const dsPools = new Map<string, DsPoolEntry>();

/** 数据源配置变更/删除后调用，使连接池失效 */
export function invalidateExecutorPool(dataSourceId?: string): void {
  if (dataSourceId) {
    const entry = dsPools.get(dataSourceId);
    dsPools.delete(dataSourceId);
    entry?.pool.end().catch(() => undefined);
  } else {
    for (const [id, entry] of dsPools) {
      dsPools.delete(id);
      entry.pool.end().catch(() => undefined);
    }
  }
}

export interface ExecResult {
  rows: Record<string, any>[];
  rowCount: number;
  /** true 表示结果被 MAX_ROWS 截断 */
  truncated: boolean;
  finalSql: string;
  /** P1-3：true 表示 AST 解析失败放行（正则白名单兜底），供路由层审计 */
  astFallback?: boolean;
}

export type ExecOutcome =
  | { ok: true; result: ExecResult }
  | { ok: false; reason: string };

/** 读取数据源连接配置（含密码，仅服务端使用；dataVersion 指纹探测亦复用） */
export async function loadDataSourceConfig(dataSourceId: string): Promise<{ type: string; config: any } | null> {
  const [rows] = await getPool().query('SELECT type, config_json FROM data_sources WHERE id = ?', [dataSourceId]);
  const ds = (rows as any[])[0];
  if (!ds) return null;
  let config = ds.config_json;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { config = {}; }
  }
  config = config || {};
  // P0：落库密码为 AES-256-GCM 密文，连接前解密（明文存量透传）
  if (config.password) config.password = decryptSecret(String(config.password));
  return { type: String(ds.type || ''), config };
}

export function getDsPool(dataSourceId: string, dialect: SqlDialect, config: any): DsPoolEntry {
  let entry = dsPools.get(dataSourceId);
  if (!entry) {
    if (dialect === 'pg') {
      // PostgreSQL / Greenplum：同属 PG 协议。超时由服务端 statement_timeout 强制，
      // 连接级超时用 connectionTimeoutMillis；只读保障以 SELECT-only 校验 + 单语句为主防线。
      entry = {
        dialect: 'pg',
        pool: new pg.Pool({
          host: config?.host || '127.0.0.1',
          port: Number(config?.port) || 5432,
          user: config?.username || 'postgres',
          password: config?.password || '',
          database: config?.database || undefined,
          max: dsPoolMax(),
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
          statement_timeout: QUERY_TIMEOUT_MS,
        }),
      };
    } else {
      entry = {
        dialect: 'mysql',
        pool: mysql.createPool({
          host: config?.host || '127.0.0.1',
          port: Number(config?.port) || 3306,
          user: config?.username || 'root',
          password: config?.password || '',
          database: config?.database || undefined,
          connectionLimit: dsPoolMax(),
          connectTimeout: CONNECT_TIMEOUT_MS,
          multipleStatements: false,
        }),
      };
    }
    dsPools.set(dataSourceId, entry);
  }
  return entry;
}

/**
 * 校验并执行 SQL。dataSourceId 必须是支持真实执行的数据源类型
 * （mysql / postgresql / greenplum），否则返回 UNSUPPORTED_DS_TYPE（调用方走演示模式）。
 * rowFilters：P1-3 行级权限（实际表名 → 谓词），白名单校验通过后 AST 强制注入。
 */
export async function executeSafeSql(
  dataSourceId: string,
  rawSql: unknown,
  allowedTables: { name: string; columns?: { name: string }[] }[],
  sensitiveColumns: string[] = [],
  maxRows: number = MAX_ROWS,
  rowFilters: Record<string, string> = {}
): Promise<ExecOutcome> {
  const ds = await loadDataSourceConfig(dataSourceId);
  if (!ds) return { ok: false, reason: '数据源不存在' };
  const dialect = dialectOfDsType(ds.type);
  if (!dialect) {
    return { ok: false, reason: 'UNSUPPORTED_DS_TYPE' };
  }

  const check = validateSelectSql(rawSql, allowedTables, sensitiveColumns, dialect, maxRows);
  if (check.ok !== true) return { ok: false, reason: check.reason };

  // P1-3 行级权限：校验通过后、执行前强制注入（注入失败 fail-closed）
  const injected = injectRowFilters(check.sql, rowFilters, dialect);
  if (injected.ok !== true) return { ok: false, reason: injected.reason };
  const finalSql = injected.sql;

  try {
    const entry = getDsPool(dataSourceId, dialect, ds.config);
    let list: Record<string, any>[];
    if (entry.dialect === 'pg') {
      // pg 驱动：超时由建池时的 statement_timeout 承担，结果在 result.rows
      const result = await entry.pool.query(finalSql);
      list = Array.isArray(result.rows) ? result.rows : [];
    } else {
      const [rows] = await entry.pool.query({ sql: finalSql, timeout: QUERY_TIMEOUT_MS });
      list = (Array.isArray(rows) ? rows : []) as Record<string, any>[];
    }
    return {
      ok: true,
      result: {
        rows: list.slice(0, maxRows),
        rowCount: list.length,
        truncated: list.length > maxRows,
        finalSql,
        astFallback: check.astFallback === true,
      },
    };
  } catch (err: any) {
    return { ok: false, reason: `SQL 执行失败：${String(err?.message || err).slice(0, 200)}` };
  }
}
