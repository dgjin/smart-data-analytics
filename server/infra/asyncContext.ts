/**
 * v0.9.93 链路上下文（自动运维 P0-2）：requestId/userId/taskId 经 AsyncLocalStorage
 * 在同进程内零拷贝贯穿整条异步链——日志出口（logger 自动注入结构化字段）与运维事件
 * （traceId 关联）共用同一来源，无需层层传参。
 *
 * - HTTP：requestLogger 以 requestId 建立上下文；authMiddleware 鉴权后补 userId/username。
 * - 后台：taskQueue worker 以 taskId/任务类型包裹任务执行。
 * - 定时器/调度器等孤儿异步：无上下文时各字段缺省，日志仍完整（仅链路字段为空）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  userId?: number;
  username?: string;
  taskId?: string;
  taskType?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * 以给定字段建立（或继承后合并）上下文执行 fn。
 * 嵌套调用时子上下文继承父字段并覆盖同名键（如：请求链内又派发任务 → 同时带 requestId 与 taskId）。
 */
export function runWithLogContext<T>(patch: LogContext, fn: () => T): T {
  return storage.run({ ...(storage.getStore() || {}), ...patch }, fn);
}

/** 在当前上下文原地补充字段（如鉴权完成后注入用户身份）；无上下文时静默忽略 */
export function updateLogContext(patch: Partial<LogContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, patch);
}

/** 读取当前上下文（未包裹时返回 undefined） */
export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}
