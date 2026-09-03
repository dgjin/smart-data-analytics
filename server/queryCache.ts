/**
 * P1-6 问数结果语义缓存：同一数据源下归一化后相同的问题短期内直接复用结果，
 * 避免重复触发昂贵的 LLM 链路。仅缓存 live 链路成功结果。
 * P0-2：默认内存 Map（进程重启自然失效）；配置 REDIS_URL 后外置 Redis，多实例共享。
 * P1-6 真语义缓存：L1 归一化精确匹配之上叠加 L2 embedding 语义命中（相似度≥0.95），
 * 同义改写问题直接复用最近成功结果；命中返回原问题供前端标注「来自相似问题缓存」并提供刷新入口。
 */
import { getStateStore, isRedisEnabled } from './stateStore';
import { callEmbedding } from './llmClient';

// P0 性能优化：TTL 默认 10 分钟延长至 30 分钟（分析型场景数据时效要求低，缓存收益大）；
// 可用 QUERY_CACHE_TTL_MINUTES 覆盖。失效正确性由数据源变更点调用 invalidateQueryCache 保证（见 routes/datasources.ts）。
const CACHE_TTL_MS = (() => {
  const mins = Number(process.env.QUERY_CACHE_TTL_MINUTES);
  return Number.isFinite(mins) && mins > 0 ? Math.floor(mins) * 60 * 1000 : 30 * 60 * 1000;
})();
const MAX_ENTRIES = 200;
/** Redis 缓存值体积上限（超过不缓存，避免大结果集撑爆内存库） */
const REDIS_MAX_PAYLOAD_BYTES = 200 * 1024;

/** 问题归一化：小写 + 去除空白与常见标点，保证「各客户类型的数量？」与「各客户类型的数量」命中同一缓存 */
export function normalizeQuestion(q: string): string {
  return String(q || '')
    .toLowerCase()
    .replace(/[\s，。！？,.!?;；：:"'"“”‘’、（）()]+/g, '')
    .slice(0, 200);
}

/** variant 用于区分不同模型/引擎下的结果（用户自选模型时传 "engine:model"），避免跨模型串用缓存 */
export function cacheKey(dataSourceId: string, question: string, variant = ''): string {
  const base = `${dataSourceId}::${normalizeQuestion(question)}`;
  return variant ? `${base}::${variant}` : base;
}

interface CacheEntry {
  payload: any;
  at: number;
}

const cache = new Map<string, CacheEntry>();

export async function getCachedQuery(key: string): Promise<any | null> {
  if (isRedisEnabled()) {
    try {
      const raw = await getStateStore().get(`qc:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null; // Redis 异常按未命中处理（缓存 fail-open）
    }
  }
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

export async function setCachedQuery(
  key: string,
  payload: any,
  semantic?: { dataSourceId: string; question: string; variant?: string }
): Promise<void> {
  if (isRedisEnabled()) {
    try {
      const raw = JSON.stringify(payload);
      if (raw.length <= REDIS_MAX_PAYLOAD_BYTES) {
        await getStateStore().setEx(`qc:${key}`, raw, Math.ceil(CACHE_TTL_MS / 1000));
      }
    } catch {
      // 写缓存失败静默忽略（fail-open）
    }
  } else {
    // 简易容量控制：超出上限时淘汰最早写入的条目
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { payload, at: Date.now() });
  }
  // L2 语义索引：写入成功结果的问题 embedding，供同义改写问题命中（失败不阻断主链路）
  if (semantic && typeof semantic.question === 'string') {
    await indexSemanticEntry(semantic.dataSourceId, semantic.variant || '', key, semantic.question);
  }
}

/** 数据源结构变更后清理其缓存（Redis 模式按前缀 SCAN 删除），语义索引一并清理 */
export async function invalidateQueryCache(dataSourceId?: string): Promise<void> {
  if (isRedisEnabled()) {
    try {
      await getStateStore().deleteByPrefix(dataSourceId ? `qc:${dataSourceId}::` : 'qc:');
      await getStateStore().deleteByPrefix(dataSourceId ? `qcidx:${dataSourceId}::` : 'qcidx:');
    } catch {
      // 失效操作失败不阻断主流程
    }
    return;
  }
  if (!dataSourceId) {
    cache.clear();
    semanticIndex.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${dataSourceId}::`)) cache.delete(k);
  }
  for (const k of semanticIndex.keys()) {
    if (k.startsWith(`${dataSourceId}::`)) semanticIndex.delete(k);
  }
}

// ---------- P1-6 L2 语义缓存（embedding 相似度命中） ----------

/**
 * 语义命中阈值：误命中代价高（答非所问），需保守。
 * 默认 0.95（与计划要求 ≥0.95 一致）。nomic-embed-text 中文问数实测标定：跨域无关对 ≤0.68，
 * 但同域近似问题（同表同结构、过滤条件不同，如「各客户类型的拜访次数」vs「重点客户的拜访次数」）
 * 相似度落在 0.85~0.95 区间——0.85 阈值会在该区间误命中并返回错误缓存答案（P1-7 基线评测实测污染），
 * 故取 0.95 宁缺毋滥，代价是部分同义改写不命中（用户可用「重新查询」强制刷新）。
 * 更换 embedding 模型后应重新标定；可用 SEMANTIC_CACHE_THRESHOLD 覆盖。
 */
export function semanticCacheThreshold(): number {
  const raw = Number(process.env.SEMANTIC_CACHE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0.5 && raw <= 1 ? raw : 0.95;
}

/** 每数据源（含模型变体）语义索引条数上限 */
const SEMANTIC_INDEX_MAX = 100;
/** 归一化后低于该长度的问题不参与语义缓存（太短的问题 embedding 相似度无区分度） */
const SEMANTIC_MIN_QUESTION_LEN = 4;

export interface SemanticIndexEntry {
  /** L1 缓存键（命中后再校验 L1 条目仍存在，防索引残留误命中） */
  key: string;
  /** 原始问题（前端标注「来自相似问题缓存」用） */
  question: string;
  /** 归一化问题的 embedding（4 位小数存储，压缩 Redis 体积） */
  vec: number[];
  at: number;
}

/** 内存模式语义索引：idxKey = `${dataSourceId}::${variant}` */
const semanticIndex = new Map<string, SemanticIndexEntry[]>();

function semanticIndexKey(dataSourceId: string, variant: string): string {
  return `${dataSourceId}::${variant}`;
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

/** 问题 embedding（基于归一化文本，标点/大小写差异不产生额外向量）；不可用返回 null */
async function embedQuestion(question: string): Promise<number[] | null> {
  const norm = normalizeQuestion(question);
  if (norm.length < SEMANTIC_MIN_QUESTION_LEN) return null;
  try {
    const vec = await callEmbedding(norm, 'query');
    return Array.isArray(vec) && vec.length > 0 ? vec : null;
  } catch {
    return null; // embedding 不可用：语义缓存整体 fail-open，仅走 L1
  }
}

/** 读取语义索引（自动剔除过期条目）；异常按空索引处理 */
async function readSemanticIndex(idxKey: string): Promise<SemanticIndexEntry[]> {
  const now = Date.now();
  const alive = (list: SemanticIndexEntry[]) =>
    list.filter((e) => e && typeof e.key === 'string' && Array.isArray(e.vec) && now - Number(e.at || 0) <= CACHE_TTL_MS);
  if (isRedisEnabled()) {
    try {
      const raw = await getStateStore().get(`qcidx:${idxKey}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? alive(parsed) : [];
    } catch {
      return [];
    }
  }
  const list = semanticIndex.get(idxKey) || [];
  const kept = alive(list);
  if (kept.length !== list.length) semanticIndex.set(idxKey, kept);
  return kept;
}

/** 写入语义索引（读-改-写：缓存场景可接受竞态，最坏丢失一条索引；同 key 覆盖更新） */
async function indexSemanticEntry(dataSourceId: string, variant: string, key: string, question: string): Promise<void> {
  const vec = await embedQuestion(question);
  if (!vec) return;
  const idxKey = semanticIndexKey(dataSourceId, variant);
  const entry: SemanticIndexEntry = {
    key,
    question: String(question).slice(0, 200),
    vec: vec.map((v) => Math.round(v * 1e4) / 1e4),
    at: Date.now(),
  };
  const list = await readSemanticIndex(idxKey);
  const next = [entry, ...list.filter((e) => e.key !== entry.key)].slice(0, SEMANTIC_INDEX_MAX);
  if (isRedisEnabled()) {
    try {
      await getStateStore().setEx(`qcidx:${idxKey}`, JSON.stringify(next), Math.ceil(CACHE_TTL_MS / 1000));
    } catch {
      // 索引写失败静默忽略（fail-open）
    }
    return;
  }
  semanticIndex.set(idxKey, next);
}

export interface SemanticCacheHit {
  payload: any;
  matchedQuestion: string;
  similarity: number;
}

/**
 * L2 语义缓存查询：问题 embedding 与同数据源（同模型变体）索引内最近邻相似度≥阈值，
 * 且对应 L1 条目仍存在时才命中（索引可能因 TTL 不同步残留，以 L1 为最终事实源）。
 */
export async function getSemanticCachedQuery(
  dataSourceId: string,
  question: string,
  variant = ''
): Promise<SemanticCacheHit | null> {
  const vec = await embedQuestion(question);
  if (!vec) return null;
  const entries = await readSemanticIndex(semanticIndexKey(dataSourceId, variant));
  let best: { e: SemanticIndexEntry; similarity: number } | null = null;
  for (const e of entries) {
    const similarity = cosineSim(vec, e.vec);
    if (!best || similarity > best.similarity) best = { e, similarity };
  }
  if (!best || best.similarity < semanticCacheThreshold()) return null;
  const payload = await getCachedQuery(best.e.key);
  if (!payload) return null; // L1 已过期/已失效：索引残留不命中
  return { payload, matchedQuestion: best.e.question, similarity: best.similarity };
}
