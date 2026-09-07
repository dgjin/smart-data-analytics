/**
 * 问数范围（DataScope）过滤。
 * scope 结构：{ tables: string[], columns?: { [tableId]: string[] }, rowFilters?: { [tableId]: 谓词 } }
 * - scope 为空或 tables 为空数组 = 不限制（全部表/全部字段）
 * - tables 非空 = 仅这些表纳入问数；columns[tableId] 非空时进一步限制字段
 * - P1-3 rowFilters[tableId]：行级权限谓词（WHERE 片段），执行层 AST 强制注入
 */
import type { SchemaTable } from './schemaTypes';

export interface DataScope {
  tables: string[];
  columns?: Record<string, string[]>;
  /** P1-3 行级权限：tableId → 行过滤谓词（管理员登记，执行层强制注入） */
  rowFilters?: Record<string, string>;
}

/** 校验行过滤谓词：管理员登记但仍防结构性注入（多语句/注释/子查询/INTO） */
export function sanitizeRowFilterPredicate(pred: unknown): string | null {
  if (typeof pred !== 'string') return null;
  const p = pred.trim();
  if (!p || p.length > 300) return null;
  if (/;/.test(p)) return null;
  if (/--|#|\/\*/.test(p)) return null;
  if (/\bselect\b|\binto\b/i.test(p)) return null;
  return p;
}

export function applyDataScope(tables: SchemaTable[], scope: DataScope | null | undefined): SchemaTable[] {
  if (!Array.isArray(tables)) return [];
  if (!scope || !Array.isArray(scope.tables) || scope.tables.length === 0) return tables;

  const allowedTables = new Set(scope.tables);
  const colMap = scope.columns && typeof scope.columns === 'object' ? scope.columns : {};

  return tables
    .filter((t) => !!t.id && allowedTables.has(t.id))
    .map((t) => {
      const tid = t.id || '';
      const allowedCols = Array.isArray(colMap[tid]) && colMap[tid].length > 0 ? new Set(colMap[tid]) : null;
      if (!allowedCols) return t;
      return { ...t, columns: (t.columns || []).filter((c) => allowedCols.has(c.name)) };
    });
}

/** 依据数据源现有 schema 清洗 scope：剔除已不存在的表与字段（同步漂移容错） */
export function sanitizeDataScope(tables: SchemaTable[], scope: unknown): DataScope | null {
  const rawScope = (scope && typeof scope === 'object' ? scope : {}) as {
    tables?: unknown;
    columns?: unknown;
    rowFilters?: unknown;
  };
  if (!Array.isArray(rawScope.tables)) return null;

  const tableIds = new Set(tables.map((t) => t.id));
  const cleanTables = rawScope.tables.filter((id): id is string => typeof id === 'string' && tableIds.has(id));

  const cleanColumns: Record<string, string[]> = {};
  const rawCols = rawScope.columns && typeof rawScope.columns === 'object' ? (rawScope.columns as Record<string, unknown>) : {};
  for (const tid of cleanTables) {
    const cols = rawCols[tid];
    if (!Array.isArray(cols) || cols.length === 0) continue;
    const table = tables.find((t) => t.id === tid);
    const validNames = new Set((table?.columns || []).map((c) => c.name));
    const kept = cols.filter((n): n is string => typeof n === 'string' && validNames.has(n));
    if (kept.length > 0) cleanColumns[tid] = kept;
  }

  // P1-3 行级权限谓词清洗：仅保留真实存在表 + 谓词结构合法（可独立于表/列限制生效）
  const cleanRowFilters: Record<string, string> = {};
  const rawFilters = rawScope.rowFilters && typeof rawScope.rowFilters === 'object' ? (rawScope.rowFilters as Record<string, unknown>) : {};
  for (const [tid, pred] of Object.entries(rawFilters)) {
    if (!tableIds.has(tid)) continue;
    const p = sanitizeRowFilterPredicate(pred);
    if (p) cleanRowFilters[tid] = p;
  }

  if (cleanTables.length === 0 && Object.keys(cleanColumns).length === 0 && Object.keys(cleanRowFilters).length === 0) {
    return null;
  }

  return {
    tables: cleanTables,
    columns: cleanColumns,
    ...(Object.keys(cleanRowFilters).length > 0 ? { rowFilters: cleanRowFilters } : {}),
  };
}

/**
 * P1-3 行级权限映射：tableId 键 → 实际表名键（执行层 AST 注入按 SQL 中的真实表名匹配）。
 * 参数 tables 传 scope 过滤后的 schema，确保只对问数可见表生效。
 */
export function rowFiltersByTableName(tables: SchemaTable[], scope: DataScope | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!scope || !scope.rowFilters || typeof scope.rowFilters !== 'object') return out;
  for (const t of Array.isArray(tables) ? tables : []) {
    const pred = sanitizeRowFilterPredicate(scope.rowFilters[t.id || '']);
    if (pred && typeof t.name === 'string' && t.name) out[t.name] = pred;
  }
  return out;
}
