/**
 * 问数范围（DataScope）过滤。
 * scope 结构：{ tables: string[], columns?: { [tableId]: string[] } }
 * - scope 为空或 tables 为空数组 = 不限制（全部表/全部字段）
 * - tables 非空 = 仅这些表纳入问数；columns[tableId] 非空时进一步限制字段
 */

export interface DataScope {
  tables: string[];
  columns?: Record<string, string[]>;
}

export function applyDataScope(tables: any[], scope: DataScope | null | undefined): any[] {
  if (!Array.isArray(tables)) return [];
  if (!scope || !Array.isArray(scope.tables) || scope.tables.length === 0) return tables;

  const allowedTables = new Set(scope.tables);
  const colMap = scope.columns && typeof scope.columns === 'object' ? scope.columns : {};

  return tables
    .filter((t) => allowedTables.has(t.id))
    .map((t) => {
      const allowedCols = Array.isArray(colMap[t.id]) && colMap[t.id].length > 0 ? new Set(colMap[t.id]) : null;
      if (!allowedCols) return t;
      return { ...t, columns: (t.columns || []).filter((c: any) => allowedCols.has(c.name)) };
    });
}

/** 依据数据源现有 schema 清洗 scope：剔除已不存在的表与字段（同步漂移容错） */
export function sanitizeDataScope(tables: any[], scope: any): DataScope | null {
  if (!scope || !Array.isArray(scope.tables)) return null;
  if (scope.tables.length === 0) return null;

  const tableIds = new Set(tables.map((t) => t.id));
  const cleanTables = scope.tables.filter((id: any) => typeof id === 'string' && tableIds.has(id));

  const cleanColumns: Record<string, string[]> = {};
  const rawCols = scope.columns && typeof scope.columns === 'object' ? scope.columns : {};
  for (const tid of cleanTables) {
    const cols = rawCols[tid];
    if (!Array.isArray(cols) || cols.length === 0) continue;
    const table = tables.find((t) => t.id === tid);
    const validNames = new Set((table?.columns || []).map((c: any) => c.name));
    const kept = cols.filter((n: any) => typeof n === 'string' && validNames.has(n));
    if (kept.length > 0) cleanColumns[tid] = kept;
  }

  return { tables: cleanTables, columns: cleanColumns };
}
