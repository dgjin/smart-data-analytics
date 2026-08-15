/**
 * P1-6 问数结果语义缓存：同一数据源下归一化后相同的问题短期内直接复用结果，
 * 避免重复触发昂贵的 LLM 链路。仅缓存 live 链路成功结果。
 * P0-2：默认内存 Map（进程重启自然失效）；配置 REDIS_URL 后外置 Redis，多实例共享。
 */
import { getStateStore, isRedisEnabled } from './stateStore';

const CACHE_TTL_MS = 10 * 60 * 1000;
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

export async function setCachedQuery(key: string, payload: any): Promise<void> {
  if (isRedisEnabled()) {
    try {
      const raw = JSON.stringify(payload);
      if (raw.length <= REDIS_MAX_PAYLOAD_BYTES) {
        await getStateStore().setEx(`qc:${key}`, raw, Math.ceil(CACHE_TTL_MS / 1000));
      }
    } catch {
      // 写缓存失败静默忽略（fail-open）
    }
    return;
  }
  // 简易容量控制：超出上限时淘汰最早写入的条目
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { payload, at: Date.now() });
}

/** 数据源结构变更后清理其缓存（Redis 模式按前缀 SCAN 删除） */
export async function invalidateQueryCache(dataSourceId?: string): Promise<void> {
  if (isRedisEnabled()) {
    try {
      await getStateStore().deleteByPrefix(dataSourceId ? `qc:${dataSourceId}::` : 'qc:');
    } catch {
      // 失效操作失败不阻断主流程
    }
    return;
  }
  if (!dataSourceId) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${dataSourceId}::`)) cache.delete(k);
  }
}
