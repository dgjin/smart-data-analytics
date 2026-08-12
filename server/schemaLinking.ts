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
    const vec = await callEmbedding(digest);
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
    qVec = await callEmbedding(q);
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
