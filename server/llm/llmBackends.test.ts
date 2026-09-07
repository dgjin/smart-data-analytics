import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  callLLMJson,
  callEmbeddingBatch,
  clearEmbeddingCacheForTest,
  getOllamaBackendStates,
  pickOllamaBackend,
  probeOllamaBackend,
  resetLlmResilienceForTest,
  resetOllamaBackendsForTest,
  startOllamaHealthChecks,
} from './llmClient';

/**
 * P2-2 LLM 多后端路由（OLLAMA_URLS）与 embedding 批量化测试。
 * 全部经 vi.stubGlobal('fetch') 打桩，不发起真实网络请求。
 */

const HOST_A = 'http://ollama-a:11434';
const HOST_B = 'http://ollama-b:11434';

function cleanEnv() {
  delete process.env.AI_ENGINE;
  delete process.env.GEMINI_API_KEY;
  delete process.env.QWEN_API_KEY;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_URLS;
  delete process.env.LLM_MODEL;
  delete process.env.EMBED_MODEL;
  delete process.env.EMBED_BATCH_SIZE;
}

beforeEach(() => {
  cleanEnv();
  resetLlmResilienceForTest();
  resetOllamaBackendsForTest();
  clearEmbeddingCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanEnv();
  resetLlmResilienceForTest();
  resetOllamaBackendsForTest();
  clearEmbeddingCacheForTest();
});

describe('Ollama 多后端：配置解析', () => {
  it('OLLAMA_URLS 逗号分隔多后端（去空白/尾斜杠/去重）', () => {
    process.env.OLLAMA_URLS = ` ${HOST_A}/ , ${HOST_B} ,${HOST_A}`;
    const states = getOllamaBackendStates();
    expect(states.map((b) => b.url)).toEqual([HOST_A, HOST_B]);
    expect(states.every((b) => b.inflight === 0 && b.downUntil === 0)).toBe(true);
  });

  it('未配置 OLLAMA_URLS 时回退 OLLAMA_URL 单后端', () => {
    process.env.OLLAMA_URL = 'http://single:11434/';
    const states = getOllamaBackendStates();
    expect(states.map((b) => b.url)).toEqual(['http://single:11434']);
  });
});

describe('Ollama 多后端：最少并发路由与剔除', () => {
  it('pickOllamaBackend 选取 inflight 最小的健康节点', () => {
    process.env.OLLAMA_URLS = `${HOST_A},${HOST_B}`;
    const a = pickOllamaBackend()!;
    a.inflight = 3; // 模拟 A 在途 3 个请求
    expect(pickOllamaBackend()!.url).toBe(HOST_B);
  });

  it('失败节点被摘除后不再被选中，全部摘除时兜底最早恢复节点（不拒绝服务）', () => {
    process.env.OLLAMA_URLS = `${HOST_A},${HOST_B}`;
    const a = pickOllamaBackend()!;
    a.downUntil = Date.now() + 60_000;
    expect(pickOllamaBackend()!.url).toBe(HOST_B);
    // 全部摘除：仍返回节点（最早恢复者），尽力服务
    pickOllamaBackend()!.downUntil = Date.now() + 30_000;
    const fallback = pickOllamaBackend()!;
    expect(fallback.url).toBe(HOST_B);
  });
});

describe('Ollama 多后端：故障转移（问数不中断）', () => {
  it('首选后端连接失败时自动切换次优后端完成调用', async () => {
    process.env.OLLAMA_URLS = `${HOST_A},${HOST_B}`;
    process.env.LLM_MODEL = 'm1';
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      seen.push(u);
      if (u.startsWith(HOST_A)) throw new Error('connect ECONNREFUSED');
      return { ok: true, json: async () => ({ message: { content: '{"sql":"SELECT 1"}' } }), text: async () => '' };
    }));

    const text = await callLLMJson('sys', 'q');
    expect(text).toBe('{"sql":"SELECT 1"}');
    expect(seen.some((u) => u.startsWith(HOST_A))).toBe(true);
    expect(seen.some((u) => u.startsWith(`${HOST_B}/api/chat`))).toBe(true);
    // A 已被摘除（downUntil 在未来）
    const a = getOllamaBackendStates().find((b) => b.url === HOST_A)!;
    expect(a.downUntil).toBeGreaterThan(Date.now());
  });

  it('健康检查探测恢复被摘除的后端', async () => {
    process.env.OLLAMA_URLS = `${HOST_A},${HOST_B}`;
    const a = pickOllamaBackend()!;
    a.downUntil = Date.now() + 60_000; // 模拟 A 被摘除
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url) === `${HOST_A}/api/tags`) return { ok: true, json: async () => ({ models: [] }) };
      throw new Error('unexpected');
    }));
    expect(await probeOllamaBackend(HOST_A)).toBe(true);
    startOllamaHealthChecks(20);
    await vi.waitFor(() => {
      expect(getOllamaBackendStates().find((b) => b.url === HOST_A)!.downUntil).toBe(0);
    }, { timeout: 2000 });
  });
});

describe('embedding 批量化（callEmbeddingBatch）', () => {
  function stubOllamaEmbed(captured: { url: string; body: any }[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      captured.push({ url: u, body });
      if (u.endsWith('/api/embed')) {
        const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
        return { ok: true, json: async () => ({ embeddings: inputs.map((_t, i) => [i + 1, 0.5]) }), text: async () => '' };
      }
      throw new Error(`unexpected url: ${u}`);
    }));
  }

  it('多段文本一次请求（/api/embed input 数组），返回等长向量数组', async () => {
    const captured: { url: string; body: any }[] = [];
    stubOllamaEmbed(captured);
    const vecs = await callEmbeddingBatch(['表A 机构', '表B 金额', '表C 日期'], 'document');
    expect(vecs).toHaveLength(3);
    expect(vecs[0]).toEqual([1, 0.5]);
    expect(vecs[2]).toEqual([3, 0.5]);
    // 仅一次网络请求，且 input 为 3 段文本
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/api/embed');
    expect(captured[0].body.input).toHaveLength(3);
    // nomic 角色前缀保持与单条版一致
    expect(captured[0].body.input[0]).toMatch(/^search_document: /);
  });

  it('缓存命中的文本不再进网络；空文本返回 null 且不请求', async () => {
    const captured: { url: string; body: any }[] = [];
    stubOllamaEmbed(captured);
    await callEmbeddingBatch(['同一段文本'], 'document');
    expect(captured).toHaveLength(1);
    captured.length = 0;
    const vecs = await callEmbeddingBatch(['同一段文本', '   '], 'document');
    expect(vecs[0]).toEqual([1, 0.5]); // 缓存命中
    expect(vecs[1]).toBeNull(); // 空文本
    expect(captured).toHaveLength(0); // 无网络请求
  });

  it('EMBED_BATCH_SIZE 控制单批大小（3 段文本上限 2 → 2 次请求）', async () => {
    process.env.EMBED_BATCH_SIZE = '2';
    const captured: { url: string; body: any }[] = [];
    stubOllamaEmbed(captured);
    const vecs = await callEmbeddingBatch(['a', 'b', 'c'], 'document');
    expect(vecs.every((v) => Array.isArray(v))).toBe(true);
    const batchCalls = captured.filter((c) => c.url.endsWith('/api/embed'));
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0].body.input).toHaveLength(2);
    expect(batchCalls[1].body.input).toHaveLength(1);
  });

  it('老版本 Ollama 无 /api/embed（404）时回退逐条 /api/embeddings', async () => {
    const captured: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      captured.push({ url: u, body });
      if (u.endsWith('/api/embed')) return { ok: false, status: 404, text: async (): Promise<string> => 'not found' };
      if (u.endsWith('/api/embeddings')) return { ok: true, json: async () => ({ embedding: [9, 9] }), text: async (): Promise<string> => '' };
      throw new Error(`unexpected url: ${u}`);
    }));
    const vecs = await callEmbeddingBatch(['x', 'y'], 'document');
    expect(vecs).toEqual([[9, 9], [9, 9]]);
    expect(captured.filter((c) => c.url.endsWith('/api/embeddings'))).toHaveLength(2);
  });

  it('批量请求在多后端下走最少并发节点', async () => {
    process.env.OLLAMA_URLS = `${HOST_A},${HOST_B}`;
    const a = pickOllamaBackend()!;
    a.inflight = 2; // A 繁忙
    const captured: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      captured.push(u);
      const body = init?.body ? JSON.parse(init.body) : {};
      const inputs: string[] = Array.isArray(body.input) ? body.input : [];
      return { ok: true, json: async () => ({ embeddings: inputs.map(() => [1]) }), text: async () => '' };
    }));
    const vecs = await callEmbeddingBatch(['t1', 't2'], 'document');
    expect(vecs).toEqual([[1], [1]]);
    expect(captured.every((u) => u.startsWith(HOST_B))).toBe(true);
  });
});
