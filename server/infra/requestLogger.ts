/**
 * P2 可观测性：为每个请求生成 requestId 并记录访问日志（v0.9.93 升级，v0.9.94 降噪）。
 * - requestId 经 AsyncLocalStorage（asyncContext）贯穿整条请求异步链：下游所有 logger 调用
 *   自动携带 requestId/userId 结构化字段，自动运维智能体可据此串联「访问日志 ↔ 业务日志 ↔ 事件」。
 * - 仅记录 /api 请求（避免静态资源噪音）；response 头回传 X-Request-Id 供前端报错时关联。
 * - v0.9.94 噪声治理：轮询类端点（LOG_QUIET_PATHS 前缀列表，默认 /api/health、/api/system/models）
 *   访问日志降为 debug 级——默认 info 阈值下不落盘（LOG_LEVEL=debug 可诊断），避免高频轮询
 *   写满访问日志；置空字符串 = 关闭降噪。
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

/** 默认高频轮询端点前缀（逗号分隔；LOG_QUIET_PATHS 未设置时生效） */
const DEFAULT_QUIET_PATHS = '/api/health,/api/system/models';

/** 路径是否命中降噪列表（惰性读环境变量：settings 变更重启生效） */
export function shouldQuietPath(path: string): boolean {
  const raw = process.env.LOG_QUIET_PATHS ?? DEFAULT_QUIET_PATHS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((prefix) => path.startsWith(prefix));
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
      const line = `[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms`;
      if (shouldQuietPath(req.path)) logger.debug(line);
      else logger.info(line);
    });
  });

  // 包裹后续整条处理链：下游所有异步操作（含鉴权/业务/DB）继承 requestId 上下文
  runWithLogContext({ requestId }, next);
}
