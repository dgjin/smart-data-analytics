/**
 * 内存滑动窗口限流器（按 IP 计数）。
 * 供 server.ts 与各个路由模块共享，避免循环依赖。
 */
import type express from 'express';

const RATE_LIMIT_WINDOW_MS = 60_000;
// ESM import 提升会使模块级 process.env 读取早于 dotenv.config()，须惰性读取
const rateLimitMax = () => Number(process.env.RATE_LIMIT_MAX) || 30;
const requestLog = new Map<string, number[]>();

export function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (requestLog.get(key) || []).filter((t) => t > windowStart);

  if (hits.length >= rateLimitMax()) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
  }

  hits.push(now);
  requestLog.set(key, hits);
  next();
}

// Periodically prune stale rate-limit entries
setInterval(() => {
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, hits] of requestLog.entries()) {
    const fresh = hits.filter((t) => t > windowStart);
    if (fresh.length === 0) requestLog.delete(key);
    else requestLog.set(key, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();
