/**
 * P2-2 报表图表点击下钻：根据图表元数据与点击的维度值生成明细 SQL 并执行。
 * 下钻原则：
 * - 保留原查询 FROM 与 JOIN（通过 AST 提取）
 * - 去掉 GROUP BY / 聚合函数，改为 SELECT *
 * - 增加 WHERE <维度列> = <点击值>（行级权限仍强制注入）
 * - LIMIT 50 防数据爆炸
 */
// node-sql-parser 是 CJS 包，ESM 下需默认导入后解构（与 sqlExecutor.ts 一致）
import sqlParserPkg from 'node-sql-parser';
import { executeSafeSql } from './sqlExecutor';

const { Parser } = sqlParserPkg as any;
const astParser = new Parser();

export interface DrillInput {
  dataSourceId: string;
  /** 原聚合查询 SQL（报表阶段一生成） */
  originalSql: string;
  /** 点击的维度列名（xAxisKey） */
  dimensionKey: string;
  /** 点击的维度值 */
  dimensionValue: string | number;
  /** 数据源 schema（白名单校验） */
  schema: any[];
  sensitiveRemoved: string[];
  rowFilters?: Record<string, string>;
}

export interface DrillResult {
  ok: true;
  rows: Record<string, any>[];
  rowCount: number;
  finalSql: string;
}

export type DrillOutcome = DrillResult | { ok: false; error: string };

export async function runDrill(input: DrillInput): Promise<DrillOutcome> {
  const { originalSql, dimensionKey, dimensionValue, dataSourceId, schema, sensitiveRemoved, rowFilters } = input;

  const drillSql = buildDrillSql(originalSql, dimensionKey, dimensionValue);
  if (!drillSql) {
    return { ok: false, error: '无法从原查询生成下钻 SQL' };
  }

  const outcome = await executeSafeSql(dataSourceId, drillSql, schema, sensitiveRemoved, 50, rowFilters || {});
  if (outcome.ok !== true) {
    return { ok: false, error: outcome.reason };
  }
  return {
    ok: true,
    rows: outcome.result.rows,
    rowCount: outcome.result.rowCount,
    finalSql: outcome.result.finalSql,
  };
}

/**
 * 基于原聚合 SQL 生成明细下钻 SQL：
 * 1. AST 提取 FROM/JOIN 与 WHERE
 * 2. 构造 SELECT * FROM ... WHERE <dim> = <val> LIMIT 50
 * 3. 若 AST 提取失败，回退正则提取表名（简单场景）
 */
export function buildDrillSql(sql: string, dimKey: string, dimValue: string | number): string | null {
  const stripped = sql.replace(/;+\s*$/, '');
  const opt = { database: 'MySQL' };

  // 尝试 AST 提取 FROM + WHERE
  try {
    const parsed: any = astParser.astify(stripped, opt);
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!root || root.type !== 'select') return fallbackBuild(stripped, dimKey, dimValue);

    const from = root.from;
    const where = root.where;

    // 构造新 AST：SELECT * FROM ... [WHERE ... AND dim=val] LIMIT 50
    const newAst: any = {
      type: 'select',
      with: null,
      options: null,
      distinct: null,
      columns: '*',
      from,
      where: combineWhere(where, dimKey, dimValue),
      groupby: null,
      having: null,
      orderby: null,
      limit: { value: [{ type: 'number', value: 50 }] },
    };

    const rewritten = astParser.sqlify(newAst, opt);
    if (typeof rewritten === 'string' && rewritten.trim()) return rewritten;
  } catch {
    // AST 失败走回退
  }

  return fallbackBuild(stripped, dimKey, dimValue);
}

function combineWhere(existing: any, dimKey: string, dimValue: string | number): any {
  const valNode = typeof dimValue === 'number'
    ? { type: 'number', value: dimValue }
    : { type: 'string', value: String(dimValue) };

  const predicate: any = {
    type: 'binary_expr',
    operator: '=',
    left: { type: 'column_ref', table: null, column: dimKey },
    right: valNode,
  };

  if (!existing) return predicate;

  return {
    type: 'binary_expr',
    operator: 'AND',
    left: existing,
    right: predicate,
  };
}

/** 回退：正则提取主表名，构造简单 SELECT * */
function fallbackBuild(sql: string, dimKey: string, dimValue: string | number): string | null {
  const m = sql.match(/\bfrom\s+`?([A-Za-z_]\w*)`?/i);
  if (!m) return null;
  const table = m[1];
  const val = typeof dimValue === 'number' ? String(dimValue) : `'${String(dimValue).replace(/'/g, "\\'")}'`;
  return `SELECT * FROM \`${table}\` WHERE \`${dimKey}\` = ${val} LIMIT 50`;
}
