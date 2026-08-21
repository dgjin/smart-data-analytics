/**
 * Schema Linking（借鉴 Chat2DB「AI 数据集」3.0 的自动元数据解析）：
 * 表数量较多时，按用户问题与表名/表描述/列描述的相关性自动圈定最相关的表注入 prompt，
 * 避免全量 schema 撑爆上下文并稀释 LLM 注意力；表少时全量注入，无召回损失。
 * P2-9 升级（Vanna 列级 embedding 检索思路）：关键词粗排 + embedding 语义精排，
 * embedding 不可用时静默降级纯关键词打分。
 * 注意：仅影响阶段一 prompt 的 schema 范围，安全白名单（executeSafeSql）始终使用全量 schema，
 * 召回遗漏不会导致合法 SQL 被误杀。
 */
import { bigramOverlap } from './queryFeedback';
import { callEmbedding } from './llmClient';

/** prompt 中注入的最大表数（超过该数量的 schema 才触发圈定） */
export const MAX_TABLES_IN_PROMPT = 8;

/** 单表相关性打分：表名/中文名整词命中权重最高，业务口径与列描述次之 */
function tableScore(table: any, question: string): number {
  let score = 0;
  const name = String(table?.name || '');
  const display = String(table?.displayName || '');
  const desc = String(table?.description || '');
  const note = String(table?.businessNote || '');

  if (name && question.toLowerCase().includes(name.toLowerCase())) score += 10;
  if (display && question.includes(display)) score += 10;
  score += bigramOverlap(question, `${display} ${desc} ${note}`) * 2;

  const cols = Array.isArray(table?.columns) ? table.columns : [];
  for (const c of cols.slice(0, 50)) {
    const colDesc = String(c?.description || '');
    if (!colDesc) continue;
    // 列中文名整词出现在问题中（如「客户类型」），强相关
    if (colDesc.length >= 2 && question.includes(colDesc)) score += 3;
    else score += bigramOverlap(question, colDesc) * 0.5;
  }
  return score;
}

/**
 * 圈定与问题最相关的表（保持原 schema 中的相对顺序返回，保证 prompt 稳定）。
 * 所有表得分为 0 时退化为前 maxTables 张（原顺序），行为可预期。
 */
export function selectRelevantTables(
  schema: any[],
  question: string,
  maxTables: number = MAX_TABLES_IN_PROMPT
): any[] {
  const tables = Array.isArray(schema) ? schema.filter(Boolean) : [];
  if (tables.length <= maxTables) return tables;

  const q = String(question || '');
  const scored = tables.map((t, idx) => ({ t, idx, score: tableScore(t, q) }));
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = new Set(scored.slice(0, maxTables).map((s) => s.idx));
  return tables.filter((_, idx) => picked.has(idx));
}

// ---------- P2-9 embedding 语义精排 ----------

/** 表摘要文本：表名/中文名/描述/口径 + 前 20 列的名称与描述，作为 embedding 输入 */
function tableDigest(table: any): string {
  const cols = Array.isArray(table?.columns) ? table.columns : [];
  const colText = cols
    .slice(0, 20)
    .map((c: any) => `${String(c?.name || '')} ${String(c?.description || '')}`)
    .join(' ');
  return [
    String(table?.name || ''),
    String(table?.displayName || ''),
    String(table?.description || ''),
    String(table?.businessNote || ''),
    colText,
  ]
    .filter(Boolean)
    .join(' ');
}

/** 简易余弦相似度；维度不一致返回 0 */
function cosineSim(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 表摘要 embedding 缓存（进程内）：schema 不变时同表不重复调用 embedding
const tableEmbeddingCache = new Map<string, number[]>();
const TABLE_EMBEDDING_CACHE_MAX = 400;

async function embedTable(table: any): Promise<number[] | null> {
  const digest = tableDigest(table);
  if (!digest.trim()) return null;
  const key = `${String(table?.name || '')}::${digest.slice(0, 200)}`;
  const hit = tableEmbeddingCache.get(key);
  if (hit) return hit;
  try {
    const vec = await callEmbedding(digest, 'document');
    if (Array.isArray(vec) && vec.length > 0) {
      if (tableEmbeddingCache.size >= TABLE_EMBEDDING_CACHE_MAX) {
        const oldest = tableEmbeddingCache.keys().next().value;
        if (oldest !== undefined) tableEmbeddingCache.delete(oldest);
      }
      tableEmbeddingCache.set(key, vec);
      return vec;
    }
  } catch {
    // embedding 不可用，降级纯关键词打分
  }
  return null;
}

/**
 * 增强版圈表：关键词粗排候选 + embedding 语义精排（语义权重 × 12）。
 * 表多时先粗排到 2×maxTables 再精排，控制 embedding 调用次数；
 * embedding 全部不可用时等价于纯关键词版（行为不退化）。
 */
export async function selectRelevantTablesAsync(
  schema: any[],
  question: string,
  maxTables: number = MAX_TABLES_IN_PROMPT
): Promise<any[]> {
  const tables = Array.isArray(schema) ? schema.filter(Boolean) : [];
  if (tables.length <= maxTables) return tables;

  const q = String(question || '');
  const preScored = tables.map((t, idx) => ({ t, idx, kw: tableScore(t, q) }));
  // 粗排候选：表特别多时取 2×maxTables，其余全量参与精排
  const candidateCount = tables.length > maxTables * 2 ? maxTables * 2 : tables.length;
  const candidates = [...preScored].sort((a, b) => b.kw - a.kw || a.idx - b.idx).slice(0, candidateCount);

  let qVec: number[] | null = null;
  try {
    qVec = await callEmbedding(q, 'query');
    if (!Array.isArray(qVec) || qVec.length === 0) qVec = null;
  } catch {
    qVec = null;
  }
  if (!qVec) return pickByKeyword(tables, candidates, maxTables);

  const finalScored = await Promise.all(
    candidates.map(async (c) => {
      const tVec = await embedTable(c.t);
      const sim = tVec ? Math.max(0, cosineSim(qVec as number[], tVec)) : 0;
      return { ...c, score: c.kw + sim * 12 };
    })
  );
  finalScored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = new Set(finalScored.slice(0, maxTables).map((s) => s.idx));
  return tables.filter((_, idx) => picked.has(idx));
}

function pickByKeyword(tables: any[], candidates: { idx: number }[], maxTables: number): any[] {
  const picked = new Set(candidates.slice(0, maxTables).map((s) => s.idx));
  return tables.filter((_, idx) => picked.has(idx));
}

// ---------- P1-5 列级 Schema Linking（宽表 top-N 列注入） ----------

/** 列数超过该阈值的宽表触发列级裁剪（如 204 列财务宽表） */
export const WIDE_TABLE_COLUMN_THRESHOLD = 50;
/** 宽表注入 prompt 的最大列数（top-N 相关列 + 强制保留列） */
export const MAX_COLUMNS_IN_WIDE_TABLE = 30;
/** 列级 embedding 精排的粗排候选倍数（控制 embedding 调用量） */
const COLUMN_COARSE_FACTOR = 2;

/** SQL 聚合/关键字集合：从指标表达式提取列名时排除 */
const SQL_EXPR_KEYWORDS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'distinct', 'case', 'when', 'then', 'else', 'end',
  'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'as', 'cast', 'coalesce',
  'ifnull', 'if', 'date', 'left', 'right', 'substr', 'substring', 'year', 'month', 'day',
  'concat', 'round', 'abs', 'where', 'select', 'from', 'group', 'by', 'order', 'limit',
]);

/** 从指标聚合表达式/固定过滤条件中提取引用的列名标识符 */
export function extractExprColumns(expr: string): string[] {
  const ids = String(expr || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return [...new Set(ids.filter((x) => !SQL_EXPR_KEYWORDS.has(x.toLowerCase())))];
}

/** 指标层引用列按表归组：expr 与 filters 中出现的列都强制保留 */
export function metricColumnsByTable(metrics: Array<{ tableName: string; expr: string; filters?: string }>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of metrics || []) {
    const t = String(m?.tableName || '');
    if (!t) continue;
    const cols = [...extractExprColumns(m.expr), ...extractExprColumns(m.filters || '')];
    out[t] = [...new Set([...(out[t] || []), ...cols])];
  }
  return out;
}

/** 单列相关性打分：列中文名整词命中最强，主键（JOIN 键）与维度/指标标记加权 */
function columnScore(col: any, question: string): number {
  let score = 0;
  const name = String(col?.name || '');
  const desc = String(col?.description || '');
  if (name && question.toLowerCase().includes(name.toLowerCase())) score += 4;
  if (desc.length >= 2 && question.includes(desc)) score += 5;
  else score += bigramOverlap(question, `${name} ${desc}`) * 2;
  if (col?.isPrimaryKey) score += 3;
  if (col?.isDimension || col?.isMetric) score += 1;
  return score;
}

export interface ColumnPruneStat {
  table: string;
  before: number;
  after: number;
}

/**
 * 宽表列裁剪（纯关键词版，可单测）：仅处理 >WIDE_TABLE_COLUMN_THRESHOLD 列的表，
 * 按问题相关性保留 top-N，主键与指标层引用列（forceColumnsByTable）强制保留；
 * 返回保持原顺序的新表数组（不修改入参）。
 */
export function pruneWideTableColumns(
  tables: any[],
  question: string,
  forceColumnsByTable: Record<string, string[]> = {},
  maxColumns: number = MAX_COLUMNS_IN_WIDE_TABLE,
  extraScore?: (table: any, col: any) => number
): { tables: any[]; pruned: ColumnPruneStat[] } {
  const list = Array.isArray(tables) ? tables : [];
  const q = String(question || '');
  const pruned: ColumnPruneStat[] = [];
  const out = list.map((t) => {
    const cols = Array.isArray(t?.columns) ? t.columns : [];
    if (cols.length <= WIDE_TABLE_COLUMN_THRESHOLD) return t;
    const tableName = String(t?.name || '');
    const forced = new Set((forceColumnsByTable[tableName] || []).map((c) => c.toLowerCase()));
    const scored = cols.map((c: any, idx: number) => ({
      c,
      idx,
      keep: columnScore(c, q) + (extraScore ? extraScore(t, c) : 0),
      force: forced.has(String(c?.name || '').toLowerCase()) || c?.isPrimaryKey === true,
    }));
    const topPicked = new Set(
      [...scored].sort((a, b) => b.keep - a.keep || a.idx - b.idx).slice(0, maxColumns).map((s) => s.idx)
    );
    // 强制保留列不受 top-N 限制
    for (const s of scored) if (s.force) topPicked.add(s.idx);
    const keptCols = cols.filter((_: any, idx: number) => topPicked.has(idx));
    pruned.push({ table: tableName, before: cols.length, after: keptCols.length });
    return { ...t, columns: keptCols };
  });
  return { tables: out, pruned };
}

// 列摘要 embedding 缓存（进程内）：schema 不变时同列不重复调用 embedding
const columnEmbeddingCache = new Map<string, number[]>();
const COLUMN_EMBEDDING_CACHE_MAX = 2000;

async function embedColumn(tableName: string, col: any): Promise<number[] | null> {
  const digest = `${String(col?.name || '')} ${String(col?.description || '')}`.trim();
  if (!digest) return null;
  const key = `${tableName}::${digest.slice(0, 120)}`;
  const hit = columnEmbeddingCache.get(key);
  if (hit) return hit;
  try {
    const vec = await callEmbedding(digest, 'document');
    if (Array.isArray(vec) && vec.length > 0) {
      if (columnEmbeddingCache.size >= COLUMN_EMBEDDING_CACHE_MAX) {
        const oldest = columnEmbeddingCache.keys().next().value;
        if (oldest !== undefined) columnEmbeddingCache.delete(oldest);
      }
      columnEmbeddingCache.set(key, vec);
      return vec;
    }
  } catch {
    // embedding 不可用，降级纯关键词打分
  }
  return null;
}

/**
 * 宽表列裁剪（embedding 增强版）：关键词粗排到 2×top-N 候选，embedding 精排后取 top-N。
 * embedding 不可用时等价于纯关键词版（行为不退化）。
 */
export async function pruneWideTableColumnsAsync(
  tables: any[],
  question: string,
  forceColumnsByTable: Record<string, string[]> = {},
  maxColumns: number = MAX_COLUMNS_IN_WIDE_TABLE
): Promise<{ tables: any[]; pruned: ColumnPruneStat[] }> {
  const list = Array.isArray(tables) ? tables : [];
  const wideTables = list.filter((t) => Array.isArray(t?.columns) && t.columns.length > WIDE_TABLE_COLUMN_THRESHOLD);
  if (wideTables.length === 0) return { tables: list, pruned: [] };

  const q = String(question || '');
  let qVec: number[] | null = null;
  try {
    qVec = await callEmbedding(q, 'query');
    if (!Array.isArray(qVec) || qVec.length === 0) qVec = null;
  } catch {
    qVec = null;
  }
  if (!qVec) return pruneWideTableColumns(list, q, forceColumnsByTable, maxColumns);

  const pruned: ColumnPruneStat[] = [];
  const out = await Promise.all(
    list.map(async (t) => {
      const cols = Array.isArray(t?.columns) ? t.columns : [];
      if (cols.length <= WIDE_TABLE_COLUMN_THRESHOLD) return t;
      const tableName = String(t?.name || '');
      const forced = new Set((forceColumnsByTable[tableName] || []).map((c) => c.toLowerCase()));
      // 关键词粗排候选（控制 embedding 调用量），强制保留列直接入桶
      const coarse = cols.map((c: any, idx: number) => ({ c, idx, kw: columnScore(c, q), force: forced.has(String(c?.name || '').toLowerCase()) || c?.isPrimaryKey === true }));
      const candidates = [...coarse].sort((a, b) => b.kw - a.kw || a.idx - b.idx).slice(0, maxColumns * COLUMN_COARSE_FACTOR);
      const refined = await Promise.all(
        candidates.map(async (cd) => {
          const cVec = await embedColumn(tableName, cd.c);
          const sim = cVec ? Math.max(0, cosineSim(qVec as number[], cVec)) : 0;
          return { ...cd, score: cd.kw + sim * 8 };
        })
      );
      const topPicked = new Set(
        [...refined].sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, maxColumns).map((s) => s.idx)
      );
      for (const cd of coarse) if (cd.force) topPicked.add(cd.idx);
      const keptCols = cols.filter((_: any, idx: number) => topPicked.has(idx));
      pruned.push({ table: tableName, before: cols.length, after: keptCols.length });
      return { ...t, columns: keptCols };
    })
  );
  return { tables: out, pruned };
}
