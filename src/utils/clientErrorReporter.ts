/**
 * v0.9.94 前端错误上报（日志评估 P2-12）：window.onerror / unhandledrejection 采样回流。
 *
 * - 组合根（main.tsx）调用 initClientErrorReporting({ getPage }) 注册全局钩子；getPage 惰性
 *   返回页面标识（如当前功能 Tab）——本应用为无 URL 路由 SPA（pathname 恒为 /），
 *   page 是服务端事件去重实体唯一有区隔度的来源。
 * - 客户端限速双闸：同键（page+message）5 分钟只报一次；每分钟全量上限 10 条。
 *   服务端另有每 IP 20 条/分钟独立限流兜底，双端共同防错误风暴放大。
 * - 上报通道：navigator.sendBeacon 优先（不阻塞、不参与页面卸载竞态），不可用时回退
 *   fetch keepalive；一切失败静默——上报是旁路数据，绝不反噬页面（与系统 fail-open 策略一致）。
 * - 资源加载错误（img/script 等无 message 的 error 事件）为低价值噪声，跳过不上报。
 */
import type { AppTab } from '../types/analytics';

export interface ClientErrorReporterOptions {
  /** 页面标识提供者（如当前功能 Tab）；缺省时仅上报 URL，服务端回退 pathname */
  getPage?: () => AppTab | string | undefined;
}

interface ClientErrorPayload {
  message: string;
  url: string;
  page?: string;
  source?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  userAgent?: string;
  version?: string;
}

const ENDPOINT = '/api/ops/client-errors';
/** 同键（page+message）去重窗口 */
const DEDUP_WINDOW_MS = 5 * 60_000;
/** 每分钟上报总量上限 */
const MAX_PER_MINUTE = 10;

let initialized = false;
let getPageFn: (() => string | undefined) | null = null;
let onErrorHandler: ((e: Event) => void) | null = null;
let onRejectionHandler: ((e: Event) => void) | null = null;

/** 同键去重时间戳 */
const seen = new Map<string, number>();
/** 每分钟上报时间戳窗口 */
const sentAt: number[] = [];

const VERSION = import.meta.env?.VITE_APP_VERSION || '';

/** 双闸限速判定（窗口自清理） */
function shouldThrottle(key: string, now: number): boolean {
  while (sentAt.length > 0 && now - sentAt[0] > 60_000) sentAt.shift();
  if (sentAt.length >= MAX_PER_MINUTE) return true;
  const last = seen.get(key);
  return last !== undefined && now - last < DEDUP_WINDOW_MS;
}

function send(payload: ClientErrorPayload): void {
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
    }
  } catch {
    /* 回退 fetch */
  }
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* 静默：上报故障不得影响页面 */
  }
}

function report(input: {
  message: string;
  source?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
}): void {
  try {
    const message = (input.message || '').slice(0, 500);
    if (!message) return;
    let page = '';
    try {
      page = (getPageFn?.() || '').slice(0, 128);
    } catch {
      /* getPage 异常不影响上报 */
    }
    const now = Date.now();
    if (shouldThrottle(`${page}|${message.slice(0, 120)}`, now)) return;
    seen.set(`${page}|${message.slice(0, 120)}`, now);
    sentAt.push(now);
    send({
      message,
      url: typeof location !== 'undefined' ? location.href : '',
      ...(page ? { page } : {}),
      source: input.source || '',
      lineno: input.lineno,
      colno: input.colno,
      stack: input.stack,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      version: VERSION,
    });
  } catch {
    /* 静默 */
  }
}

/** 幂等注册全局错误钩子（组合根调用；重复调用无副作用） */
export function initClientErrorReporting(options: ClientErrorReporterOptions = {}): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  getPageFn = options.getPage
    ? () => {
        const v = options.getPage?.();
        return typeof v === 'string' ? v : undefined;
      }
    : null;

  onErrorHandler = (e: Event) => {
    const ev = e as ErrorEvent;
    // 资源加载错误（img/script）无 message：低价值噪声，跳过
    if (!ev.message) return;
    report({
      message: ev.message,
      source: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error instanceof Error ? ev.error.stack : undefined,
    });
  };
  onRejectionHandler = (e: Event) => {
    const reason = (e as PromiseRejectionEvent).reason;
    if (reason instanceof Error) {
      report({ message: `${reason.name || 'Error'}: ${reason.message}`, stack: reason.stack });
    } else {
      report({ message: `Unhandled rejection: ${String(reason).slice(0, 300)}` });
    }
  };

  window.addEventListener('error', onErrorHandler);
  window.addEventListener('unhandledrejection', onRejectionHandler);
}

/** 仅供测试：移除钩子并清空限速/幂等状态（应用运行期不调用） */
export function resetClientErrorReporterForTest(): void {
  if (typeof window !== 'undefined') {
    if (onErrorHandler) window.removeEventListener('error', onErrorHandler);
    if (onRejectionHandler) window.removeEventListener('unhandledrejection', onRejectionHandler);
  }
  onErrorHandler = null;
  onRejectionHandler = null;
  getPageFn = null;
  initialized = false;
  seen.clear();
  sentAt.length = 0;
}
