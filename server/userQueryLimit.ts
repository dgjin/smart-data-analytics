/**
 * L5 频率层：智能问数用户级配额（架构图约定：20 次/小时 + 同用户并发限 1）。
 * 与 IP 级 rateLimiter 互补：IP 限流防匿名爆破，本模块按登录用户约束昂贵的 LLM 调用。
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 小时滑动窗口
const maxPerWindow = () => Number(process.env.USER_QUERY_RATE_MAX) || 20;

const hits = new Map<number, number[]>(); // userId -> 窗口内时间戳
const inflight = new Set<number>(); // 进行中的查询（并发互斥）

export interface RateCheck {
  ok: boolean;
  reason?: string;
}

/** 频率检查：窗口内已满 20 次则拒绝（不计数），通过则立即计数。 */
export function checkUserQueryLimit(userId: number, now: number = Date.now()): RateCheck {
  const windowStart = now - WINDOW_MS;
  const list = (hits.get(userId) || []).filter((t) => t > windowStart);
  if (list.length >= maxPerWindow()) {
    const retryAfterSec = Math.ceil((list[0] + WINDOW_MS - now) / 1000);
    return { ok: false, reason: `已达到每小时 ${maxPerWindow()} 次的问数上限，请约 ${Math.ceil(retryAfterSec / 60)} 分钟后再试` };
  }
  list.push(now);
  hits.set(userId, list);
  return { ok: true };
}

/** 并发互斥：同一用户同一时间仅允许一个进行中的查询。返回 false 表示已有在途查询。 */
export function acquireQuerySlot(userId: number): boolean {
  if (inflight.has(userId)) return false;
  inflight.add(userId);
  return true;
}

export function releaseQuerySlot(userId: number): void {
  inflight.delete(userId);
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
