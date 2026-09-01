/**
 * P1-A 知识库 RAG（借鉴 DB-GPT 知识库增强）。
 * 管理员按数据源登记业务知识（指标口径、术语表、计算规则），
 * 问数时检索最相关片段注入阶段一 prompt，弥补 Schema 元数据不足以表达的业务语义。
 * embedding 可用时走余弦相似度；不可用（未装 embedding 模型）时降级为 bigram 关键词检索，
 * 保证功能可用且不阻断问数主链路。
 */
import { getPool } from './db';
import { callEmbedding, callEmbeddingBatch } from './llmClient';
import { bigramOverlap } from './queryFeedback';

export const CHUNK_SIZE = 400;
export const CHUNK_OVERLAP = 80;
/** v0.4.15：topK 4→6（本地算力前提，上下文预算同步上调，提升口径/枚举类知识命中率） */
export const TOP_K_CHUNKS = 6;
/** 单文档最多入选块数：防止大字典文档占满槽位，保证口径/指南类文档有注入机会 */
export const MAX_CHUNKS_PER_DOC = 2;
/** 标题含这些关键词的属于高价值口径/指南类文档：有命中时至少保留一个注入槽位，
 * 防止字段字典类文档在向量相似度上全面占优、挤掉口径规则；
 * v0.4.15 增补「对比」「模式」，同比/环比等复杂分析口径文档优先召回 */
export const GUIDED_DOC_KEYWORDS = ['口径', '指南', '速查', '规则', '枚举', '对比', '模式'];
/** 保留槽位选块时的词法混合权重：向量分 + 权重×归一 bigram，
 * 避免分块边界把正答块排在同文档其他块之后 */
export const GUIDED_BIGRAM_WEIGHT = 0.15;

/**
 * v0.4.15 知识库相关性阈值（向量余弦相似度下限）：低于阈值视为无关不注入。
 * 背景：余弦相似度对非负 embedding 恒正，原 score>0 过滤形同虚设——天气/删数据类无关问题
 * 也强行注入 topK 凑数知识（trace 实证 1100+ 字），稀释本地模型注意力。
 * 默认 0.35（中文 embedding 相关通常 0.5+、无关多在 0.2-0.4），env KNOWLEDGE_MIN_SCORE 可调；
 * 仅向量模式生效，bigram 关键词降级模式量纲不同，维持 score>0。
 */
export function knowledgeMinScore(): number {
  const raw = process.env.KNOWLEDGE_MIN_SCORE;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return 0.35;
}

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
 * 返回得分最高的 topK 个片段；向量模式过滤低于 knowledgeMinScore() 的无关片段，
 * bigram 降级模式维持过滤得分 ≤0（量纲不同，不套用向量阈值）；
 * 同一文档（title）最多入选 maxPerDoc 块，避免单一长字典文档占满注入槽位；
 * reserveGuided 为 true 时，为标题命中 GUIDED_DOC_KEYWORDS 的最高分块保留一个槽位，
 * 保证口径/指南类知识（如「高频指标口径速查」）在字段字典相似度更高时仍能注入。
 */
export function rankChunks(
  question: string,
  chunks: KnowledgeChunk[],
  questionEmbedding: number[] | null,
  topK = TOP_K_CHUNKS,
  maxPerDoc = MAX_CHUNKS_PER_DOC,
  reserveGuided = true
): KnowledgeChunk[] {
  const minScore = knowledgeMinScore();
  const scored = chunks
    .map((c) => {
      const useVector =
        Array.isArray(questionEmbedding) &&
        Array.isArray(c.embedding) &&
        c.embedding.length === questionEmbedding.length;
      const score = useVector
        ? cosineSimilarity(questionEmbedding as number[], c.embedding as number[])
        : bigramOverlap(question, `${c.title} ${c.text}`);
      return { c, score, useVector };
    })
    // v0.4.15：向量模式按相关性阈值过滤（无关问题不强行注入凑数知识）；bigram 维持 >0
    .filter((s) => (s.useVector ? s.score >= minScore : s.score > 0))
    .sort((a, b) => b.score - a.score);
  const out: KnowledgeChunk[] = [];
  const picked = new Set<KnowledgeChunk>();
  const perDoc = new Map<string, number>();
  const push = (c: KnowledgeChunk) => {
    out.push(c);
    picked.add(c);
    perDoc.set(c.title, (perDoc.get(c.title) || 0) + 1);
  };
  // 口径/指南类文档保留一个槽位：取「向量分 + 词法分」混合最高的块先行入选，
  // 防止同一文档内分块边界导致正答块被其他块压过
  if (reserveGuided && topK > 0) {
    const guidedList = scored.filter((s) => GUIDED_DOC_KEYWORDS.some((k) => s.c.title.includes(k)));
    if (guidedList.length > 0) {
      const qLen = Math.max(1, question.length - 1);
      const hybrid = (s: { c: KnowledgeChunk; score: number }) =>
        s.score + GUIDED_BIGRAM_WEIGHT * (bigramOverlap(question, `${s.c.title} ${s.c.text}`) / qLen);
      const best = guidedList.reduce((a, b) => (hybrid(b) > hybrid(a) ? b : a));
      push(best.c);
    }
  }
  for (const s of scored) {
    if (out.length >= topK) break;
    if (picked.has(s.c)) continue;
    const n = perDoc.get(s.c.title) || 0;
    if (n >= maxPerDoc) continue;
    push(s.c);
  }
  return out;
}

/** 将检索到的片段格式化为阶段一 prompt 注入块；无结果返回空串。
 * v0.4.15：措辞由「参考」升级为「必须遵循」强指令（与 businessNotes 对齐）——弱指令下本地小模型
 * 常忽略知识内容自行编造口径；同时明确知识仅约束口径/术语/枚举，不放开表列白名单。 */
export function formatKnowledgeSnippets(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';
  const lines = chunks.map((c) => `- [${c.title}] ${c.text.replace(/\s+/g, ' ').trim()}`);
  return `业务知识库（管理员登记的权威口径与术语，生成 SQL 时**必须遵循**其中命中本问题的口径、枚举写法与计算规则，禁止自行编造口径；表与列仍必须逐字来自 Schema，知识仅约束业务逻辑）:\n${lines.join('\n')}\n`;
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
  // P2-2 批量化：全部块一次请求多段文本（往返次数由 N 降至 ceil(N/batchSize)）；整体失败降级为全 null（关键词检索保底）
  const embeddings = await callEmbeddingBatch(
    chunks.map((c) => `${title}\n${c}`),
    'document'
  ).catch(() => chunks.map(() => null));
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i] ?? null;
    await pool.query(
      'INSERT INTO knowledge_base (doc_id, data_source_id, title, chunk_text, embedding_json, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [docId, dataSourceId.slice(0, 64), title.slice(0, 200), chunks[i], embedding ? JSON.stringify(embedding) : null, createdBy.slice(0, 50)]
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
      let embedding: number[] | null;
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
      questionEmbedding = await callEmbedding(question, 'query');
    } catch {
      questionEmbedding = null;
    }
    return formatKnowledgeSnippets(rankChunks(question, chunks, questionEmbedding, topK));
  } catch {
    return '';
  }
}
