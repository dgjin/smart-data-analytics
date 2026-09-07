/**
 * 限流器（按 IP 计数）。供 server.ts 与各个路由模块共享，避免循环依赖。
 * 默认内存滑动窗口（行为不变）；配置 REDIS_URL 后走 Redis 固定分钟窗口 INCR，
 * 多实例部署时限流计数全局共享。
 */
import type express from 'express';
import { getStateStore, isRedisEnabled } from './stateStore';

const RATE_LIMIT_WINDOW_MS = 60_000;
// ESM import 提升会使模块级 process.env 读取早于 dotenv.config()，须惰性读取
const rateLimitMax = () => Number(process.env.RATE_LIMIT_MAX) || 30;
const requestLog = new Map<string, number[]>();

export async function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.ip || 'unknown';
  const now = Date.now();

  // Redis 模式：固定分钟窗口原子计数（多实例共享）；存储异常 fail-closed 拒绝
  if (isRedisEnabled()) {
    try {
      const bucket = Math.floor(now / RATE_LIMIT_WINDOW_MS);
      const n = await getStateStore().incrWindow(`rl:${key}:${bucket}`, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 10);
      if (n > rateLimitMax()) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
      }
      return next();
    } catch {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
    }
  }

  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (requestLog.get(key) || []).filter((t) => t > windowStart);

  if (hits.length >= rateLimitMax()) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
  }

  hits.push(now);
  requestLog.set(key, hits);
  next();
}

// Periodically prune stale rate-limit entries（仅内存模式生效）
setInterval(() => {
  if (isRedisEnabled()) return;
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, hits] of requestLog.entries()) {
    const fresh = hits.filter((t) => t > windowStart);
    if (fresh.length === 0) requestLog.delete(key);
    else requestLog.set(key, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();
