/**
 * 统一 LLM 调用通道（Ollama 本地 / Gemini API）。
 * 供查询、报表等端点共享；双阶段（SQL 生成 / 数据分析）均通过 callLLMJson 调用。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.6:latest';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000;
export const USE_OLLAMA = !process.env.GEMINI_API_KEY;

export function llmEngineLabel(): string {
  return USE_OLLAMA ? `Ollama ${LLM_MODEL} @ ${OLLAMA_URL}` : 'Gemini API';
}

async function ollamaChat(messages: ChatMessage[], formatJson = true): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LLM_MODEL,
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
      throw new Error(`Ollama 推理超时（超过 ${Math.round(OLLAMA_TIMEOUT_MS / 1000)} 秒）`, { cause: err });
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
  if (USE_OLLAMA) {
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
    model: 'gemini-3.6-flash',
    contents,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
    },
  });
  return response.text || '{}';
}
