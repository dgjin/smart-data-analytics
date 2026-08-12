/**
 * 统一 LLM 调用通道（Ollama 本地 / Gemini API）。
 * 供查询、报表等端点共享；双阶段（SQL 生成 / 数据分析）均通过 callLLMJson 调用。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 惰性读取环境变量（ESM import 提升会使模块级读取早于 dotenv.config()，同 auth.ts/db.ts 先例）
const llmModel = () => process.env.LLM_MODEL || 'qwen3.6:latest';
const ollamaUrl = () => process.env.OLLAMA_URL || 'http://localhost:11434';
const ollamaTimeoutMs = () => Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000;
const isOllama = () => !process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.6-flash';

export function llmEngineLabel(): string {
  return isOllama() ? `Ollama ${llmModel()} @ ${ollamaUrl()}` : 'Gemini API';
}

export interface LlmEngineInfo {
  engine: 'ollama' | 'gemini';
  model: string;
  /** 前端展示标签（不含内网地址） */
  label: string;
}

/** 供前端按实际使用的模型展示提示信息 */
export function llmEngineInfo(): LlmEngineInfo {
  return isOllama()
    ? { engine: 'ollama', model: llmModel(), label: `Ollama ${llmModel()}` }
    : { engine: 'gemini', model: GEMINI_MODEL, label: `Gemini ${GEMINI_MODEL}` };
}

async function ollamaChat(messages: ChatMessage[], formatJson = true): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ollamaTimeoutMs());

  try {
    const res = await fetch(`${ollamaUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: llmModel(),
        messages,
        stream: false,
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
 */
export async function callLLMJson(system: string, user: string, history: ChatMessage[] = []): Promise<string> {
  if (isOllama()) {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: user },
    ];
    return ollamaChat(messages, true);
  }

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
    model: GEMINI_MODEL,
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
  if (isOllama()) {
    return ollamaChat(
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
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: user }] }],
    config: { systemInstruction: system },
  });
  return response.text || '';
}

// embedding 模型（Ollama 需已 pull，如 nomic-embed-text；未装时调用方降级为关键词检索）
const embedModel = () => process.env.EMBED_MODEL || 'nomic-embed-text';

/**
 * 文本 → 向量。Ollama 走 /api/embeddings，Gemini 走 embedContent。
 * 失败（未装 embedding 模型 / 网络异常）时抛错，由调用方降级处理。
 */
export async function callEmbedding(text: string): Promise<number[]> {
  const input = String(text || '').slice(0, 2000);
  if (!input.trim()) throw new Error('embedding 输入为空');

  if (isOllama()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${ollamaUrl()}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: embedModel(), prompt: input }),
      });
      if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
      const json: any = await res.json();
      const emb = json.embedding;
      if (!Array.isArray(emb) || emb.length === 0) {
        throw new Error('Ollama 返回空向量（请确认已安装 embedding 模型，如 ollama pull nomic-embed-text）');
      }
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
  return vals;
}
