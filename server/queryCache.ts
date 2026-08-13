/**
 * P1-6 问数结果语义缓存：同一数据源下归一化后相同的问题短期内直接复用结果，
 * 避免重复触发昂贵的 LLM 链路。仅缓存 live 链路成功结果；TTL 到期或进程重启自然失效。
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

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

export function getCachedQuery(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

export function setCachedQuery(key: string, payload: any): void {
  // 简易容量控制：超出上限时淘汰最早写入的条目
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { payload, at: Date.now() });
}

/** 数据源结构变更后可整体清理其缓存（可选调用） */
export function invalidateQueryCache(dataSourceId?: string): void {
  if (!dataSourceId) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${dataSourceId}::`)) cache.delete(k);
  }
}
