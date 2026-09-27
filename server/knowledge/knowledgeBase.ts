/**
 * P1-A 知识库 RAG（借鉴 DB-GPT 知识库增强）。
 * 管理员按数据源登记业务知识（指标口径、术语表、计算规则），
 * 问数时检索最相关片段注入阶段一 prompt，弥补 Schema 元数据不足以表达的业务语义。
 * embedding 可用时走余弦相似度；不可用（未装 embedding 模型）时降级为 bigram 关键词检索，
 * 保证功能可用且不阻断问数主链路。
 */
import type mysql from 'mysql2/promise';
import { getPool } from '../infra/db';
import { callEmbedding, callEmbeddingBatch } from '../llm/llmClient';
import { bigramOverlap } from '../query/queryFeedback';

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
 * 知识库相关性阈值（向量余弦相似度下限）：低于阈值视为无关不注入。
 * 背景：余弦相似度对非负 embedding 恒正，原 score>0 过滤形同虚设——天气/删数据类无关问题
 * 也强行注入 topK 凑数知识（trace 实证 1100+ 字），稀释本地模型注意力。
 * v0.9.78 默认 0.35→0.5：换 qwen3-embedding:8b 后实测（31 条检索评测集）0.35 会放行域外边界
 * 噪声（「今天天气怎么样」top1 cos 0.3567 也注入 2 块）；0.5 时正例 Hit Rate 25/28→26/28、
 * MRR 0.652→0.673、负例零注入 1/3→2/3；0.55 距正例掉落拐点（0.6 时 rt18 被误杀）仅 0.05 余量故取 0.5。
 * env KNOWLEDGE_MIN_SCORE 可调；仅向量模式生效，bigram 关键词降级模式量纲不同，维持 score>0。
 */
export function knowledgeMinScore(): number {
  const raw = process.env.KNOWLEDGE_MIN_SCORE;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return 0.5;
}

/** v0.9.78 检索融合策略：rrf=向量+词法 RRF 真融合（默认）；legacy=旧版「向量达阈否则词法降级」，供回退与评测对比 */
export function knowledgeRankStrategy(): 'rrf' | 'legacy' {
  const raw = String(process.env.KNOWLEDGE_RANK_STRATEGY || '').trim().toLowerCase();
  return raw === 'legacy' ? 'legacy' : 'rrf';
}

/** RRF（Reciprocal Rank Fusion）融合常数：k=60 为行业经验值（平抑头部名次差）；
 * 词法权重略低于向量（bigram 无 IDF 加权，信号强度弱于 BM25），防止词法噪声反超语义正答 */
export const RRF_K = 60;
export const RRF_VECTOR_WEIGHT = 1;
export const RRF_LEXICAL_WEIGHT = 0.8;

/** 词法通道额外准入（仅向量分未达阈值的块）：问题 bigram 覆盖率 + 绝对重合数双条件。
 * 精确术语命中（指标名/枚举值等）可救回向量漏召块（如「订单号 A12345」类精确匹配）；
 * 单字噪声（常用字偶然重合）不构成放行 */
export const LEXICAL_RECALL_MIN_HITS = 2;
export const LEXICAL_RECALL_MIN_NORM = 0.35;

/** 问题 bigram 覆盖率（问题侧归一化；长问题天然偏低，仅用于准入与保留槽加权） */
function bigramNorm(question: string, text: string): number {
  return bigramOverlap(question, text) / Math.max(1, question.length - 1);
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
 * 排序检索（v0.9.78 起默认 RRF 混合融合，KNOWLEDGE_RANK_STRATEGY=legacy 可回退旧版）：
 * - 向量通道：向量分 ≥ knowledgeMinScore() 的块按分排名；词法通道：bigram 重合 >0 的块按重合数排名；
 *   RRF 融合两名次（k=60，向量权重 1 / 词法权重 0.8）——替代旧版「向量达阈 otherwise 词法降级」的二选一；
 * - 向量分未达阈但词法强命中（覆盖率与绝对重合双达标）的块经词法通道救回，修复精确术语向量漏召；
 * - 问题向量不可用时退化为纯词法（score>0，行为与旧版一致）；
 * 结果仍按原规则收敛：同一文档最多入选 maxPerDoc 块防止长字典占满槽位；
 * reserveGuided 为 true 时，为标题命中 GUIDED_DOC_KEYWORDS 的最高分块保留一个槽位
 * （保留槽选块用「向量分 + 权重×词法覆盖率」混合打分，防止分块边界把正答块排在同文档其他块之后）。
 */
export function rankChunks(
  question: string,
  chunks: KnowledgeChunk[],
  questionEmbedding: number[] | null,
  topK = TOP_K_CHUNKS,
  maxPerDoc = MAX_CHUNKS_PER_DOC,
  reserveGuided = true
): KnowledgeChunk[] {
  if (knowledgeRankStrategy() === 'legacy') {
    return rankChunksLegacy(question, chunks, questionEmbedding, topK, maxPerDoc, reserveGuided);
  }
  const minScore = knowledgeMinScore();
  const hasVec = Array.isArray(questionEmbedding) && questionEmbedding.length > 0;
  const scored = chunks.map((c) => {
    const text = `${c.title} ${c.text}`;
    const useVector = hasVec && Array.isArray(c.embedding) && c.embedding.length === (questionEmbedding as number[]).length;
    const vecScore = useVector ? cosineSimilarity(questionEmbedding as number[], c.embedding as number[]) : 0;
    const lexScore = bigramOverlap(question, text);
    return { c, useVector, vecScore, lexScore, lexNorm: bigramNorm(question, text) };
  });
  // 准入：向量达阈 或 词法强命中（双条件）——词法可救回向量漏召的精确匹配块；问题向量不可用时纯词法 score>0
  const admitted = scored.filter((s) =>
    hasVec
      ? (s.useVector && s.vecScore >= minScore) ||
        (s.lexScore >= LEXICAL_RECALL_MIN_HITS && s.lexNorm >= LEXICAL_RECALL_MIN_NORM)
      : s.lexScore > 0
  );
  // 双通道名次（RRF 只看名次不看分值，天然免疫两通道分数量纲差异）
  const vecRank = new Map<KnowledgeChunk, number>();
  const lexRank = new Map<KnowledgeChunk, number>();
  if (hasVec) {
    [...admitted]
      .filter((s) => s.useVector && s.vecScore >= minScore)
      .sort((a, b) => b.vecScore - a.vecScore)
      .forEach((s, i) => vecRank.set(s.c, i + 1));
  }
  [...admitted]
    .filter((s) => s.lexScore > 0)
    .sort((a, b) => b.lexScore - a.lexScore)
    .forEach((s, i) => lexRank.set(s.c, i + 1));
  const rrfOf = (c: KnowledgeChunk) => {
    const rv = vecRank.get(c) || 0;
    const rl = lexRank.get(c) || 0;
    return (rv > 0 ? RRF_VECTOR_WEIGHT / (RRF_K + rv) : 0) + (rl > 0 ? RRF_LEXICAL_WEIGHT / (RRF_K + rl) : 0);
  };
  const fused = admitted
    .map((s) => ({ ...s, score: rrfOf(s.c) }))
    .sort((a, b) => b.score - a.score || b.vecScore - a.vecScore || b.lexScore - a.lexScore);
  const out: KnowledgeChunk[] = [];
  const picked = new Set<KnowledgeChunk>();
  const perDoc = new Map<string, number>();
  const push = (c: KnowledgeChunk) => {
    out.push(c);
    picked.add(c);
    perDoc.set(c.title, (perDoc.get(c.title) || 0) + 1);
  };
  // 口径/指南类文档保留一个槽位：取「向量分 + 权重×词法覆盖率」混合最高的块先行入选，
  // 防止同一文档内分块边界导致正答块被其他块压过（RRF 分值量纲小，不能直接叠加词法分）
  if (reserveGuided && topK > 0) {
    const guidedList = fused.filter((s) => GUIDED_DOC_KEYWORDS.some((k) => s.c.title.includes(k)));
    if (guidedList.length > 0) {
      const hybrid = (s: { vecScore: number; lexNorm: number }) => s.vecScore + GUIDED_BIGRAM_WEIGHT * s.lexNorm;
      const best = guidedList.reduce((a, b) => (hybrid(b) > hybrid(a) ? b : a));
      push(best.c);
    }
  }
  for (const s of fused) {
    if (out.length >= topK) break;
    if (picked.has(s.c)) continue;
    const n = perDoc.get(s.c.title) || 0;
    if (n >= maxPerDoc) continue;
    push(s.c);
  }
  return out;
}

/** 旧版排序（v0.9.78 前默认）：向量达阈排序，否则整体降级 bigram；保留供回退与评测对比 */
function rankChunksLegacy(
  question: string,
  chunks: KnowledgeChunk[],
  questionEmbedding: number[] | null,
  topK: number,
  maxPerDoc: number,
  reserveGuided: boolean
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

/** 知识块检索行：embedding_json 为 JSON 字符串或 NULL */
interface KbChunkSelectRow extends mysql.RowDataPacket {
  title: string;
  chunk_text: string;
  embedding_json: string | null;
}

/** 检索结构化命中块（评测/调试/格式化共用；任何异常降级为空数组，不阻断问数） */
export async function retrieveKnowledgeChunks(
  dataSourceId: string,
  question: string,
  topK = TOP_K_CHUNKS
): Promise<KnowledgeChunk[]> {
  try {
    const [rows] = await getPool().query<KbChunkSelectRow[]>(
      'SELECT title, chunk_text, embedding_json FROM knowledge_base WHERE data_source_id = ?',
      [dataSourceId]
    );
    const chunks: KnowledgeChunk[] = rows.map((r) => {
      let embedding: number[] | null;
      try {
        embedding = r.embedding_json ? JSON.parse(r.embedding_json) : null;
      } catch {
        embedding = null;
      }
      return { title: String(r.title || ''), text: String(r.chunk_text || ''), embedding: Array.isArray(embedding) ? embedding : null };
    });
    if (chunks.length === 0) return [];

    let questionEmbedding: number[] | null = null;
    try {
      questionEmbedding = await callEmbedding(question, 'query');
    } catch {
      questionEmbedding = null;
    }
    return rankChunks(question, chunks, questionEmbedding, topK);
  } catch {
    return [];
  }
}

/** 检索与问题最相关的知识片段并格式化为 prompt 块（任何异常降级为空串，不阻断问数） */
export async function retrieveKnowledgeSnippets(
  dataSourceId: string,
  question: string,
  topK = TOP_K_CHUNKS
): Promise<string> {
  return formatKnowledgeSnippets(await retrieveKnowledgeChunks(dataSourceId, question, topK));
}
