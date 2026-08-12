/**
 * P2 可观测性（基础版）：为每个请求生成 requestId 并记录访问日志。
 * 仅记录 /api 请求（避免静态资源噪音）；response 头回传 X-Request-Id 供前端报错时关联。
 * 结构化日志（pino）与 traceId 全链路贯穿可在引入日志设施后在此层替换实现。
 */
import { randomBytes } from 'crypto';
import type express from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestLogger(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const requestId = randomBytes(6).toString('hex');
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/api/')) return;
    const user = req.user ? ` user=${req.user.username}` : '';
    console.log(`[HTTP] [${requestId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms${user}`);
  });
  next();
}
