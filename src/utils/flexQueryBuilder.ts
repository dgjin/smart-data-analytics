/**
 * 灵活查询：拖拉拽配置的 SQL 构建纯函数（客户端第一道防线）。
 * 生成的 SQL 提交 /api/query/execute-sql，仍受服务端 SELECT-only + 白名单 + 敏感列 + 行级过滤约束。
 * 标识符仅允许 [A-Za-z0-9_] 并统一加引号包裹；筛选值单引号加倍转义，防注入。
 *
 * v0.4.10（参照 Agile Query 增强）：COUNT_DISTINCT 去重计数、BETWEEN 区间与 IS [NOT] NULL 筛选、
 * 指标过滤（HAVING 聚合后过滤）、排序目标可选任一指标别名或维度列。
 * v0.5.4：金额单位换算——选定非「元」单位时，金额类列的 SUM/AVG/MIN/MAX 聚合按除数换算
 * （ROUND(AGG(col)/divisor, 2)），HAVING 中金额列表达式同口径；COUNT 类聚合与「元」原值不换算。
 * v0.9.75（灵活查询 P0 增强）：时间维度粒度分组（按年/季/月/周/日）、多列排序（orderBys 数组）、
 * LIKE 匹配模式（包含/开头是/结尾是/精确）、维度结果列名统一取末段（修复跨表维度图表/透视键不匹配）。
 */
import { TableSchema } from '../types/analytics';

export type FlexAgg = 'SUM' | 'COUNT' | 'COUNT_DISTINCT' | 'AVG' | 'MAX' | 'MIN';
export type FlexFilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'IN' | 'BETWEEN' | 'IS NULL' | 'IS NOT NULL';
export type FlexHavingOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

/** v0.9.75：时间维度粒度（作用于日期类维度，SQL 端按粒度格式化后分组） */
export type FlexTimeUnit = 'year' | 'quarter' | 'month' | 'week' | 'day';
export const FLEX_TIME_UNITS: FlexTimeUnit[] = ['year', 'quarter', 'month', 'week', 'day'];

/** v0.9.75：LIKE 匹配模式（contains 为默认，延续旧版 %v% 行为） */
export type FlexLikeMode = 'contains' | 'startsWith' | 'endsWith' | 'exact';
export const FLEX_LIKE_MODES: FlexLikeMode[] = ['contains', 'startsWith', 'endsWith', 'exact'];

export interface FlexMeasure {
  column: string;
  agg: FlexAgg;
}

export interface FlexFilter {
  column: string;
  op: FlexFilterOp;
  value: string;
  /** v0.9.75：LIKE 的匹配模式（默认包含）；其余操作符忽略 */
  likeMode?: FlexLikeMode;
}

/** 指标过滤（HAVING）：聚合结果上的条件过滤，如 SUM(投放金额) > 1000 */
export interface FlexHaving {
  agg: FlexAgg;
  column: string;
  op: FlexHavingOp;
  value: string;
}

/** 排序目标：指标别名或维度列名；null 表示不排序 */
export interface FlexOrderBy {
  by: string;
  dir: 'desc' | 'asc';
}

/** 多表关联（JOIN）配置 */
export interface FlexJoin {
  /** 关联表名 */
  table: string;
  /** JOIN 类型：INNER（默认）/ LEFT */
  type: 'INNER' | 'LEFT';
  /** JOIN 条件：left=主表字段，right=关联表字段 */
  on: { left: string; right: string };
}

export interface FlexQueryConfig {
  table: string;
  /** 关联表（JOIN），可为空；字段引用支持 table.column 跨表格式 */
  joins?: FlexJoin[];
  /** 分组维度（GROUP BY），可为空（全表聚合） */
  dimensions: string[];
  measures: FlexMeasure[];
  filters: FlexFilter[];
  /** 指标过滤（HAVING 子句） */
  havings: FlexHaving[];
  /** 排序（v0.9.75 起支持多列）：by 为指标别名或维度列名；空数组不排序 */
  orderBys: FlexOrderBy[];
  /** v0.9.75：维度时间粒度（维度全名 → 粒度）；未配置的维度按原值分组 */
  dimTimeUnits?: Record<string, FlexTimeUnit>;
  /** 返回行数上限（1-100000，v0.4.14 放宽防 OOM 兜底） */
  limit: number;
}

export const FLEX_AGGS: FlexAgg[] = ['SUM', 'COUNT', 'COUNT_DISTINCT', 'AVG', 'MAX', 'MIN'];
export const FLEX_FILTER_OPS: FlexFilterOp[] = ['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];
export const FLEX_HAVING_OPS: FlexHavingOp[] = ['=', '!=', '>', '>=', '<', '<='];
/** 无值操作符：不需要填筛选值 */
export const FLEX_NO_VALUE_OPS: FlexFilterOp[] = ['IS NULL', 'IS NOT NULL'];

const IDENT_RE = /^[A-Za-z0-9_]+$/;

/** 聚合表达式：COUNT_DISTINCT → COUNT(DISTINCT col)，其余 AGG(col) */
export function aggExpression(agg: FlexAgg, quotedCol: string): string {
  return agg === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${quotedCol})` : `${agg}(${quotedCol})`;
}

/** 金额单位换算配置（label 供 UI 标注，divisor>1 时才进行换算） */
export interface FlexAmountUnit {
  label: string;
  divisor: number;
}

/** 金额类列关键词：列名或业务描述命中即视为金额列（单位换算仅作用于金额列） */
const AMOUNT_COL_RE = /(金额|费用|收益|成本|利息|余额|收入|支出|价款|保费)/;

/** 判定列是否金额类（列名或业务描述命中关键词） */
export function isAmountColumn(col?: { name: string; description?: string } | null): boolean {
  if (!col) return false;
  return AMOUNT_COL_RE.test(col.name) || AMOUNT_COL_RE.test(col.description || '');
}

/**
 * 指标聚合表达式（含金额单位换算）：金额列在选定非「元」单位时按除数换算并保留两位小数，
 * 与 SELECT 输出同口径，HAVING 阈值也按所选单位理解；COUNT 类聚合与「元」原值口径不换算。
 */
export function measureExpression(
  m: { column: string; agg: FlexAgg },
  quotedCol: string,
  colSchema?: { name: string; description?: string },
  amountUnit?: FlexAmountUnit,
): string {
  const base = aggExpression(m.agg, quotedCol);
  const convertible = m.agg !== 'COUNT' && m.agg !== 'COUNT_DISTINCT';
  if (amountUnit && amountUnit.divisor > 1 && convertible && isAmountColumn(colSchema)) {
    return `ROUND(${base}/${amountUnit.divisor}, 2)`;
  }
  return base;
}

/** 指标列别名：agg_列名（小写，去重计数缩写 countd；非标识符字符归一为 _），避免中文别名在不同方言下的兼容问题 */
export function measureAlias(m: { column: string; agg: FlexAgg }): string {
  const prefix = m.agg === 'COUNT_DISTINCT' ? 'countd' : m.agg.toLowerCase();
  return `${prefix}_${m.column.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
}

/**
 * v0.9.75：维度结果列名——table.column 取末段列名（与驱动返回列名一致）。
 * 修复跨表维度（dim_region.region_name 返回列名为 region_name）在图表 xAxisKey/透视维度键上的不匹配。
 */
export function dimResultAlias(fullName: string): string {
  const idx = fullName.lastIndexOf('.');
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}

/**
 * v0.9.75：时间粒度分组表达式——把日期列格式化为字符串（两位周序/季度编码，字典序即时间序）。
 * MySQL 用 DATE_FORMAT / CONCAT(YEAR,QUARTER)；PG 系（postgresql/greenplum）统一 TO_CHAR(col::date)。
 */
export function timeGrainExpression(unit: FlexTimeUnit, quotedCol: string, dialect: 'mysql' | 'pg'): string {
  if (dialect === 'mysql') {
    const mysqlFmts: Record<FlexTimeUnit, string> = {
      year: `DATE_FORMAT(${quotedCol}, '%Y')`,
      quarter: `CONCAT(YEAR(${quotedCol}), '-Q', QUARTER(${quotedCol}))`,
      month: `DATE_FORMAT(${quotedCol}, '%Y-%m')`,
      week: `DATE_FORMAT(${quotedCol}, '%x-W%v')`,
      day: `DATE_FORMAT(${quotedCol}, '%Y-%m-%d')`,
    };
    return mysqlFmts[unit];
  }
  const pgFmts: Record<FlexTimeUnit, string> = {
    year: `TO_CHAR(${quotedCol}::date, 'YYYY')`,
    quarter: `CONCAT(TO_CHAR(${quotedCol}::date, 'YYYY'), '-Q', TO_CHAR(${quotedCol}::date, 'Q'))`,
    month: `TO_CHAR(${quotedCol}::date, 'YYYY-MM')`,
    week: `TO_CHAR(${quotedCol}::date, 'IYYY-"W"IW')`,
    day: `TO_CHAR(${quotedCol}::date, 'YYYY-MM-DD')`,
  };
  return pgFmts[unit];
}

/** 单引号加倍转义（SQL 字符串字面量标准转义） */
function escapeSqlString(v: string): string {
  return v.replace(/'/g, "''");
}

/** 逗号（中英文）分割并逐项转义为字面量；数值不加引号 */
function splitAndQuote(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^-?\d+(\.\d+)?$/.test(s) ? s : `'${escapeSqlString(s)}'`));
}

/** BETWEEN 区间拆分为两个端点字面量；非两端返回 null */
export function betweenParts(raw: string): [string, string] | null {
  const parts = splitAndQuote(raw);
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/** 筛选值 → SQL 字面量；IN 逐项转义；BETWEEN 返回 "a AND b"；LIKE 按匹配模式拼通配符；其余数值不加引号、字符串转义包裹 */
export function filterValueToSql(op: FlexFilterOp, raw: string, likeMode: FlexLikeMode = 'contains'): string {
  const v = raw.trim();
  if (op === 'IN') {
    const items = splitAndQuote(v);
    return items.length ? `(${items.join(', ')})` : "('')";
  }
  if (op === 'BETWEEN') {
    const parts = betweenParts(v);
    return parts ? `${parts[0]} AND ${parts[1]}` : "'' AND ''";
  }
  if (op === 'LIKE') {
    const esc = escapeSqlString(v);
    const pattern =
      likeMode === 'startsWith' ? `${esc}%` : likeMode === 'endsWith' ? `%${esc}` : likeMode === 'exact' ? esc : `%${esc}%`;
    return `'${pattern}'`;
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${escapeSqlString(v)}'`;
}

export type FlexBuildResult = { ok: true; sql: string } | { ok: false; error: string };

/**
 * 按配置构建单表/多表聚合 SQL。dialect 决定标识符引号（mysql 反引号 / pg 双引号）。
 * 所有表名与列名必须在 table 与 allTables 的 schema 列集合内（客户端白名单第一道防线）。
 * v0.4.14：支持多表 JOIN（config.joins），字段引用支持 table.column 跨表格式。
 * v0.9.75：多列排序（orderBys）、维度时间粒度（dimTimeUnits）与 LIKE 匹配模式。
 */
export function buildFlexQuerySql(
  config: FlexQueryConfig,
  table: TableSchema | undefined,
  dialect: 'mysql' | 'pg',
  allTables?: TableSchema[],
  amountUnit?: FlexAmountUnit,
): FlexBuildResult {
  if (!table) return { ok: false, error: '请先选择数据表' };
  if (config.table !== table.name) return { ok: false, error: '所选数据表与当前 Schema 不一致' };

  // 构建表名 → Schema 映射（主表 + 关联表）
  const tableMap = new Map<string, TableSchema>();
  tableMap.set(table.name, table);
  if (allTables) {
    for (const t of allTables) tableMap.set(t.name, t);
  }

  const q = dialect === 'pg' ? '"' : '`';
  // 字段引用：支持 "column"（默认主表）或 "table.column"（跨表）
  const ident = (name: string): string | null => {
    if (!name) return null;
    if (name.includes('.')) {
      const [tName, cName] = name.split('.', 2);
      if (!IDENT_RE.test(tName) || !IDENT_RE.test(cName)) return null;
      const t = tableMap.get(tName);
      if (!t || !t.columns.some((c) => c.name === cName)) return null;
      return `${q}${tName}${q}.${q}${cName}${q}`;
    }
    if (!IDENT_RE.test(name)) return null;
    if (!table.columns.some((c) => c.name === name)) return null;
    return `${q}${name}${q}`;
  };

  // 列 schema 查找（读取业务描述以判定金额列）：支持 table.column 跨表引用
  const findColSchema = (name: string): { name: string; description?: string } | undefined => {
    if (name.includes('.')) {
      const [tName, cName] = name.split('.', 2);
      return tableMap.get(tName)?.columns.find((c) => c.name === cName);
    }
    return table.columns.find((c) => c.name === name);
  };

  if (config.dimensions.length === 0 && config.measures.length === 0) {
    return { ok: false, error: '请至少拖入一个维度或一个指标' };
  }

  const selectParts: string[] = [];
  const groupParts: string[] = [];
  // v0.9.75：维度结果列名（末段列名）冲突守卫 + ORDER BY 引用表 + 时间粒度分组
  const dimAliases = new Set<string>();
  const dimOrderRef = new Map<string, string>();
  const dimAliasOrderRef = new Map<string, string>();
  for (const d of config.dimensions) {
    const col = ident(d);
    if (!col) return { ok: false, error: `维度列「${d}」不存在于该表，请重新拖入` };
    const alias = dimResultAlias(d);
    if (dimAliases.has(alias)) return { ok: false, error: `维度「${d}」与其他维度结果列名「${alias}」冲突，请移除其中一个` };
    dimAliases.add(alias);
    const unit = config.dimTimeUnits?.[d];
    if (unit !== undefined && !FLEX_TIME_UNITS.includes(unit)) return { ok: false, error: `不支持的时间粒度「${unit}」` };
    if (unit) {
      const expr = timeGrainExpression(unit, col, dialect);
      selectParts.push(`${expr} AS ${q}${alias}${q}`);
      groupParts.push(expr);
      dimOrderRef.set(d, expr);
      dimAliasOrderRef.set(alias, expr);
    } else {
      selectParts.push(col);
      groupParts.push(col);
      dimOrderRef.set(d, col);
      dimAliasOrderRef.set(alias, col);
    }
  }

  const aliasToQuoted = new Map<string, string>();
  for (const m of config.measures) {
    if (!FLEX_AGGS.includes(m.agg)) return { ok: false, error: `不支持的聚合方式「${m.agg}」` };
    const col = ident(m.column);
    if (!col) return { ok: false, error: `指标列「${m.column}」不存在于该表，请重新拖入` };
    const alias = measureAlias(m);
    if (!IDENT_RE.test(alias)) return { ok: false, error: `指标列「${m.column}」的别名非法` };
    selectParts.push(`${measureExpression(m, col, findColSchema(m.column), amountUnit)} AS ${q}${alias}${q}`);
    aliasToQuoted.set(alias, `${q}${alias}${q}`);
  }

  const whereParts: string[] = [];
  for (const f of config.filters) {
    const col = ident(f.column);
    if (!col) return { ok: false, error: `筛选列「${f.column}」不存在于该表` };
    if (!FLEX_FILTER_OPS.includes(f.op)) return { ok: false, error: `不支持的筛选条件「${f.op}」` };
    if (FLEX_NO_VALUE_OPS.includes(f.op)) {
      whereParts.push(`${col} ${f.op}`);
      continue;
    }
    if (!f.value.trim()) return { ok: false, error: `筛选列「${f.column}」的值不能为空` };
    if (f.op === 'IN') {
      whereParts.push(`${col} IN ${filterValueToSql('IN', f.value)}`);
    } else if (f.op === 'BETWEEN') {
      const parts = betweenParts(f.value);
      if (!parts) return { ok: false, error: `筛选列「${f.column}」的区间需填两个端点（如 100, 500）` };
      whereParts.push(`${col} BETWEEN ${parts[0]} AND ${parts[1]}`);
    } else if (f.op === 'LIKE') {
      if (f.likeMode && !FLEX_LIKE_MODES.includes(f.likeMode)) return { ok: false, error: `不支持的匹配模式「${f.likeMode}」` };
      whereParts.push(`${col} LIKE ${filterValueToSql('LIKE', f.value, f.likeMode)}`);
    } else {
      whereParts.push(`${col} ${f.op} ${filterValueToSql(f.op, f.value)}`);
    }
  }

  // HAVING：聚合表达式过滤（全方言安全写法：重复聚合表达式而非引用别名）
  const havingParts: string[] = [];
  for (const h of config.havings) {
    if (!FLEX_AGGS.includes(h.agg)) return { ok: false, error: `不支持的聚合方式「${h.agg}」` };
    const col = ident(h.column);
    if (!col) return { ok: false, error: `指标过滤列「${h.column}」不存在于该表` };
    if (!FLEX_HAVING_OPS.includes(h.op)) return { ok: false, error: `不支持的指标过滤条件「${h.op}」` };
    if (!h.value.trim()) return { ok: false, error: `指标过滤「${h.column}」的值不能为空` };
    havingParts.push(`${measureExpression(h, col, findColSchema(h.column), amountUnit)} ${h.op} ${filterValueToSql(h.op, h.value)}`);
  }

  // ORDER BY（v0.9.75 多列）：每列 by 必须是已生成的指标别名或维度列（支持末段结果列名引用）
  const orderSegments: string[] = [];
  for (const o of config.orderBys || []) {
    if (!o.by) continue;
    const dirSql = o.dir === 'asc' ? 'ASC' : 'DESC';
    const ref = aliasToQuoted.get(o.by) ?? dimOrderRef.get(o.by) ?? dimAliasOrderRef.get(o.by);
    if (!ref) return { ok: false, error: `排序目标「${o.by}」不在当前维度/指标中` };
    orderSegments.push(`${ref} ${dirSql}`);
  }

  const limit = Math.min(Math.max(Math.floor(config.limit) || 10000, 1), 100000);

  // v0.4.14：多表 JOIN 子句生成（校验关联表与字段合法性）
  const joinParts: string[] = [];
  if (config.joins && config.joins.length > 0) {
    for (const j of config.joins) {
      if (!j.table || !IDENT_RE.test(j.table)) return { ok: false, error: `关联表名「${j.table}」非法` };
      const joinTable = tableMap.get(j.table);
      if (!joinTable) return { ok: false, error: `关联表「${j.table}」不存在于数据源` };
      if (!j.on || !j.on.left || !j.on.right) return { ok: false, error: `关联表「${j.table}」缺少 JOIN 条件` };
      const leftCol = ident(j.on.left);
      if (!leftCol) return { ok: false, error: `JOIN 条件左字段「${j.on.left}」不存在` };
      // right 字段强制带关联表前缀（避免歧义）
      const rightRef = j.on.right.includes('.') ? j.on.right : `${j.table}.${j.on.right}`;
      const rightCol = ident(rightRef);
      if (!rightCol) return { ok: false, error: `JOIN 条件右字段「${j.on.right}」不存在于关联表「${j.table}」` };
      const joinType = j.type === 'LEFT' ? 'LEFT JOIN' : 'INNER JOIN';
      joinParts.push(`${joinType} ${q}${j.table}${q} ON ${leftCol} = ${rightCol}`);
    }
  }

  const segments: string[] = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${q}${table.name}${q}`,
  ];
  if (joinParts.length) segments.push(joinParts.join(' '));
  if (whereParts.length) segments.push(`WHERE ${whereParts.join(' AND ')}`);
  if (groupParts.length) segments.push(`GROUP BY ${groupParts.join(', ')}`);
  if (havingParts.length) segments.push(`HAVING ${havingParts.join(' AND ')}`);
  if (orderSegments.length) segments.push(`ORDER BY ${orderSegments.join(', ')}`);
  segments.push(`LIMIT ${limit}`);

  return { ok: true, sql: segments.join(' ') };
}
