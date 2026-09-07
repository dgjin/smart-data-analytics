/**
 * embedding 统一调用通道（Ollama 本地 / 通义千问百炼）：短 TTL 缓存 + 单条 + 批量。
 * 供语义缓存、知识库检索、圈表精排共享；未装 embedding 模型时调用方降级关键词检索。
 */
import { engineKind, qwenUrl, recordUsage } from './llmClient';
import { withOllamaBackend } from './ollamaBackends';

/** OpenAI 兼容 embedding 响应（Qwen 单条/批量） */
interface OpenAiEmbedResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { total_tokens?: number };
}
/** Ollama embedding 响应（/api/embeddings 单条 embedding；/api/embed 批量 embeddings） */
interface OllamaEmbedResponse {
  embedding?: number[];
  embeddings?: number[][];
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
      const json = (await res.json()) as OpenAiEmbedResponse;
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
      const json = (await res.json()) as OllamaEmbedResponse;
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
  const r = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: [{ role: 'user', parts: [{ text: input }] }],
  });
  // SDK 类型仅含 embeddings；r.values 为老版响应的防御性兑底（受控断言，不扩散 any）
  const vals = r?.embeddings?.[0]?.values ?? (r as { values?: number[] })?.values;
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
            const j = (await r.json()) as OllamaEmbedResponse;
            out.push(Array.isArray(j?.embedding) && j.embedding.length > 0 ? j.embedding : null);
          } catch {
            out.push(null);
          }
        }
        return out;
      }
      throw new Error(`Ollama batch embedding error: ${res.status}`);
    }
    const json = (await res.json()) as OllamaEmbedResponse;
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
    const json = (await res.json()) as OpenAiEmbedResponse;
    const data = Array.isArray(json?.data) ? json.data : [];
    const out: (number[] | null)[] = new Array(inputs.length).fill(null);
    data.forEach((d, i) => {
      const idx = Number.isInteger(d?.index) ? d.index! : i;
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

