/**
 * 统一 LLM 调用通道（Ollama 本地 / Gemini API / 通义千问百炼）。
 * 供查询、报表等端点共享；双阶段（SQL 生成 / 数据分析）均通过 callLLMJson 调用。
 * 引擎选择优先级：请求级覆盖（setLlmOverride，用户自选模型）>
 * 阶段级路由（callLLMJson opts.route，如 SQL 生成快速模型 P1-2）>
 * AI_ENGINE 显式指定（ollama/gemini/qwen）> 按密钥存在性自动（gemini/qwen）> ollama。
 */
import { AsyncLocalStorage } from 'async_hooks';
import { recordLlmUsage } from './llmUsage';
import {
  CircuitBreaker,
  LatencyWindow,
  Semaphore,
  adaptiveTimeoutMs,
  makeLlmError,
  withRetry,
} from './llmResilience';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 惰性读取环境变量（ESM import 提升会使模块级读取早于 dotenv.config()，同 auth.ts/db.ts 先例）
const llmModel = () => overrideModel('ollama') || process.env.LLM_MODEL || 'deepseek-r1:32b';
const ollamaUrl = () => process.env.OLLAMA_URL || 'http://localhost:11434';
const ollamaTimeoutMs = () => Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000;

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
    console.warn(`[LLM] Ollama 后端 ${url} 调用失败，已摘除（待健康检查恢复）`);
  }
}

/** 多后端执行包装：最少并发选取 → 失败记账摘除 → 自动在次优健康后端重试（单后端直接抛出交由外层重试） */
async function withOllamaBackend<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const tried = new Set<string>();
  let lastErr: any;
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
          console.warn(`[LLM] Ollama 后端 ${b.url} 健康检查通过，恢复接入`);
        }
      });
    }
  }, intervalMs);
  (ollamaHealthTimer as any)?.unref?.();
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
// 通义千问（百炼 OpenAI 兼容协议）；Coding Plan（sk-sp-）需将 QWEN_URL 指向
// https://coding.dashscope.aliyuncs.com/v1，普通按量 Key 用默认端点即可
const qwenUrl = () => process.env.QWEN_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const qwenModel = () => overrideModel('qwen') || process.env.QWEN_MODEL || 'qwen3.8-max';
const qwenTimeoutMs = () => Number(process.env.QWEN_TIMEOUT_MS) || 180_000;
const GEMINI_MODEL = 'gemini-3.6-flash';
const geminiModel = () => overrideModel('gemini') || GEMINI_MODEL;

type EngineKind = 'ollama' | 'gemini' | 'qwen';

// ---------- P0-3 调用韧性：重试 + 引擎级熔断 + 并发排队 + 自适应超时 ----------
/** 最大重试次数（不含首次，默认 2；仅超时/5xx/网络错误重试，4xx 立即失败） */
const llmRetryMax = () => {
  const n = Number(process.env.LLM_RETRY_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.min(3, Math.floor(n)) : 2;
};
/** 每引擎并发上限（默认 4：本地 Ollama 算力有限，超出排队而非打爆推理进程） */
const llmMaxConcurrent = () => {
  const n = Number(process.env.LLM_MAX_CONCURRENT);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
};
/** 熔断：连续失败开路阈值（默认 3）与冷却期（默认 30s，过后半开单探测） */
const breakerFailThreshold = () => {
  const n = Number(process.env.LLM_BREAKER_FAILS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};
const breakerCooldownMs = () => {
  const n = Number(process.env.LLM_BREAKER_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 30_000;
};
/** 自适应超时开关（默认开：以近期成功 P95×3 动态收紧配置上限；LLM_ADAPTIVE_TIMEOUT=0 关闭） */
const adaptiveTimeoutEnabled = () => process.env.LLM_ADAPTIVE_TIMEOUT !== '0';

interface ResilienceState {
  breakers: Record<EngineKind, CircuitBreaker>;
  semaphores: Record<EngineKind, Semaphore>;
  windows: Record<EngineKind, LatencyWindow>;
}
let resilience: ResilienceState | null = null;
function resilienceState(): ResilienceState {
  if (!resilience) {
    resilience = {
      breakers: {
        ollama: new CircuitBreaker({ failureThreshold: breakerFailThreshold(), cooldownMs: breakerCooldownMs() }),
        qwen: new CircuitBreaker({ failureThreshold: breakerFailThreshold(), cooldownMs: breakerCooldownMs() }),
        gemini: new CircuitBreaker({ failureThreshold: breakerFailThreshold(), cooldownMs: breakerCooldownMs() }),
      },
      semaphores: {
        ollama: new Semaphore(llmMaxConcurrent()),
        qwen: new Semaphore(llmMaxConcurrent()),
        gemini: new Semaphore(llmMaxConcurrent()),
      },
      windows: { ollama: new LatencyWindow(), qwen: new LatencyWindow(), gemini: new LatencyWindow() },
    };
  }
  return resilience;
}

/** 测试用：重置全部熔断/信号量/耗时窗口状态 */
export function resetLlmResilienceForTest(): void {
  resilience = null;
}

/** 引擎可配置性：ollama 本地默认可试（不可达由熔断接管）；qwen/gemini 需密钥 */
function engineConfigured(kind: EngineKind): boolean {
  if (kind === 'ollama') return true;
  if (kind === 'qwen') return Boolean(process.env.QWEN_API_KEY);
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * 引擎级熔断转移：主引擎开路时切换到已配置且未开路的备用引擎
 * （如 Ollama 连续失败自动切 Qwen）；全部开路时 circuitOpen=true，调用方快速失败不雪崩。
 */
export function resolveEngineWithFailover(
  primary: EngineKind
): { kind: EngineKind; failovered: boolean; circuitOpen: boolean } {
  const rs = resilienceState();
  if (rs.breakers[primary].canRequest()) return { kind: primary, failovered: false, circuitOpen: false };
  const order: EngineKind[] =
    primary === 'ollama' ? ['qwen', 'gemini'] : primary === 'qwen' ? ['ollama', 'gemini'] : ['qwen', 'ollama'];
  for (const alt of order) {
    if (engineConfigured(alt) && rs.breakers[alt].canRequest()) {
      console.warn(`[LLM] 引擎 ${primary} 熔断开路，本次调用故障转移到 ${alt}`);
      return { kind: alt, failovered: true, circuitOpen: false };
    }
  }
  return { kind: primary, failovered: false, circuitOpen: true };
}

/** 通道调用包装：信号量排队 → 退避重试 → 熔断记账（成功/失败） */
async function callChannel(kind: EngineKind, fn: () => Promise<ChannelOutcome>): Promise<ChannelOutcome> {
  const rs = resilienceState();
  const release = await rs.semaphores[kind].acquire();
  try {
    const outcome = await withRetry(fn, {
      maxRetries: llmRetryMax(),
      onRetry: (err, attempt, delay) =>
        console.warn(
          `[LLM] ${kind} 调用失败，第 ${attempt} 次重试（${delay}ms 后）：${String((err as any)?.message || err).slice(0, 120)}`
        ),
    });
    rs.breakers[kind].onSuccess();
    return outcome;
  } catch (err) {
    rs.breakers[kind].onFailure();
    throw err;
  } finally {
    release();
  }
}

/** 阶段级模型路由（P1-2）：调用方可为单次调用指定引擎/模型（如 SQL 生成用快速小模型） */
export interface LlmStageRoute {
  engine: EngineKind;
  model: string;
}

/**
 * 阶段级模型路由通用解析：环境变量指定引擎+模型均合法时启用（结构化任务用快速小模型更快更稳）。
 */
function stageRouteFromEnv(engineVar: string, modelVar: string): LlmStageRoute | undefined {
  const engine = String(process.env[engineVar] || '').toLowerCase();
  const model = String(process.env[modelVar] || '').trim();
  if (engine !== 'ollama' && engine !== 'gemini' && engine !== 'qwen') return undefined;
  if (!model || model.length > 100 || !/^[\w.:-]+$/.test(model)) return undefined;
  return { engine: engine as EngineKind, model };
}

/**
 * SQL 生成阶段的快速模型路由（P1-2）：LLM_SQL_ENGINE + LLM_SQL_MODEL 均配置且合法时启用。
 * 作用于阶段一与复杂度评估（结构化输出任务小模型更快更稳）；阶段二解读默认仍用主模型。
 */
export function sqlStageRoute(): LlmStageRoute | undefined {
  return stageRouteFromEnv('LLM_SQL_ENGINE', 'LLM_SQL_MODEL');
}

/**
 * 阶段二数据解读的快速模型路由：LLM_ANALYSIS_ENGINE + LLM_ANALYSIS_MODEL 均配置时启用。
 * 解读是问数链路最大耗时项，配置快速模型可大幅提速（质量取舍由部署方决定）。
 */
export function analysisStageRoute(): LlmStageRoute | undefined {
  return stageRouteFromEnv('LLM_ANALYSIS_ENGINE', 'LLM_ANALYSIS_MODEL');
}

/** 请求级引擎/模型覆盖（用户自选模型）：随异步上下文传递，避免逐层透传参数 */
export interface LlmOverride {
  engine?: EngineKind;
  model?: string;
  /** 请求用户上下文（authMiddleware 注入，随 LLM 用量埋点落库，支撑按用户统计） */
  userId?: number;
  username?: string;
}
const overrideStore = new AsyncLocalStorage<LlmOverride>();

/** 在当前请求上下文内设置引擎/模型覆盖（合并式 enterWith：保留已注入的用户上下文等字段） */
export function setLlmOverride(override: LlmOverride): void {
  overrideStore.enterWith({ ...overrideStore.getStore(), ...override });
}

/** 鉴权后注入请求用户上下文（本次请求异步链内的 LLM 用量埋点均携带该用户） */
export function setLlmUserContext(userId: number, username: string): void {
  overrideStore.enterWith({ ...overrideStore.getStore(), userId, username });
}

/** 当前上下文的用户上下文（无请求上下文时返回空，如启动期/后台任务） */
export function getLlmUserContext(): { userId?: number; username?: string } {
  const o = overrideStore.getStore();
  return o ? { userId: o.userId, username: o.username } : {};
}

/** 带请求用户上下文的用量埋点：避免逐调用点手动取 store */
function recordUsage(entry: Parameters<typeof recordLlmUsage>[0]): void {
  const ctx = getLlmUserContext();
  recordLlmUsage({ ...entry, userId: ctx.userId, username: ctx.username });
}

/** 当前上下文生效的模型名（仅当覆盖引擎与目标通道一致时生效） */
function overrideModel(kind: EngineKind): string | undefined {
  const o = overrideStore.getStore();
  if (!o || !o.model) return undefined;
  return (o.engine || envEngineKind()) === kind ? o.model : undefined;
}

/** 环境变量级引擎选择（AI_ENGINE 显式 > 密钥存在性） */
function envEngineKind(): EngineKind {
  const explicit = String(process.env.AI_ENGINE || '').toLowerCase();
  if (explicit === 'ollama' || explicit === 'gemini' || explicit === 'qwen') return explicit;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.QWEN_API_KEY) return 'qwen';
  return 'ollama';
}

function engineKind(): EngineKind {
  return overrideStore.getStore()?.engine || envEngineKind();
}

export function llmEngineLabel(): string {
  const kind = engineKind();
  if (kind === 'gemini') return 'Gemini API';
  if (kind === 'qwen') return `Qwen ${qwenModel()}`;
  const backends = getOllamaBackendStates();
  return backends.length > 1
    ? `Ollama ${llmModel()} @ ${backends.length} 节点`
    : `Ollama ${llmModel()} @ ${ollamaUrl()}`;
}

export interface LlmEngineInfo {
  engine: 'ollama' | 'gemini' | 'qwen';
  model: string;
  /** 前端展示标签（不含内网地址） */
  label: string;
}

/** 供前端按实际使用的模型展示提示信息 */
export function llmEngineInfo(): LlmEngineInfo {
  const kind = engineKind();
  if (kind === 'gemini') return { engine: 'gemini', model: geminiModel(), label: `Gemini ${geminiModel()}` };
  if (kind === 'qwen') return { engine: 'qwen', model: qwenModel(), label: `Qwen ${qwenModel()}` };
  return { engine: 'ollama', model: llmModel(), label: `Ollama ${llmModel()}` };
}

/** 可选模型目录条目（供前端用户自选） */
export interface ModelOption {
  engine: EngineKind;
  model: string;
  label: string;
  /** 是否为服务端默认引擎/模型 */
  isDefault: boolean;
}

/** 校验用户提交的模型选择；未提供返回 null，非法返回错误原因 */
export function validateModelSelection(
  engine: unknown,
  model: unknown
): { engine: EngineKind; model: string } | { error: string } | null {
  if (engine === undefined || engine === null || engine === '') return null;
  if (typeof engine !== 'string' || !['ollama', 'gemini', 'qwen'].includes(engine)) {
    return { error: '不支持的模型引擎' };
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 100 || !/^[\w.:-]+$/.test(model)) {
    return { error: '模型名称不合法' };
  }
  return { engine: engine as EngineKind, model: model.trim() };
}

/**
 * 当前部署可用的模型目录：
 * - ollama：实时拉取 /api/tags 已安装模型（不可达时回退配置项）
 * - qwen/gemini：已配置密钥时列入（模型为环境配置值）
 */
export async function listAvailableModels(): Promise<ModelOption[]> {
  const def = envEngineKind();
  const defModel = def === 'qwen' ? (process.env.QWEN_MODEL || 'qwen3.8-max') : def === 'gemini' ? GEMINI_MODEL : process.env.LLM_MODEL || 'deepseek-r1:32b';
  const opts: ModelOption[] = [];

  // Ollama 本地已安装模型（3s 超时，不可达时仅列配置模型；P2-2 多后端取当前最优节点）
  let ollamaModels: string[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const base = pickOllamaBackend()?.url || ollamaUrl();
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const json: any = await res.json();
      ollamaModels = Array.isArray(json?.models)
        ? json.models.map((m: any) => String(m?.name || '')).filter(Boolean)
        : [];
    }
  } catch {
    // Ollama 不可达：仅当其为默认引擎时列出配置模型
  }
  const ollamaList = ollamaModels.length > 0 ? ollamaModels : [process.env.LLM_MODEL || 'deepseek-r1:32b'];
  for (const name of ollamaList) {
    opts.push({ engine: 'ollama', model: name, label: `Ollama ${name}`, isDefault: def === 'ollama' && name === defModel });
  }

  if (process.env.QWEN_API_KEY) {
    const m = process.env.QWEN_MODEL || 'qwen3.8-max';
    opts.push({ engine: 'qwen', model: m, label: `Qwen ${m}`, isDefault: def === 'qwen' });
  }
  if (process.env.GEMINI_API_KEY) {
    opts.push({ engine: 'gemini', model: GEMINI_MODEL, label: `Gemini ${GEMINI_MODEL}`, isDefault: def === 'gemini' });
  }
  return opts;
}

/** 通道层返回：文本 + 可选 token 用量（P2-4 成本埋点，引擎不返回时缺省） */
interface ChannelUsage {
  promptTokens: number;
  completionTokens: number;
}
interface ChannelOutcome {
  text: string;
  usage?: ChannelUsage;
}

/** 通义千问 OpenAI 兼容通道（百炼按量 / Coding Plan 均适用，端点由 QWEN_URL 决定） */
async function qwenChat(messages: ChatMessage[], formatJson = true, modelOverride?: string): Promise<ChannelOutcome> {
  const controller = new AbortController();
  // P0-3 自适应超时：近期成功 P95×3 动态收紧配置上限（慢模型不误杀，快模型不被长超时拖死）
  const configured = qwenTimeoutMs();
  const timeout = adaptiveTimeoutEnabled() ? adaptiveTimeoutMs(resilienceState().windows.qwen, configured) : configured;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${qwenUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.QWEN_API_KEY || ''}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelOverride || qwenModel(),
        messages,
        stream: false,
        ...(formatJson ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw makeLlmError(`Qwen API error: ${res.status} ${text}`, { status: res.status });
    }

    const json: any = await res.json();
    // P2-4 成本埋点：OpenAI 兼容响应带 usage 字段
    const u = json?.usage;
    return {
      text: json.choices?.[0]?.message?.content || '',
      usage: u && (Number(u.prompt_tokens) > 0 || Number(u.completion_tokens) > 0)
        ? { promptTokens: Number(u.prompt_tokens) || 0, completionTokens: Number(u.completion_tokens) || 0 }
        : undefined,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw makeLlmError(`Qwen 推理超时（超过 ${Math.round(timeout / 1000)} 秒）`, { code: 'TIMEOUT', cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaChat(messages: ChatMessage[], formatJson = true, modelOverride?: string): Promise<ChannelOutcome> {
  const controller = new AbortController();
  const configured = ollamaTimeoutMs();
  const timeout = adaptiveTimeoutEnabled() ? adaptiveTimeoutMs(resilienceState().windows.ollama, configured) : configured;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    // P2-2 多后端：最少并发选取节点，失败自动换次优节点重试
    const res = await withOllamaBackend((base) =>
      fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelOverride || llmModel(),
          messages,
          stream: false,
          // 模型常驻 30 分钟，避免连续问答间卸载/重载开销
          keep_alive: '30m',
          ...(formatJson ? { format: 'json' } : {}),
        }),
      })
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw makeLlmError(`Ollama API error: ${res.status} ${text}`, { status: res.status });
    }

    const json: any = await res.json();
    // P2-4 成本埋点：Ollama 返回 prompt_eval_count / eval_count
    const pt = Number(json?.prompt_eval_count) || 0;
    const ct = Number(json?.eval_count) || 0;
    return {
      text: json.message?.content || '',
      usage: pt > 0 || ct > 0 ? { promptTokens: pt, completionTokens: ct } : undefined,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw makeLlmError(`Ollama 推理超时（超过 ${Math.round(timeout / 1000)} 秒）`, { code: 'TIMEOUT', cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 以 JSON 输出模式调用 LLM，返回原始文本（调用方负责 safeParseJson + 结构校验）。
 * history 为已净化的多轮上下文（仅 user 消息，见 L4 历史层）。
 * opts.route：阶段级模型路由（P1-2）；用户请求级自选模型（setLlmOverride）优先于阶段路由。
 */
export async function callLLMJson(system: string, user: string, history: ChatMessage[] = [], opts?: { route?: LlmStageRoute }): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: user },
  ];

  // 阶段路由仅在用户未自选模型时生效（用户显式选择始终优先）
  const route = overrideStore.getStore()?.model ? undefined : opts?.route;
  // P0-3 引擎级熔断转移：主引擎开路（如 Ollama 连续失败）自动切已配置备用引擎（如 Qwen）
  const primary: EngineKind = route ? route.engine : engineKind();
  const { kind, failovered, circuitOpen } = resolveEngineWithFailover(primary);
  // 全部引擎开路：快速失败（埋点 ok:false），不再发起网络调用防止雪崩
  if (circuitOpen) {
    const err = makeLlmError(`LLM 引擎 ${primary} 熔断开路中（冷却期后自动恢复），请稍后重试`, { code: 'CIRCUIT_OPEN' });
    recordUsage({ engine: primary, model: '', channel: 'json', promptTokens: 0, completionTokens: 0, durationMs: 0, ok: false });
    throw err;
  }
  // 故障转移后阶段路由的模型名不适用于目标引擎，回落目标引擎默认模型
  const effectiveRoute = failovered ? undefined : route;
  const usedModel =
    kind === 'ollama'
      ? effectiveRoute?.model || llmModel()
      : kind === 'qwen'
        ? effectiveRoute?.model || qwenModel()
        : effectiveRoute?.model || geminiModel();

  // P2-4 成本埋点：统一计时，成功/失败均落库（fire-and-forget）
  const t0 = Date.now();
  try {
    // P0-3：信号量并发排队 + 退避重试 + 熔断记账
    const outcome = await callChannel(kind, async (): Promise<ChannelOutcome> => {
      if (kind === 'ollama') return ollamaChat(messages, true, effectiveRoute?.model);
      if (kind === 'qwen') return qwenChat(messages, true, effectiveRoute?.model);
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const contents = [
        ...history.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text: user }] },
      ];
      const response = await ai.models.generateContent({
        model: effectiveRoute?.model || geminiModel(),
        contents,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
        },
      });
      const um = (response as any)?.usageMetadata;
      return {
        text: response.text || '{}',
        usage:
          um && (Number(um.promptTokenCount) > 0 || Number(um.candidatesTokenCount) > 0)
            ? { promptTokens: Number(um.promptTokenCount) || 0, completionTokens: Number(um.candidatesTokenCount) || 0 }
            : undefined,
      };
    });
    // 自适应超时样本：仅记录成功调用耗时
    resilienceState().windows[kind].record(Date.now() - t0);
    recordUsage({
      engine: kind,
      model: usedModel,
      channel: 'json',
      promptTokens: outcome.usage?.promptTokens || 0,
      completionTokens: outcome.usage?.completionTokens || 0,
      durationMs: Date.now() - t0,
      ok: true,
    });
    return outcome.text;
  } catch (err) {
    recordUsage({ engine: kind, model: usedModel, channel: 'json', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - t0, ok: false });
    throw err;
  }
}

/**
 * 以纯文本模式调用 LLM（SQL 解释/优化建议等非结构化输出场景）。
 * 与 callLLMJson 的区别仅是不要求 JSON 输出格式。
 */
export async function callLLMText(system: string, user: string): Promise<string> {
  const primary = engineKind();
  const { kind, circuitOpen } = resolveEngineWithFailover(primary);
  if (circuitOpen) {
    const err = makeLlmError(`LLM 引擎 ${primary} 熔断开路中（冷却期后自动恢复），请稍后重试`, { code: 'CIRCUIT_OPEN' });
    recordUsage({ engine: primary, model: '', channel: 'text', promptTokens: 0, completionTokens: 0, durationMs: 0, ok: false });
    throw err;
  }
  const usedModel = kind === 'ollama' ? llmModel() : kind === 'qwen' ? qwenModel() : geminiModel();
  const t0 = Date.now();
  try {
    const outcome = await callChannel(kind, async (): Promise<ChannelOutcome> => {
      if (kind === 'ollama') {
        return ollamaChat(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          false
        );
      }
      if (kind === 'qwen') {
        return qwenChat(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          false
        );
      }
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const response = await ai.models.generateContent({
        model: geminiModel(),
        contents: [{ role: 'user', parts: [{ text: user }] }],
        config: { systemInstruction: system },
      });
      const um = (response as any)?.usageMetadata;
      return {
        text: response.text || '',
        usage:
          um && (Number(um.promptTokenCount) > 0 || Number(um.candidatesTokenCount) > 0)
            ? { promptTokens: Number(um.promptTokenCount) || 0, completionTokens: Number(um.candidatesTokenCount) || 0 }
            : undefined,
      };
    });
    resilienceState().windows[kind].record(Date.now() - t0);
    recordUsage({
      engine: kind,
      model: usedModel,
      channel: 'text',
      promptTokens: outcome.usage?.promptTokens || 0,
      completionTokens: outcome.usage?.completionTokens || 0,
      durationMs: Date.now() - t0,
      ok: true,
    });
    return outcome.text;
  } catch (err) {
    recordUsage({ engine: kind, model: usedModel, channel: 'text', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - t0, ok: false });
    throw err;
  }
}

// embedding 模型（Ollama 需已 pull，如 nomic-embed-text；未装时调用方降级为关键词检索）
const embedModel = () => process.env.EMBED_MODEL || 'nomic-embed-text';
// 千问 embedding 模型（Coding Plan 端点可能不支持，失败时调用方自动降级关键词粗排）
const qwenEmbedModel = () => process.env.QWEN_EMBED_MODEL || 'text-embedding-v4';

// embedding 短 TTL 缓存：同一问题的 query 向量在圈表精排与知识库检索间复用，重试/重复提问不再重复调用
const EMBED_CACHE_TTL_MS = 10 * 60 * 1000;
const EMBED_CACHE_MAX = 256;
const embedCache = new Map<string, { v: number[]; exp: number }>();

function embedCacheGet(key: string): number[] | null {
  const hit = embedCache.get(key);
  if (!hit) return null;
  if (hit.exp <= Date.now()) {
    embedCache.delete(key);
    return null;
  }
  return hit.v;
}

function embedCacheSet(key: string, v: number[]): void {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(key, { v, exp: Date.now() + EMBED_CACHE_TTL_MS });
}

/** 供测试清空 embedding 缓存 */
export function clearEmbeddingCacheForTest(): void {
  embedCache.clear();
}

/**
 * 文本 → 向量。Ollama 走 /api/embeddings，Qwen 走 /embeddings，Gemini 走 embedContent。
 * role 区分查询/文档：nomic-embed-text 需加 search_query:/search_document: 指令前缀，
 * 否则短问题与长文档相似度被压平、区分度下降。
 * 失败（未装 embedding 模型 / 网络异常）时抛错，由调用方降级处理。
 */
export async function callEmbedding(text: string, role?: 'query' | 'document'): Promise<number[]> {
  let input = String(text || '').slice(0, 2000);
  if (!input.trim()) throw new Error('embedding 输入为空');
  if (role && embedModel().startsWith('nomic')) {
    input = `${role === 'query' ? 'search_query' : 'search_document'}: ${input}`;
  }

  const kind = engineKind();

  // 同文本+角色+引擎的向量短 TTL 复用（命中时省去一次模型/网络调用）
  const cacheKey = `${kind}|${role || ''}|${input}`;
  const cached = embedCacheGet(cacheKey);
  if (cached) return cached;

  // P2-4 成本埋点：只记实际发生的网络调用（缓存命中不重复计），token 数引擎不返回记 0
  const embedT0 = Date.now();
  const embedModelName = kind === 'qwen' ? qwenEmbedModel() : kind === 'ollama' ? embedModel() : 'gemini-embedding-001';

  if (kind === 'qwen') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${qwenUrl()}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.QWEN_API_KEY || ''}`,
        },
        signal: controller.signal,
        body: JSON.stringify({ model: qwenEmbedModel(), input }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Qwen embedding error: ${res.status} ${errText}`);
      }
      const json: any = await res.json();
      const emb = json.data?.[0]?.embedding;
      if (!Array.isArray(emb) || emb.length === 0) throw new Error('Qwen 返回空向量');
      embedCacheSet(cacheKey, emb);
      recordUsage({ engine: kind, model: embedModelName, channel: 'embedding', promptTokens: Number(json?.usage?.total_tokens) || 0, completionTokens: 0, durationMs: Date.now() - embedT0, ok: true });
      return emb;
    } finally {
      clearTimeout(timer);
    }
  }

  if (kind === 'ollama') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await withOllamaBackend((base) =>
        fetch(`${base}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ model: embedModel(), prompt: input, keep_alive: '30m' }),
        })
      );
      if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
      const json: any = await res.json();
      const emb = json.embedding;
      if (!Array.isArray(emb) || emb.length === 0) {
        throw new Error('Ollama 返回空向量（请确认已安装 embedding 模型，如 ollama pull nomic-embed-text）');
      }
      embedCacheSet(cacheKey, emb);
      recordUsage({ engine: kind, model: embedModelName, channel: 'embedding', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - embedT0, ok: true });
      return emb;
    } finally {
      clearTimeout(timer);
    }
  }

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const r: any = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: [{ role: 'user', parts: [{ text: input }] }],
  });
  const vals = r?.embeddings?.[0]?.values ?? r?.values;
  if (!Array.isArray(vals) || vals.length === 0) throw new Error('Gemini 返回空向量');
  embedCacheSet(cacheKey, vals);
  recordUsage({ engine: kind, model: embedModelName, channel: 'embedding', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - embedT0, ok: true });
  return vals;
}

// ========== P2-2 embedding 批量化（知识库导入/列裁剪一次请求多段文本） ==========

/** 单批最大文本数（EMBED_BATCH_SIZE 可配，上限 64 防单请求过大） */
const embedBatchSize = () => {
  const n = Number(process.env.EMBED_BATCH_SIZE);
  return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 16;
};

/** Ollama 批量 embedding：/api/embed 原生支持 input 数组；老版本 404/400 时回退逐条 /api/embeddings */
async function ollamaEmbeddingBatch(inputs: string[]): Promise<(number[] | null)[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await withOllamaBackend((base) =>
      fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: embedModel(), input: inputs, keep_alive: '30m' }),
      })
    );
    if (!res.ok) {
      // 老版本 Ollama 无 /api/embed：逐条回退（诚实降级，不丢文本）
      if (res.status === 404 || res.status === 400 || res.status === 405) {
        const out: (number[] | null)[] = [];
        for (const input of inputs) {
          try {
            const r = await withOllamaBackend((base) =>
              fetch(`${base}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ model: embedModel(), prompt: input, keep_alive: '30m' }),
              })
            );
            if (!r.ok) throw new Error(`Ollama embedding error: ${r.status}`);
            const j: any = await r.json();
            out.push(Array.isArray(j?.embedding) && j.embedding.length > 0 ? j.embedding : null);
          } catch {
            out.push(null);
          }
        }
        return out;
      }
      throw new Error(`Ollama batch embedding error: ${res.status}`);
    }
    const json: any = await res.json();
    const embs = json?.embeddings;
    if (!Array.isArray(embs)) throw new Error('Ollama 批量返回缺少 embeddings');
    return inputs.map((_, i) => (Array.isArray(embs[i]) && embs[i].length > 0 ? embs[i] : null));
  } finally {
    clearTimeout(timer);
  }
}

/** Qwen 批量 embedding：OpenAI 兼容协议 input 数组原生支持（按 index 归位防乱序） */
async function qwenEmbeddingBatch(inputs: string[]): Promise<(number[] | null)[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${qwenUrl()}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.QWEN_API_KEY || ''}`,
      },
      signal: controller.signal,
      body: JSON.stringify({ model: qwenEmbedModel(), input: inputs }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Qwen batch embedding error: ${res.status} ${errText}`);
    }
    const json: any = await res.json();
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    const out: (number[] | null)[] = new Array(inputs.length).fill(null);
    data.forEach((d: any, i: number) => {
      const idx = Number.isInteger(d?.index) ? d.index : i;
      if (idx >= 0 && idx < inputs.length && Array.isArray(d?.embedding) && d.embedding.length > 0) {
        out[idx] = d.embedding;
      }
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量文本 → 向量：与 callEmbedding 相同的截断/角色前缀/缓存规则，返回与输入等长数组（失败项为 null）。
 * 缓存命中不进网络；未命中部分按 EMBED_BATCH_SIZE 分批一次请求多段文本，
 * 知识库导入/宽表列裁剪等场景的 embedding 往返次数由 N 降至 ceil(N/batchSize)。
 */
export async function callEmbeddingBatch(texts: string[], role?: 'query' | 'document'): Promise<(number[] | null)[]> {
  const kind = engineKind();
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const misses: { idx: number; input: string; cacheKey: string }[] = [];
  texts.forEach((t, idx) => {
    let input = String(t || '').slice(0, 2000);
    if (!input.trim()) return; // 空输入保持 null（与单条版抛错由调用方降级等效）
    if (role && embedModel().startsWith('nomic')) {
      input = `${role === 'query' ? 'search_query' : 'search_document'}: ${input}`;
    }
    const cacheKey = `${kind}|${role || ''}|${input}`;
    const hit = embedCacheGet(cacheKey);
    if (hit) results[idx] = hit;
    else misses.push({ idx, input, cacheKey });
  });

  const batchSize = embedBatchSize();
  const embedModelName = kind === 'qwen' ? qwenEmbedModel() : kind === 'ollama' ? embedModel() : 'gemini-embedding-001';
  for (let i = 0; i < misses.length; i += batchSize) {
    const slice = misses.slice(i, i + batchSize);
    const t0 = Date.now();
    let vecs: (number[] | null)[];
    if (kind === 'ollama') {
      vecs = await ollamaEmbeddingBatch(slice.map((m) => m.input));
    } else if (kind === 'qwen') {
      vecs = await qwenEmbeddingBatch(slice.map((m) => m.input));
    } else {
      // Gemini：SDK 批量接口契约随版本变动，逐条并发（缓存与返回契约不变）
      vecs = await Promise.all(
        slice.map(async (m) => {
          try {
            return await callEmbedding(m.input);
          } catch {
            return null;
          }
        })
      );
    }
    slice.forEach((m, j) => {
      const v = vecs[j];
      if (Array.isArray(v) && v.length > 0) {
        embedCacheSet(m.cacheKey, v);
        results[m.idx] = v;
      }
    });
    if (kind !== 'gemini') {
      recordUsage({ engine: kind, model: embedModelName, channel: 'embedding', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - t0, ok: vecs.some(Boolean) });
    }
  }
  return results;
}

// ========== P1-2 Token 级流式输出支持 ============

/** SSE event type for streaming chunks（error 帧用于流式过程异常通知前端） */
export interface StreamingChunk {
  type: 'chunk' | 'error';
  content: string;
  done?: boolean;
  error?: string;
}

/**
 * 以纯文本模式调用 LLM，返回 ReadableStream<string>用于 token-by-token 推送
 * 与 callLLMText 的区别：使用 stream=true+ SSE 逐字输出而非等待完整结果
 */
export async function callLLMTextStream(
  system: string, 
  user: string,
  opts?: { model?: string; timeoutMs?: number }
): Promise<ReadableStream<StreamingChunk>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  
  const primary = engineKind();
  const { kind, circuitOpen } = resolveEngineWithFailover(primary);
  
  // 创建 TransformStream 用于构建流式输出
  const transformStream = new TransformStream<StreamingChunk>();
  const writer = transformStream.writable.getWriter();

  if (circuitOpen) {
    writer.write({ type: 'error', content: `LLM 引擎 ${primary} 熔断开路` });
    writer.close();
    return transformStream.readable;
  }

  const timeoutMs = opts?.timeoutMs || (kind === 'ollama' ? ollamaTimeoutMs() : qwenTimeoutMs());
  const modelOverride = opts?.model;
  const usedModel = kind === 'ollama' ? (modelOverride || llmModel()) : kind === 'qwen' ? (modelOverride || qwenModel()) : geminiModel();
  const t0 = Date.now();

  // 统一 AbortController 处理超时
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (kind === 'qwen') {
      // ========== 千问百炼 API 流式处理 ==========
      const res = await fetch(`${qwenUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.QWEN_API_KEY || ''}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: usedModel,
          messages,
          stream: true,  // ← 启用流式输出
          response_format: { type: 'json_object' },  // P0-1 结构化输出约束
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw makeLlmError(`Qwen API error: ${res.status} ${errorText}`, { status: res.status });
      }

      // 解析 SSE 流
      const textDecoder = new TextDecoder();
      const reader = (res.body as any).getReader();
      
      let fullContent = '';
      
      while (true) {
        const { done: doneReading, value } = await reader.read();
        if (doneReading) break;
        
        if (value) {
          const chunkStr = textDecoder.decode(value, { stream: true });
          // SSE 格式：data: {...}\n\n
          const lines = chunkStr.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const jsonStr = line.slice(5).trim();
                if (jsonStr === '[DONE]') {
                  writer.write({ type: 'chunk', content: '', done: true });
                  break;
                }
                
                const parsed = JSON.parse(jsonStr);
                const choices = parsed.choices || [];
                
                if (choices.length > 0) {
                  const delta = choices[0].delta || {};
                  const content = delta.content || '';
                  
                  if (content) {
                    fullContent += content;
                    // 直接推送原始 token（打字机效果）
                    writer.write({ type: 'chunk', content });
                  }
                }
              } catch (e) {
                // 忽略解析错误（可能是截断的 JSON）
              }
            }
          }
        }
      }

      recordUsage({ 
        engine: kind, 
        model: usedModel, 
        channel: 'text_stream', 
        promptTokens: 0, 
        completionTokens: 0, 
        durationMs: Date.now() - t0, 
        ok: true 
      });
      
    } else if (kind === 'ollama') {
      // ========== Ollama API 流式处理（P2-2 多后端：仅初始连接参与故障转移，流式读取不包裹） ==========
      const res = await withOllamaBackend((base) =>
        fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: usedModel,
            messages,
            stream: true,  // ← 启用流式输出
            keep_alive: '30m',
            format: 'json',  // P0-1 结构化输出约束
          }),
        })
      );

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw makeLlmError(`Ollama API error: ${res.status} ${errorText}`, { status: res.status });
      }

      // 解析 SSE 流
      const textDecoder = new TextDecoder();
      const reader = (res.body as any).getReader();
      
      let fullContent = '';
      
      while (true) {
        const { done: doneReading, value } = await reader.read();
        if (doneReading) break;
        
        if (value) {
          const chunkStr = textDecoder.decode(value, { stream: true });
          const lines = chunkStr.split('\n');
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                
                // Ollama SSE 格式：{ "message": { "content": "xxx" }, "done": false }
                if (parsed.message?.content) {
                  const content = parsed.message.content;
                  fullContent += content;
                  // 直接推送原始 token（打字机效果）
                  writer.write({ type: 'chunk', content });
                }
                
                if (parsed.done) {
                  writer.write({ type: 'chunk', content: '', done: true });
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
      }

      recordUsage({ 
        engine: kind, 
        model: usedModel, 
        channel: 'text_stream', 
        promptTokens: 0, 
        completionTokens: 0, 
        durationMs: Date.now() - t0, 
        ok: true 
      });
      
    } else if (kind === 'gemini') {
      // ========== Gemini API 流式处理 ==========
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const response = await ai.models.generateContentStream({
        model: usedModel,
        contents: [{ role: 'user', parts: [{ text: system + '\n\n' + user }] }],
      });

      let fullContent = '';
      
      // 订阅 Stream 事件
      for await (const item of response) {
        if (item.text) {
          const content = item.text;
          fullContent += content;
          writer.write({ type: 'chunk', content });
        }
        
        // 检查是否有结束标志
        if (item.candidates?.[0]?.finishReason) {
          writer.write({ type: 'chunk', content: '', done: true });
          break;
        }
      }

      recordUsage({ 
        engine: kind, 
        model: usedModel, 
        channel: 'text_stream', 
        promptTokens: 0, 
        completionTokens: 0, 
        durationMs: Date.now() - t0, 
        ok: true 
      });
    }
    
    // 正常完成时确保关闭 writer
    if (!writer.closed) {
      await writer.close();
    }
    
  } catch (err) {
    clearTimeout(timer);
    writer.write({ type: 'error', content: err instanceof Error ? err.message : 'Unknown error' });
    writer.close();
    recordUsage({ engine: kind, model: usedModel, channel: 'text_stream', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - t0, ok: false });
    throw err;
  } finally {
    clearTimeout(timer);
    writer.releaseLock();
  }

  return transformStream.readable;
}

/**
 * JSON 模式流式输出：先获取完整结果再转为 chunk 流
 * 注意：这是简化方案，理想情况应直接从 SSE 解析增量 JSON
 */
export async function callLLMJsonStream(
  system: string, 
  user: string,
  history: ChatMessage[] = [],
  opts?: { model?: string; route?: LlmStageRoute }
): Promise<ReadableStream<StreamingChunk>> {
  const fullText = await callLLMJson(system, user, history, opts);
  
  const transformStream = new TransformStream<StreamingChunk>();
  const writer = transformStream.writable.getWriter();
  
  // 分批推送字符（模拟打字机效果）
  const step = 50;
  for (let i = 0; i < fullText.length; i += step) {
    await new Promise(resolve => setTimeout(resolve, 30));
    const chunk = fullText.slice(i, Math.min(i + step, fullText.length));
    writer.write({ type: 'chunk', content: chunk });
  }
  
  writer.write({ type: 'chunk', content: '', done: true });
  writer.close();
  
  return transformStream.readable;
}
