/**
 * P2 可观测性：为每个请求生成 requestId 并记录访问日志（v0.9.93 升级）。
 * - requestId 经 AsyncLocalStorage（asyncContext）贯穿整条请求异步链：下游所有 logger 调用
 *   自动携带 requestId/userId 结构化字段，自动运维智能体可据此串联「访问日志 ↔ 业务日志 ↔ 事件」。
 * - 仅记录 /api 请求（避免静态资源噪音）；response 头回传 X-Request-Id 供前端报错时关联。
 */
import { randomBytes } from 'crypto';
import type express from 'express';
import { logger } from './logger';
import { runWithLogContext } from './asyncContext';

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
    // finish 回调执行于 socket 异步上下文（非请求处理链），显式重建上下文让日志行带结构化字段
    runWithLogContext({ requestId, userId: req.user?.id, username: req.user?.username }, () => {
      logger.info(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
  });

  // 包裹后续整条处理链：下游所有异步操作（含鉴权/业务/DB）继承 requestId 上下文
  runWithLogContext({ requestId }, next);
}
