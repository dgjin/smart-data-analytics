/**
 * 记忆召回相似度工具：优先向量余弦，Embedding 不可用时退化为中文 bigram 覆盖率。
 * 与 knowledgeBase 的检索策略保持一致（向量通道 + 词法通道），但这里只做单条打分。
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.min(1, Math.max(0, cos));
}

/** bigram 覆盖率：重合数 / 较短文本的滑窗数，[0,1] */
export function bigramCoverage(a: string, b: string): number {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length < 2 || sb.length < 2) return sa && sa === sb ? 1 : 0;
  const grams = new Set<string>();
  for (let i = 0; i < sa.length - 1; i++) grams.add(sa.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < sb.length - 1; i++) {
    if (grams.has(sb.slice(i, i + 2))) hit++;
  }
  const denom = Math.max(1, Math.min(sa.length, sb.length) - 1);
  return Math.min(1, hit / denom);
}

/**
 * 单条记忆相关性：向量可用时取 max(cos, bigram×0.9)（防向量模型对专有名词不敏感），
 * 否则纯 bigram。
 */
export function memoryRelevance(
  query: string,
  question: string,
  queryEmbedding?: number[] | null,
  itemEmbedding?: number[] | null
): number {
  const lexical = bigramCoverage(query, question);
  if (queryEmbedding && itemEmbedding && queryEmbedding.length === itemEmbedding.length) {
    const cos = cosineSimilarity(queryEmbedding, itemEmbedding);
    return Math.max(cos, lexical * 0.9);
  }
  return lexical;
}

/** 纠错记忆召回阈值（低于阈值不注入） */
export const CORRECTION_MIN_REL = 0.45;
