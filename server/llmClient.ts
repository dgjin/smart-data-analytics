/**
 * 统一 LLM 调用通道（Ollama 本地 / Gemini API / 通义千问百炼）。
 * 供查询、报表等端点共享；双阶段（SQL 生成 / 数据分析）均通过 callLLMJson 调用。
 * 引擎选择优先级：请求级覆盖（setLlmOverride，用户自选模型）>
 * 阶段级路由（callLLMJson opts.route，如 SQL 生成快速模型 P1-2）>
 * AI_ENGINE 显式指定（ollama/gemini/qwen）> 按密钥存在性自动（gemini/qwen）> ollama。
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 惰性读取环境变量（ESM import 提升会使模块级读取早于 dotenv.config()，同 auth.ts/db.ts 先例）
const llmModel = () => overrideModel('ollama') || process.env.LLM_MODEL || 'deepseek-r1:32b';
const ollamaUrl = () => process.env.OLLAMA_URL || 'http://localhost:11434';
const ollamaTimeoutMs = () => Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000;
// 通义千问（百炼 OpenAI 兼容协议）；Coding Plan（sk-sp-）需将 QWEN_URL 指向
// https://coding.dashscope.aliyuncs.com/v1，普通按量 Key 用默认端点即可
const qwenUrl = () => process.env.QWEN_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const qwenModel = () => overrideModel('qwen') || process.env.QWEN_MODEL || 'qwen3.8-max';
const qwenTimeoutMs = () => Number(process.env.QWEN_TIMEOUT_MS) || 180_000;
const GEMINI_MODEL = 'gemini-3.6-flash';
const geminiModel = () => overrideModel('gemini') || GEMINI_MODEL;

type EngineKind = 'ollama' | 'gemini' | 'qwen';

/** 阶段级模型路由（P1-2）：调用方可为单次调用指定引擎/模型（如 SQL 生成用快速小模型） */
export interface LlmStageRoute {
  engine: EngineKind;
  model: string;
}

/**
 * 阶段级模型路由通用解析：环境变量指定引擎+模型均合法时启用（结构化任务用快速小模型更快更稳）。
 */
function stageRouteFromEnv(engineVar: string, modelVar: string): LlmStageRoute | null {
  const engine = String(process.env[engineVar] || '').toLowerCase();
  const model = String(process.env[modelVar] || '').trim();
  if (engine !== 'ollama' && engine !== 'gemini' && engine !== 'qwen') return null;
  if (!model || model.length > 100 || !/^[\w.:\-]+$/.test(model)) return null;
  return { engine: engine as EngineKind, model };
}

/**
 * SQL 生成阶段的快速模型路由（P1-2）：LLM_SQL_ENGINE + LLM_SQL_MODEL 均配置且合法时启用。
 * 作用于阶段一与复杂度评估（结构化输出任务小模型更快更稳）；阶段二解读默认仍用主模型。
 */
export function sqlStageRoute(): LlmStageRoute | null {
  return stageRouteFromEnv('LLM_SQL_ENGINE', 'LLM_SQL_MODEL');
}

/**
 * 阶段二数据解读的快速模型路由：LLM_ANALYSIS_ENGINE + LLM_ANALYSIS_MODEL 均配置时启用。
 * 解读是问数链路最大耗时项，配置快速模型可大幅提速（质量取舍由部署方决定）。
 */
export function analysisStageRoute(): LlmStageRoute | null {
  return stageRouteFromEnv('LLM_ANALYSIS_ENGINE', 'LLM_ANALYSIS_MODEL');
}

/** 请求级引擎/模型覆盖（用户自选模型）：随异步上下文传递，避免逐层透传参数 */
export interface LlmOverride {
  engine?: EngineKind;
  model?: string;
}
const overrideStore = new AsyncLocalStorage<LlmOverride>();

/** 在当前请求上下文内设置引擎/模型覆盖（enterWith：覆盖本次请求异步链，Express 每请求独立上下文不会互串） */
export function setLlmOverride(override: LlmOverride): void {
  overrideStore.enterWith(override);
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
  return `Ollama ${llmModel()} @ ${ollamaUrl()}`;
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
  if (typeof model !== 'string' || !model.trim() || model.length > 100 || !/^[\w.:\-]+$/.test(model)) {
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

  // Ollama 本地已安装模型（3s 超时，不可达时仅列配置模型）
  let ollamaModels: string[] = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: controller.signal });
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

/** 通义千问 OpenAI 兼容通道（百炼按量 / Coding Plan 均适用，端点由 QWEN_URL 决定） */
async function qwenChat(messages: ChatMessage[], formatJson = true, modelOverride?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), qwenTimeoutMs());

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
      throw new Error(`Qwen API error: ${res.status} ${text}`);
    }

    const json: any = await res.json();
    return json.choices?.[0]?.message?.content || '';
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Qwen 推理超时（超过 ${Math.round(qwenTimeoutMs() / 1000)} 秒）`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaChat(messages: ChatMessage[], formatJson = true, modelOverride?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ollamaTimeoutMs());

  try {
    const res = await fetch(`${ollamaUrl()}/api/chat`, {
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
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama API error: ${res.status} ${text}`);
    }

    const json: any = await res.json();
    return json.message?.content || '';
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Ollama 推理超时（超过 ${Math.round(ollamaTimeoutMs() / 1000)} 秒）`, { cause: err });
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
  const kind: EngineKind = route ? route.engine : engineKind();
  if (kind === 'ollama') return ollamaChat(messages, true, route?.model);
  if (kind === 'qwen') return qwenChat(messages, true, route?.model);

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
    model: route?.model || geminiModel(),
    contents,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
    },
  });
  return response.text || '{}';
}

/**
 * 以纯文本模式调用 LLM（SQL 解释/优化建议等非结构化输出场景）。
 * 与 callLLMJson 的区别仅是不要求 JSON 输出格式。
 */
export async function callLLMText(system: string, user: string): Promise<string> {
  const kind = engineKind();
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
  return response.text || '';
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
      return emb;
    } finally {
      clearTimeout(timer);
    }
  }

  if (kind === 'ollama') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${ollamaUrl()}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: embedModel(), prompt: input, keep_alive: '30m' }),
      });
      if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
      const json: any = await res.json();
      const emb = json.embedding;
      if (!Array.isArray(emb) || emb.length === 0) {
        throw new Error('Ollama 返回空向量（请确认已安装 embedding 模型，如 ollama pull nomic-embed-text）');
      }
      embedCacheSet(cacheKey, emb);
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
  return vals;
}
