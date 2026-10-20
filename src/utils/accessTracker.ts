/**
 * v0.9.107 访问采集（隐私最小化）：
 * - sessionId 由 crypto.randomUUID() 生成并持久化在 localStorage，同一浏览器只计一次访问；
 * - reportVisit(module) 上报访问 + 模块热度（同模块 60s 内前端节流，服务端再按 session 幂等）；
 * - startAccessHeartbeat() 每 60s 上报一次在线心跳（仅页面可见时），驱动「当前在线」计数；
 * - 上报失败一律静默：计数器不能影响页面与问数主流程。
 */
import { logger } from './logger';

const SESSION_KEY = 'app-access-session';
const VISIT_ENDPOINT = '/api/access/visit';
const PING_ENDPOINT = '/api/access/ping';
/** 同一模块上报节流窗口（与服务端模块热度口径一致） */
const VISIT_THROTTLE_MS = 60_000;
const HEARTBEAT_MS = 60_000;

let cachedSessionId: string | null = null;
let lastModule = '';
let lastVisitAt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** 32 位十六进制随机串（服务端校验 16-64 位 [A-Za-z0-9_-]） */
function randomSessionId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 当前浏览器会话标识（localStorage 不可用时退化为内存态，仅本次会话有效） */
export function getAccessSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) {
      cachedSessionId = stored;
      return stored;
    }
  } catch {
    /* 隐私模式禁用 localStorage：退化为内存态 */
  }
  cachedSessionId = randomSessionId();
  try {
    localStorage.setItem(SESSION_KEY, cachedSessionId);
  } catch {
    /* 忽略写入失败 */
  }
  return cachedSessionId;
}

/** 上报一次访问（含模块热度）；同模块 60s 内不重复上报 */
export async function reportVisit(module: string): Promise<void> {
  const now = Date.now();
  if (module === lastModule && now - lastVisitAt < VISIT_THROTTLE_MS) return;
  lastModule = module;
  lastVisitAt = now;
  try {
    await fetch(VISIT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getAccessSessionId(), module }),
      keepalive: true,
    });
  } catch (err) {
    logger.warn('[Access] 访问上报失败（忽略）:', err);
  }
}

/** 在线心跳：仅页面可见时上报，返回停止函数 */
export function startAccessHeartbeat(): () => void {
  if (heartbeatTimer) return () => {};
  const ping = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    fetch(PING_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getAccessSessionId() }),
      keepalive: true,
    }).catch(() => {
      /* 心跳失败静默 */
    });
  };
  ping();
  heartbeatTimer = setInterval(ping, HEARTBEAT_MS);
  return () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
}
