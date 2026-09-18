/**
 * L5 频率层：智能问数用户级配额（架构图约定：20 次/小时 + 同用户并发限 1）。
 * 与 IP 级 rateLimiter 互补：IP 限流防匿名爆破，本模块按登录用户约束昂贵的 LLM 调用。
 * USER_QUERY_RATE_MAX=0 可取消次数配额（不限次数）；同用户并发互斥仍由 acquireQuerySlot 保障。
 * P0-2：默认进程内存（滑动窗口语义不变）；配置 REDIS_URL 后走 Redis（固定小时窗口
 * INCR + 分布式锁并发槽），多实例共享且进程崩溃后槽位可自动过期释放。
 */
import { getStateStore, isRedisEnabled } from './stateStore';

const WINDOW_MS = 60 * 60 * 1000; // 1 小时滑动窗口
const DEFAULT_MAX_PER_WINDOW = 20;
/**
 * 每用户小时配额：未配置/非法值回退 20；显式 `0` = 取消次数限制（不限次数），
 * 与 SQL_EXPLAIN_MAX_ROWS 的「0=关闭」约定一致。惰性读取（ESM import 提升早于 dotenv.config()）。
 */
const maxPerWindow = () => {
  const raw = (process.env.USER_QUERY_RATE_MAX || '').trim();
  if (raw === '') return DEFAULT_MAX_PER_WINDOW;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_PER_WINDOW;
};
/** Redis 并发槽 TTL：覆盖最长问数链路耗时，崩溃后自动释放避免永久锁死（内存模式同样以此兜底） */
export const SLOT_TTL_SEC = 15 * 60;

const hits = new Map<number, number[]>(); // userId -> 窗口内时间戳
/** 进行中的查询（并发互斥）：token 绑定请求，exp 为兜底过期时间（对齐 Redis 模式 TTL 语义） */
const inflight = new Map<number, { token: string; exp: number }>();

export interface RateCheck {
  ok: boolean;
  reason?: string;
}

/** 频率检查：窗口内已满则拒绝，通过则立即计数。Redis 模式为固定小时窗口（拒绝也计数，语义略保守）。 */
export async function checkUserQueryLimit(userId: number, now: number = Date.now()): Promise<RateCheck> {
  const max = maxPerWindow();
  // 0 = 取消次数配额：直接放行且不计数（不写 Redis / 不落内存），并发互斥另由 acquireQuerySlot 负责
  if (max <= 0) return { ok: true };
  if (isRedisEnabled()) {
    const bucket = Math.floor(now / WINDOW_MS);
    try {
      const n = await getStateStore().incrWindow(`uql:${userId}:${bucket}`, Math.ceil(WINDOW_MS / 1000) + 100);
      if (n > max) {
        const retryMin = Math.max(1, Math.ceil(((bucket + 1) * WINDOW_MS - now) / 60000));
        return { ok: false, reason: `已达到每小时 ${max} 次的问数上限，请约 ${retryMin} 分钟后再试` };
      }
      return { ok: true };
    } catch {
      // fail-closed：配额状态不可信时拒绝（避免 Redis 故障期 LLM 调用失控）
      return { ok: false, reason: '服务暂时不可用（配额存储异常），请稍后重试' };
    }
  }
  const windowStart = now - WINDOW_MS;
  const list = (hits.get(userId) || []).filter((t) => t > windowStart);
  if (list.length >= max) {
    const retryAfterSec = Math.ceil((list[0] + WINDOW_MS - now) / 1000);
    return { ok: false, reason: `已达到每小时 ${max} 次的问数上限，请约 ${Math.ceil(retryAfterSec / 60)} 分钟后再试` };
  }
  list.push(now);
  hits.set(userId, list);
  return { ok: true };
}

/**
 * 并发互斥：同一用户同一时间仅允许一个进行中的查询。
 * Redis 模式为分布式锁（token 绑定请求，释放时比对防误删）；返回 false 表示已有在途查询。
 * 内存模式同样记录 token 与过期时间：客户端断开可提前释放（见路由 res.on('close')），
 * 旧链路跑完后的 finally 释放因 token 不匹配为 no-op，不会误删新请求的槽。
 */
export async function acquireQuerySlot(userId: number, token = 'local', now: number = Date.now()): Promise<boolean> {
  if (isRedisEnabled()) {
    try {
      return await getStateStore().acquireLock(`uqs:${userId}`, token, SLOT_TTL_SEC);
    } catch {
      return false; // fail-closed
    }
  }
  const cur = inflight.get(userId);
  if (cur && cur.exp > now) return false;
  inflight.set(userId, { token, exp: now + SLOT_TTL_SEC * 1000 });
  return true;
}

export async function releaseQuerySlot(userId: number, token = 'local'): Promise<void> {
  if (isRedisEnabled()) {
    try {
      await getStateStore().releaseLock(`uqs:${userId}`, token);
    } catch {
      // 释放失败由 TTL 过期兜底
    }
    return;
  }
  const cur = inflight.get(userId);
  if (cur && cur.token === token) inflight.delete(userId);
}

// 定期清理过期窗口记录
setInterval(() => {
  const windowStart = Date.now() - WINDOW_MS;
  for (const [key, list] of hits.entries()) {
    const fresh = list.filter((t) => t > windowStart);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
}, WINDOW_MS).unref();

/** 仅供单元测试使用 */
export function _resetForTest(): void {
  hits.clear();
  inflight.clear();
}
