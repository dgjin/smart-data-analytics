import { describe, expect, it, afterEach, vi } from 'vitest';
import { validateModelSelection, sqlStageRoute, callLLMJson } from './llmClient';

/**
 * 模型自选校验（validateModelSelection）测试
 * 覆盖：未提供 / 非法引擎 / 非法模型名 / 合法组合
 */
describe('validateModelSelection', () => {
  it('未提供引擎时返回 null（跟随服务端默认）', () => {
    expect(validateModelSelection(undefined, undefined)).toBeNull();
    expect(validateModelSelection(null, null)).toBeNull();
    expect(validateModelSelection('', '')).toBeNull();
  });

  it('拒绝不支持的引擎', () => {
    const r = validateModelSelection('foo', 'x');
    expect(r).not.toBeNull();
    expect(r && 'error' in r ? r.error : '').toBe('不支持的模型引擎');
    // 非字符串类型同样拒绝
    const r2 = validateModelSelection(123, 'x');
    expect(r2 && 'error' in r2 ? r2.error : '').toBe('不支持的模型引擎');
  });

  it('拒绝不合法的模型名称', () => {
    for (const bad of ['', '   ', 'bad name!', 'a'.repeat(101), undefined]) {
      const r = validateModelSelection('ollama', bad);
      expect(r).not.toBeNull();
      expect(r && 'error' in r ? r.error : '').toBe('模型名称不合法');
    }
  });

  it('接受合法的引擎与模型组合', () => {
    const a = validateModelSelection('ollama', 'deepseek-r1:32b');
    expect(a).toEqual({ engine: 'ollama', model: 'deepseek-r1:32b' });

    const b = validateModelSelection('qwen', 'qwen3.8-max');
    expect(b).toEqual({ engine: 'qwen', model: 'qwen3.8-max' });

    const c = validateModelSelection('gemini', 'gemini-2.5-flash');
    expect(c).toEqual({ engine: 'gemini', model: 'gemini-2.5-flash' });
  });
});

/**
 * P1-2 快速模型路由（sqlStageRoute + callLLMJson opts.route）
 */
describe('sqlStageRoute: SQL 生成阶段快速模型配置', () => {
  afterEach(() => {
    delete process.env.LLM_SQL_ENGINE;
    delete process.env.LLM_SQL_MODEL;
  });

  it('未配置时返回 undefined（保持主模型行为不变）', () => {
    expect(sqlStageRoute()).toBeUndefined();
    process.env.LLM_SQL_ENGINE = 'ollama';
    expect(sqlStageRoute()).toBeUndefined(); // 缺 model
  });

  it('非法引擎或模型名拒绝', () => {
    process.env.LLM_SQL_ENGINE = 'foo';
    process.env.LLM_SQL_MODEL = 'm';
    expect(sqlStageRoute()).toBeUndefined();
    process.env.LLM_SQL_ENGINE = 'ollama';
    process.env.LLM_SQL_MODEL = 'bad name!';
    expect(sqlStageRoute()).toBeUndefined();
  });

  it('合法配置返回引擎与模型', () => {
    process.env.LLM_SQL_ENGINE = 'ollama';
    process.env.LLM_SQL_MODEL = 'qwen2.5-coder:7b';
    expect(sqlStageRoute()).toEqual({ engine: 'ollama', model: 'qwen2.5-coder:7b' });
    process.env.LLM_SQL_ENGINE = 'QWEN'; // 大小写不敏感
    process.env.LLM_SQL_MODEL = 'qwen-turbo';
    expect(sqlStageRoute()).toEqual({ engine: 'qwen', model: 'qwen-turbo' });
  });
});

describe('callLLMJson: 阶段路由分发到指定模型', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_ENGINE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.QWEN_API_KEY;
    delete process.env.LLM_MODEL;
  });

  function stubOllama() {
    const captured: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      captured.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ message: { content: '{"sql":"SELECT 1"}' } }), text: async () => '' };
    }));
    return captured;
  }

  it('route 指定 ollama 小模型时请求体使用阶段模型', async () => {
    delete process.env.AI_ENGINE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.QWEN_API_KEY;
    process.env.LLM_MODEL = 'deepseek-r1:32b';
    const captured = stubOllama();
    await callLLMJson('sys', 'q', [], { route: { engine: 'ollama', model: 'fast-sql:7b' } });
    expect(captured[0].model).toBe('fast-sql:7b');
  });

  it('无 route 时使用主模型（行为不变）', async () => {
    delete process.env.AI_ENGINE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.QWEN_API_KEY;
    process.env.LLM_MODEL = 'deepseek-r1:32b';
    const captured = stubOllama();
    await callLLMJson('sys', 'q');
    expect(captured[0].model).toBe('deepseek-r1:32b');
  });

  it('route 指定 qwen 时走 qwen 通道并使用阶段模型', async () => {
    delete process.env.AI_ENGINE;
    delete process.env.GEMINI_API_KEY;
    process.env.QWEN_API_KEY = 'sk-test';
    const captured: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"sql":"SELECT 1"}' } }] }), text: async () => '' };
    }));
    await callLLMJson('sys', 'q', [], { route: { engine: 'qwen', model: 'qwen-turbo' } });
    expect(captured[0].url).toContain('/chat/completions');
    expect(captured[0].body.model).toBe('qwen-turbo');
  });
});
