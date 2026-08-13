import { describe, expect, it } from 'vitest';
import { validateModelSelection } from './llmClient';

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
