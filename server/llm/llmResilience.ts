/**
 * P0-3 LLM 调用韧性原语：指数退避重试、引擎级熔断器、并发信号量、自适应超时。
 * 全部与时钟/随机/网络解耦（可注入），供 llmClient.ts 集成与 llmResilience.test.ts 独立单测。
 *
 * 设计要点：
 * - 重试仅针对可恢复错误（超时/5xx/网络错误）；4xx（鉴权/参数错误）立即失败不浪费配额
 * - 熔断器按引擎隔离（ollama/qwen/gemini 各一）：连续失败 N 次开路，冷却期后半开单探测恢复
 * - 信号量按引擎限流：本地 Ollama 算力有限，超出并发排队而非打爆推理进程
 * - 自适应超时：以近期成功调用 P95×3 动态收紧配置上限（慢模型不被误杀，快模型不被长超时拖死）
 */

/** 带语义标记的 LLM 调用错误：status=HTTP 状态码；code=TIMEOUT/CIRCUIT_OPEN 等 */
export interface LlmCallError extends Error {
  status?: number;
  code?: string;
}

export function makeLlmError(
  message: string,
  opts?: { status?: number; code?: string; cause?: unknown }
): LlmCallError {
  const err = new Error(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined) as LlmCallError;
  if (opts?.status !== undefined) err.status = opts.status;
  if (opts?.code !== undefined) err.code = opts.code;
  return err;
}

/** 从任意异常提取 HTTP 状态码（优先 err.status，兜底匹配 message 中的 3 位状态码） */
export function extractStatus(err: any): number | undefined {
  if (typeof err?.status === 'number') return err.status;
  const m = /(?:error|status)[:\s]*(\d{3})\b/i.exec(String(err?.message || ''));
  return m ? Number(m[1]) : undefined;
}

/**
 * 可重试判定：
 * - 显式超时（code=TIMEOUT / AbortError）→ 可重试
 * - 5xx 服务错误 / 429 限流 → 可重试
 * - 4xx（除 429）→ 不可重试（鉴权失败、参数错误重试无意义）
 * - 无状态码（网络层错误 fetch failed/ECONNRESET 等）→ 可重试
 */
export function isRetryable(err: any): boolean {
  if (err?.code === 'TIMEOUT' || err?.name === 'AbortError') return true;
  if (err?.code === 'CIRCUIT_OPEN') return false;
  const status = extractStatus(err);
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

// ---------- 并发信号量（每引擎排队上限） ----------

export class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error('Semaphore max 必须 ≥ 1');
  }

  /** 获取一个并发槽位（满员时排队等待），返回释放函数（务必 finally 调用） */
  acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }
}

// ---------- 引擎级熔断器 ----------

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** 连续失败达到该次数后开路（默认 3） */
  failureThreshold?: number;
  /** 开路冷却期（默认 30s），过后进入半开允许单探测 */
  cooldownMs?: number;
  /** 时钟注入（测试用） */
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly threshold: number;
  private readonly cooldown: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.cooldown = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  state(): CircuitState {
    if (this.failures < this.threshold) return 'closed';
    if (this.now() - this.openedAt < this.cooldown) return 'open';
    return 'half-open';
  }

  /** 是否允许发起请求（半开状态同时只允许一个探测请求） */
  canRequest(): boolean {
    const s = this.state();
    if (s === 'closed') return true;
    if (s === 'open') return false;
    // half-open：单探测
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  onFailure(): void {
    this.failures++;
    this.probing = false;
    if (this.failures >= this.threshold && this.openedAt === 0) {
      this.openedAt = this.now();
    }
    // 连续失败刷新开路计时起点（半开探测失败重新计时）
    if (this.failures > this.threshold) this.openedAt = this.now();
  }

  /** 测试/管理用：重置为 closed */
  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}

// ---------- 指数退避重试 ----------

export interface RetryOptions {
  /** 最大重试次数（不含首次调用，默认 2） */
  maxRetries?: number;
  /** 退避基数毫秒（默认 1000，第 n 次重试等待 base*2^(n-1) + 抖动） */
  baseDelayMs?: number;
  /** 睡眠注入（测试用） */
  sleep?: (ms: number) => Promise<void>;
  /** 随机数注入（测试用） */
  random?: () => number;
  /** 每次重试前回调（日志/埋点） */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 1_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      attempt++;
      // 指数退避 + 25% 抖动，避免多实例重试同频叠加
      const delay = Math.round(base * 2 ** (attempt - 1) * (0.75 + random() * 0.5));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

// ---------- 自适应超时（滑动窗口 P95 驱动） ----------

/** 近期成功调用耗时滑动窗口（环形缓冲） */
export class LatencyWindow {
  private samples: number[] = [];
  private cursor = 0;

  constructor(private readonly capacity = 50) {}

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.samples.length < this.capacity) {
      this.samples.push(ms);
    } else {
      this.samples[this.cursor % this.capacity] = ms;
    }
    this.cursor++;
  }

  /** P95 分位数（样本不足 10 条时返回 null，不做自适应） */
  p95(): number | null {
    if (this.samples.length < 10) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx];
  }

  get size(): number {
    return this.samples.length;
  }
}

/**
 * 自适应超时：取 P95×3，夹在 [floorMs, configuredMs]。
 * 样本不足或计算结果高于配置上限时返回配置上限（保守，不放大超时）。
 */
export function adaptiveTimeoutMs(
  window: LatencyWindow,
  configuredMs: number,
  floorMs = 15_000
): number {
  const p95 = window.p95();
  if (p95 === null) return configuredMs;
  const adaptive = Math.ceil(p95 * 3);
  return Math.max(floorMs, Math.min(configuredMs, adaptive));
}
