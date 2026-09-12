/**
 * P0-3 三级溯源（L2 表关联图）：从 SQL 提取主表与 JOIN 链的前端轻量解析。
 * 正则解析思路与 server/query/sqlExecutor.extractTableRefs 一致（服务端白名单校验才是权威），
 * 前端仅用于可视化：主表 + 各 JOIN 段（类型 / 表 / 别名 / ON 条件），含子查询时标记并扁平展开。
 */

export interface SqlLineageEdge {
  /** 表名（保留 SQL 中的原始书写，去除引号与库名前缀） */
  name: string;
  /** 表别名（如有） */
  alias?: string;
  /** 连接类型：MAIN（主表）/ INNER / LEFT / RIGHT / FULL / CROSS / NATURAL */
  joinType: 'MAIN' | 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' | 'NATURAL';
  /** ON / USING 连接条件（截断至 160 字符便于展示） */
  onCondition?: string;
}

export interface SqlLineageResult {
  edges: SqlLineageEdge[];
  /** SQL 是否含子查询（图中提示：已展开为扁平表清单） */
  hasSubquery: boolean;
}

const KEYWORDS = /^(select|where|on|using|left|right|inner|outer|cross|natural|straight_join|as|join|full)$/i;
const MAX_ON_LEN = 160;

/** 去除 SQL 注释与字符串字面量（避免其中的 from/join 关键字被误判为表引用） */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** 去除标识符引号与库名前缀（`db`.`tbl` → tbl） */
function cleanIdent(raw: string): string {
  const stripped = raw.replace(/[`"]/g, '');
  const parts = stripped.split('.');
  return (parts[parts.length - 1] || '').trim();
}

/** 从 from 位置起，找 JOIN 链段后第一个子句关键字（where/group/order/...）的位置 */
function findClauseEnd(text: string, from: number): number {
  const re = /\b(?:where|group\s+by|order\s+by|limit|having|union)\b/gi;
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/** 解析 SQL 的表关联结构（纯函数，便于单测） */
export function parseSqlLineage(sql: string): SqlLineageResult {
  const edges: SqlLineageEdge[] = [];
  if (!sql || !sql.trim()) return { edges, hasSubquery: false };
  const text = stripNoise(sql);
  const hasSubquery = /\(\s*select\b/i.test(text);

  // 1. 主表：首个非子查询的 FROM 目标（FROM (SELECT ...) 由后续扫描子查询内部 FROM 覆盖）
  const fromRe = /\bfrom\s+([`"\w.]+)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text))) {
    if (KEYWORDS.test(m[1])) continue;
    const alias = m[2] && !KEYWORDS.test(m[2]) ? m[2] : undefined;
    edges.push({ name: cleanIdent(m[1]), ...(alias ? { alias } : {}), joinType: 'MAIN' });
    break;
  }

  // 2. JOIN 链：记录每个 JOIN 头位置，逐段解析 "表 [别名] [ON 条件]"
  const joinHead = /\b(?:(left|right|inner|full|cross|natural)\s+)?(?:outer\s+)?(?:straight_join|join)\b/gi;
  const heads: { index: number; end: number; type: string }[] = [];
  while ((m = joinHead.exec(text))) {
    heads.push({ index: m.index, end: m.index + m[0].length, type: (m[1] || 'inner').toUpperCase() });
  }

  for (let i = 0; i < heads.length; i += 1) {
    const segStart = heads[i].end;
    const segEnd = i + 1 < heads.length ? heads[i + 1].index : findClauseEnd(text, segStart);
    const seg = text.slice(segStart, segEnd);
    // 表名 [AS] 别名（子查询 JOIN (SELECT ...) 无法可视化表名，跳过；内部表由 FROM 扫描覆盖）
    const tm = seg.match(/^\s*([`"\w.]+)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/i);
    if (!tm || KEYWORDS.test(tm[1])) continue;
    const alias = tm[2] && !KEYWORDS.test(tm[2]) ? tm[2] : undefined;
    // ON 条件（优先）；无 ON 时尝试 USING(col)
    const onMatch = seg.match(/\bon\b([\s\S]*)$/i);
    let on = onMatch ? onMatch[1].trim().replace(/\s+/g, ' ') : '';
    if (!on) {
      const usingMatch = seg.match(/\busing\s*\(([^)]*)\)/i);
      if (usingMatch) on = `USING (${usingMatch[1].trim()})`;
    }
    edges.push({
      name: cleanIdent(tm[1]),
      ...(alias ? { alias } : {}),
      joinType: heads[i].type as SqlLineageEdge['joinType'],
      ...(on ? { onCondition: on.slice(0, MAX_ON_LEN) } : {}),
    });
  }

  return { edges, hasSubquery };
}
