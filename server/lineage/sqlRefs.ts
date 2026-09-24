/**
 * 血缘采集：从 SQL 文本提取真实引用的业务表清单。
 * 复用问数链路的 SQL 清洗与表名提取（server/query/sqlExecutor，与白名单校验同源口径），
 * 额外排除 CTE 名与系统/元数据表，保证血缘边只指向真实业务表。
 *
 * 方言处理：MySQL 双引号是字符串字面量（剥离更安全）；PG 系双引号是标识符（须保留，
 * 否则 `"订单表"` 这类带引号标识符的 FROM 目标会丢失）。调用方按数据源类型传入方言。
 */
import {
  stripCommentsAndStrings,
  extractTableRefs,
  extractCteNames,
  type SqlDialect,
} from '../query/sqlExecutor';

/** 系统/元数据表名（不作为血缘对象，避免误报失效边） */
const SYSTEM_TABLES = new Set([
  'dual',
  'information_schema',
  'performance_schema',
  'sys',
  'mysql',
  'pg_catalog',
  'pg_toast',
  'pg_temp',
]);

/** 由数据源类型推断 SQL 方言（未知类型按 mysql 处理） */
export function dialectOfDsType(dsType: string | undefined): SqlDialect {
  return dsType === 'postgresql' || dsType === 'greenplum' ? 'pg' : 'mysql';
}

/**
 * 从一条 SQL 提取引用表名（小写、去重、排除 CTE 与系统表）。
 * 纯函数，便于单测；解析失败（语法异常）时按正则尽力而为，绝不抛错。
 */
export function tablesOfSql(sql: string, dialect: SqlDialect = 'mysql'): string[] {
  if (!sql || !sql.trim()) return [];
  let stripped: string;
  try {
    stripped = stripCommentsAndStrings(sql, dialect);
  } catch {
    return [];
  }
  const ctes = extractCteNames(stripped);
  const refs = extractTableRefs(stripped).filter(
    (t) => t && !ctes.has(t) && !SYSTEM_TABLES.has(t),
  );
  return [...new Set(refs)];
}
