/**
 * Schema 动态摘要：从数据源真实表结构中提取维度/指标候选，
 * 注入 LLM prompt，避免分析指标与维度使用与当前数据源无关的固定模版。
 */

interface ColumnLike {
  name: string;
  type?: string;
  description?: string;
  isMetric?: boolean;
  isDimension?: boolean;
  isPrimaryKey?: boolean;
}

interface TableLike {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  columns?: ColumnLike[];
}

const DIMENSION_TYPES = new Set(['string', 'category', 'date', 'boolean']);

function isMetricCol(c: ColumnLike): boolean {
  if (c.isPrimaryKey) return false;
  if (c.isMetric !== undefined) return c.isMetric;
  return c.type === 'number';
}

function isDimensionCol(c: ColumnLike): boolean {
  if (c.isPrimaryKey) return false;
  if (c.isDimension !== undefined) return c.isDimension;
  return DIMENSION_TYPES.has(String(c.type));
}

/** 生成注入 prompt 的每表维度/指标摘要（控制长度，避免 prompt 膨胀） */
export function summarizeSchema(schema: TableLike[] | null | undefined): string {
  if (!Array.isArray(schema) || schema.length === 0) return '';
  const lines = schema.slice(0, 20).map((t) => {
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const dims = cols.filter(isDimensionCol).map((c) => c.name);
    const mets = cols.filter(isMetricCol).map((c) => c.name);
    const label = t.displayName && t.displayName !== t.name ? `${t.name}（${t.displayName}）` : t.name;
    return `- ${label}：维度[${dims.join(', ') || '无'}] 指标[${mets.join(', ') || '无'}]`;
  });
  return lines.join('\n');
}

/** 从 description 的括号枚举中提取候选值，如 "大区 (华东/华南/华北)" → ["华东","华南","华北"] */
export function extractEnumValues(description?: string): string[] {
  if (!description) return [];
  const m = description.match(/[(（]([^)）]+)[)）]/);
  if (!m) return [];
  return m[1]
    .split(/[/、,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** 选择与用户问题最相关的表：query 命中表名/显示名/描述者优先，否则第一张 */
export function pickTableForQuery(query: string, schema: TableLike[]): TableLike | null {
  if (!Array.isArray(schema) || schema.length === 0) return null;
  const q = String(query || '');
  const hit = schema.find((t) => {
    const hay = `${t.name} ${t.displayName || ''} ${t.description || ''}`;
    return [...hay.split(/\s+/)].some((w) => w.length >= 2 && q.includes(w));
  });
  return hit || schema[0];
}

export interface FallbackAxes {
  table: TableLike;
  dimension: ColumnLike | null;
  metrics: ColumnLike[];
}

/** 列名/描述与查询文本的相关度：英文按整词包含，中文按二字组（bigram）命中判断 */
function colRelevantToQuery(query: string, c: ColumnLike): boolean {
  const q = String(query || '');
  if (!q) return false;
  const text = `${c.name} ${(c.description || '').split(/[(（]/)[0] || ''}`;
  // 英文/数字词整词包含
  for (const w of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    if (w.length >= 2 && q.includes(w)) return true;
  }
  // 中文二字组命中（如 "所在城市" → 所在/在城/城市，query 含"城市"即相关）
  const zh = text.replace(/[^一-龥]/g, '');
  for (let i = 0; i < zh.length - 1; i++) {
    if (q.includes(zh.slice(i, i + 2))) return true;
  }
  return false;
}

/**
 * Prompt 用紧凑 Schema 序列化（P1 prompt 瘦身）。
 * 列从 {"name","type","description","isMetric","isDimension"} 对象改为 [列名, 类型, 中文说明?] 紧凑数组；
 * 表级剔除 id/rowCount/businessNote（businessNote 由 extractBusinessNotes 独立注入避免重复，
 * isMetric/isDimension 由 summarizeSchema 的维度/指标摘要覆盖）。实测各数据源注入体积下降 50-70%。
 */
export function serializeSchemaForPrompt(schema: any[] | null | undefined): string {
  if (!Array.isArray(schema)) return '[]';
  return JSON.stringify(schema.map((t) => ({
    name: t?.name,
    ...(t?.displayName && t.displayName !== t.name ? { displayName: t.displayName } : {}),
    ...(t?.description ? { description: t.description } : {}),
    columns: (Array.isArray(t?.columns) ? t.columns : []).map((c: any) =>
      c?.description ? [c.name, c.type ?? '', c.description] : [c.name, c.type ?? '']
    ),
  })));
}

/** 为降级响应选取维度与指标：优先与 query 语义相关的列，其次日期/类别维度与前两个数值指标 */
export function pickFallbackAxes(query: string, schema: TableLike[] | null | undefined): FallbackAxes | null {
  const table = pickTableForQuery(query, Array.isArray(schema) ? schema : []);
  if (!table) return null;
  const cols = Array.isArray(table.columns) ? table.columns : [];
  const dims = cols.filter(isDimensionCol);
  const mets = cols.filter(isMetricCol);
  if (dims.length === 0 || mets.length === 0) return null;
  // 维度：query 命中的维度列 > 日期列 > 类别列 > 第一个
  const dimension =
    dims.find((c) => colRelevantToQuery(query, c)) ||
    dims.find((c) => c.type === 'date') ||
    dims.find((c) => c.type === 'category') ||
    dims[0];
  // 指标：query 命中的指标列排前面
  const sortedMets = [...mets].sort(
    (a, b) => Number(colRelevantToQuery(query, b)) - Number(colRelevantToQuery(query, a))
  );
  return { table, dimension, metrics: sortedMets.slice(0, 2) };
}
