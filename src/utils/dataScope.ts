import { DataScope, TableSchema } from '../types/analytics';

/**
 * 按问数范围过滤表结构（前端用于展示与构造查询请求；服务端在查询端点会再次强制过滤）。
 * scope 为空或 tables 为空数组 = 不限制。
 */
export function applyDataScope(tables: TableSchema[], scope?: DataScope | null): TableSchema[] {
  if (!Array.isArray(tables)) return [];
  if (!scope || !Array.isArray(scope.tables) || scope.tables.length === 0) return tables;

  const allowedTables = new Set(scope.tables);
  const colMap = scope.columns || {};

  return tables
    .filter((t) => allowedTables.has(t.id))
    .map((t) => {
      const allowedCols = colMap[t.id]?.length ? new Set(colMap[t.id]) : null;
      if (!allowedCols) return t;
      return { ...t, columns: t.columns.filter((c) => allowedCols.has(c.name)) };
    });
}
