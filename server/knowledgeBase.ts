/**
 * P1-A 知识库 RAG（借鉴 DB-GPT 知识库增强）。
 * 管理员按数据源登记业务知识（指标口径、术语表、计算规则），
 * 问数时检索最相关片段注入阶段一 prompt，弥补 Schema 元数据不足以表达的业务语义。
 * embedding 可用时走余弦相似度；不可用（未装 embedding 模型）时降级为 bigram 关键词检索，
 * 保证功能可用且不阻断问数主链路。
 */
import { getPool } from './db';
import { callEmbedding } from './llmClient';
import { bigramOverlap } from './queryFeedback';

export const CHUNK_SIZE = 400;
export const CHUNK_OVERLAP = 80;
export const TOP_K_CHUNKS = 3;

/** 按段落优先、定长兜底切块，相邻块保留 overlap 以防语义被截断 */
export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const src = String(text || '').trim();
  if (!src) return [];

  // 先按换行切段落，逐段合并到 chunkSize 以内
  const paras = src.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const merged: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + 1 + p.length) > chunkSize) {
      merged.push(buf.trim());
      buf = buf.slice(-overlap) + '\n' + p;
    } else {
      buf = buf ? `${buf}\n${p}` : p;
    }
  }
  if (buf.trim()) merged.push(buf.trim());

  // 超长单块强制按步长切
  const out: string[] = [];
  const step = Math.max(1, chunkSize - overlap);
  for (const c of merged) {
    if (c.length <= chunkSize) {
      out.push(c);
      continue;
    }
    for (let i = 0; i < c.length; i += step) {
      out.push(c.slice(i, i + chunkSize));
    }
  }
  return out.filter((c) => c.trim().length > 0);
}

/** 余弦相似度：向量维度不一致或零向量时返回 0 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

export interface KnowledgeChunk {
  title: string;
  text: string;
  embedding: number[] | null;
}

/**
 * 排序检索：question 与 chunk 均可用向量时走余弦相似度，否则降级 bigram 关键词。
 * 返回得分最高的 topK 个片段（得分 ≤0 的被过滤）。
 */
export function rankChunks(
  question: string,
  chunks: KnowledgeChunk[],
  questionEmbedding: number[] | null,
  topK = TOP_K_CHUNKS
): KnowledgeChunk[] {
  const scored = chunks
    .map((c) => {
      const useVector =
        Array.isArray(questionEmbedding) &&
        Array.isArray(c.embedding) &&
        c.embedding.length === questionEmbedding.length;
      const score = useVector
        ? cosineSimilarity(questionEmbedding as number[], c.embedding as number[])
        : bigramOverlap(question, `${c.title} ${c.text}`);
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.c);
}

/** 将检索到的片段格式化为阶段一 prompt 注入块；无结果返回空串 */
export function formatKnowledgeSnippets(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';
  const lines = chunks.map((c) => `- [${c.title}] ${c.text.replace(/\s+/g, ' ').trim()}`);
  return `相关业务知识（管理员登记，用于理解口径与术语，生成 SQL 时参考，但表与列仍必须来自 Schema）:\n${lines.join('\n')}\n`;
}

// ---------- 持久化 ----------

/** 登记一篇业务知识文档：切块 + 逐块 embedding（失败置空走关键词降级），返回块数。
 * 传入 existingDocId 时复用该 docId（编辑场景，调用方需先删除旧块）。 */
export async function saveKnowledgeDoc(
  dataSourceId: string,
  title: string,
  content: string,
  createdBy: string,
  existingDocId?: string
): Promise<{ docId: string; chunkCount: number }> {
  const docId = existingDocId || `kb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const chunks = chunkText(content);
  if (chunks.length === 0) return { docId, chunkCount: 0 };

  const pool = getPool();
  for (const chunk of chunks) {
    let embedding: number[] | null = null;
    try {
      embedding = await callEmbedding(`${title}\n${chunk}`);
    } catch {
      embedding = null;
    }
    await pool.query(
      'INSERT INTO knowledge_base (doc_id, data_source_id, title, chunk_text, embedding_json, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [docId, dataSourceId.slice(0, 64), title.slice(0, 200), chunk, embedding ? JSON.stringify(embedding) : null, createdBy.slice(0, 50)]
    );
  }
  return { docId, chunkCount: chunks.length };
}

/** 检索与问题最相关的知识片段并格式化为 prompt 块（任何异常降级为空串，不阻断问数） */
export async function retrieveKnowledgeSnippets(
  dataSourceId: string,
  question: string,
  topK = TOP_K_CHUNKS
): Promise<string> {
  try {
    const [rows] = await getPool().query(
      'SELECT title, chunk_text, embedding_json FROM knowledge_base WHERE data_source_id = ?',
      [dataSourceId]
    );
    const chunks: KnowledgeChunk[] = (rows as any[]).map((r) => {
      let embedding: number[] | null = null;
      try {
        embedding = r.embedding_json ? JSON.parse(r.embedding_json) : null;
      } catch {
        embedding = null;
      }
      return { title: String(r.title || ''), text: String(r.chunk_text || ''), embedding: Array.isArray(embedding) ? embedding : null };
    });
    if (chunks.length === 0) return '';

    let questionEmbedding: number[] | null = null;
    try {
      questionEmbedding = await callEmbedding(question);
    } catch {
      questionEmbedding = null;
    }
    return formatKnowledgeSnippets(rankChunks(question, chunks, questionEmbedding, topK));
  } catch {
    return '';
  }
}
