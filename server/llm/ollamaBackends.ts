/**
 * P2-2 Ollama 多后端路由：OLLAMA_URLS=host1,host2 最少并发 + 健康检查剔除。
 * 自包含模块（仅依赖 logger）；引擎解析与 LLM 主调用通道见 llmClient.ts。
 * 惰性读取环境变量（ESM import 提升会使模块级读取早于 dotenv.config()，同 auth.ts/db.ts 先例）
 */
import { logger } from '../infra/logger';

export const ollamaUrl = () => process.env.OLLAMA_URL || 'http://localhost:11434';
export const ollamaTimeoutMs = () => Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000;

// ---------- P2-2 Ollama 多后端路由：OLLAMA_URLS=host1,host2 最少并发 + 健康检查剔除 ----------
export interface OllamaBackend {
  url: string;
  /** 在途请求数（最少并发路由依据） */
  inflight: number;
  /** 熔断摘除截止时间戳（0=健康）；失败即摘除，由健康检查恢复 */
  downUntil: number;
}
let ollamaPool: OllamaBackend[] | null = null;

/** 解析后端列表：OLLAMA_URLS（逗号分隔，去重）优先，缺省回退 OLLAMA_URL 单后端 */
function ollamaBackendUrls(): string[] {
  const multi = String(process.env.OLLAMA_URLS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (multi.length > 0) return [...new Set(multi)];
  return [String(ollamaUrl()).replace(/\/+$/, '')];
}

function ollamaBackends(): OllamaBackend[] {
  const urls = ollamaBackendUrls();
  // 配置变更时重建池（摘除状态随配置一起重置）
  if (!ollamaPool || ollamaPool.map((b) => b.url).join('|') !== urls.join('|')) {
    ollamaPool = urls.map((url) => ({ url, inflight: 0, downUntil: 0 }));
  }
  return ollamaPool;
}

/** 后端摘除冷却期：失败摘除后由健康检查探测恢复；未启动健康检查时到期自动半开 */
const OLLAMA_BACKEND_COOLDOWN_MS = 15_000;

/** 最少并发路由：健康（含冷却到期半开）且未被排除的节点中取 inflight 最小者；
 * 全部被摘除/排除时取最早恢复的节点兜底（尽力服务，不主动拒绝）。 */
export function pickOllamaBackend(exclude?: Set<string>): OllamaBackend | undefined {
  const now = Date.now();
  const pool = ollamaBackends().filter((b) => !exclude?.has(b.url));
  if (pool.length === 0) return undefined;
  const healthy = pool.filter((b) => b.downUntil <= now);
  const candidates = healthy.length > 0 ? healthy : [...pool].sort((a, b) => a.downUntil - b.downUntil);
  return candidates.reduce((min, b) => (b.inflight < min.inflight ? b : min));
}

function reportOllamaSuccess(url: string): void {
  const b = ollamaBackends().find((x) => x.url === url);
  if (b) b.downUntil = 0;
}

function reportOllamaFailure(url: string): void {
  const b = ollamaBackends().find((x) => x.url === url);
  if (!b) return;
  b.downUntil = Date.now() + OLLAMA_BACKEND_COOLDOWN_MS;
  if (ollamaBackends().length > 1) {
    logger.warn(`[LLM] Ollama 后端 ${url} 调用失败，已摘除（待健康检查恢复）`);
  }
}


/** AbortController 超时中止判定（DOMException/Error 均按 name 判别） */
export function isAbortErr(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/** 多后端执行包装：最少并发选取 → 失败记账摘除 → 自动在次优健康后端重试（单后端直接抛出交由外层重试） */
export async function withOllamaBackend<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const tried = new Set<string>();
  let lastErr: unknown;
  while (true) {
    const b = pickOllamaBackend(tried);
    if (!b) break;
    b.inflight++;
    try {
      const r = await fn(b.url);
      reportOllamaSuccess(b.url);
      return r;
    } catch (err) {
      reportOllamaFailure(b.url);
      tried.add(b.url);
      lastErr = err;
      if (ollamaBackends().length <= 1) break;
    } finally {
      b.inflight--;
    }
  }
  throw lastErr;
}

/** 单后端健康探测（GET /api/tags，3s 超时） */
export async function probeOllamaBackend(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

let ollamaHealthTimer: ReturnType<typeof setInterval> | null = null;
/** 后台健康检查：周期探测被摘除的后端，恢复即重新接入（unref 不阻塞进程退出） */
export function startOllamaHealthChecks(intervalMs = 10_000): void {
  if (ollamaHealthTimer) return;
  ollamaHealthTimer = setInterval(() => {
    const now = Date.now();
    for (const b of ollamaBackends()) {
      if (b.downUntil <= now) continue;
      void probeOllamaBackend(b.url).then((ok) => {
        if (ok) {
          b.downUntil = 0;
          logger.warn(`[LLM] Ollama 后端 ${b.url} 健康检查通过，恢复接入`);
        }
      });
    }
  }, intervalMs);
  ollamaHealthTimer?.unref();
}

/** 供测试/诊断读取后端状态快照 */
export function getOllamaBackendStates(): OllamaBackend[] {
  return ollamaBackends().map((b) => ({ ...b }));
}

/** 测试用：重置后端池与健康检查定时器 */
export function resetOllamaBackendsForTest(): void {
  ollamaPool = null;
  if (ollamaHealthTimer) {
    clearInterval(ollamaHealthTimer);
    ollamaHealthTimer = null;
  }
}
