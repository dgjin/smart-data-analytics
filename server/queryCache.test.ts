import { describe, expect, it, vi } from 'vitest';
import { normalizeQuestion, cacheKey, getCachedQuery, setCachedQuery, invalidateQueryCache, getSemanticCachedQuery, semanticCacheThreshold } from './queryCache';
import { callEmbedding } from './llmClient';

// P1-6 L2 语义缓存测试：embedding 走 mock（按归一化文本查表），向量确定性可控
const h = vi.hoisted(() => ({ embedMap: new Map<string, number[]>() }));
vi.mock('./llmClient', () => ({
  callEmbedding: vi.fn(async (text: string) => {
    const v = h.embedMap.get(text);
    if (!v) throw new Error('embedding unavailable');
    return v;
  }),
}));

/** 注册问题 → embedding 向量（键为归一化后文本，与实现一致） */
function registerEmbedding(question: string, vec: number[]) {
  h.embedMap.set(normalizeQuestion(question), vec);
}

describe('queryCache: 问数结果缓存', () => {
  it('normalizeQuestion 忽略空白、标点与大小写差异', () => {
    expect(normalizeQuestion('各客户类型的数量？')).toBe(normalizeQuestion('各客户类型的数量'));
    expect(normalizeQuestion(' 统计 Sales 总额 ')).toBe(normalizeQuestion('统计sales总额'));
  });

  it('cacheKey 包含数据源隔离前缀', () => {
    expect(cacheKey('ds1', '问题')).toBe(`ds1::${normalizeQuestion('问题')}`);
    expect(cacheKey('ds1', '问题')).not.toBe(cacheKey('ds2', '问题'));
  });

  it('cacheKey 支持模型变体（用户自选模型隔离）', () => {
    expect(cacheKey('ds1', '问题', 'ollama:deepseek-r1:32b')).toBe(
      `ds1::${normalizeQuestion('问题')}::ollama:deepseek-r1:32b`
    );
    // 空变体与不传等价（向后兼容）
    expect(cacheKey('ds1', '问题', '')).toBe(cacheKey('ds1', '问题'));
    expect(cacheKey('ds1', '问题', 'a')).not.toBe(cacheKey('ds1', '问题', 'b'));
  });

  it('命中与写入：同键可读取缓存 payload', async () => {
    const key = cacheKey('ds-cache', '本月销售额');
    await setCachedQuery(key, { success: true, result: { x: 1 } });
    const hit = await getCachedQuery(key);
    expect(hit).toBeTruthy();
    expect(hit.result.x).toBe(1);
  });

  it('未写入的键返回 null', async () => {
    expect(await getCachedQuery(cacheKey('ds-cache', '不存在的提问'))).toBeNull();
  });

  it('invalidateQueryCache 按数据源清理', async () => {
    const k1 = cacheKey('ds-a', '问题一');
    const k2 = cacheKey('ds-b', '问题二');
    await setCachedQuery(k1, { success: true });
    await setCachedQuery(k2, { success: true });
    await invalidateQueryCache('ds-a');
    expect(await getCachedQuery(k1)).toBeNull();
    expect(await getCachedQuery(k2)).toBeTruthy();
    await invalidateQueryCache();
    expect(await getCachedQuery(k2)).toBeNull();
  });
});

describe('queryCache: P1-6 L2 语义缓存', () => {
  it('同义改写命中 L2：返回原问题与相似度', async () => {
    registerEmbedding('各机构投放金额汇总', [1, 0, 0]);
    registerEmbedding('各机构的投放金额总和是多少', [0.999, 0.0447, 0]); // cos ≈ 0.999
    await setCachedQuery(cacheKey('ds-sem', '各机构投放金额汇总'), { success: true, rowCount: 7 }, { dataSourceId: 'ds-sem', question: '各机构投放金额汇总' });
    const hit = await getSemanticCachedQuery('ds-sem', '各机构的投放金额总和是多少');
    expect(hit).toBeTruthy();
    expect(hit!.matchedQuestion).toBe('各机构投放金额汇总');
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.85);
    expect(hit!.payload.rowCount).toBe(7);
  });

  it('语义无关问题不命中（无误命中）', async () => {
    registerEmbedding('各机构投放金额汇总', [1, 0, 0]);
    registerEmbedding('今天天气怎么样', [0, 1, 0]); // cos = 0
    await setCachedQuery(cacheKey('ds-sem2', '各机构投放金额汇总'), { success: true }, { dataSourceId: 'ds-sem2', question: '各机构投放金额汇总' });
    expect(await getSemanticCachedQuery('ds-sem2', '今天天气怎么样')).toBeNull();
  });

  it('数据源与模型变体隔离', async () => {
    registerEmbedding('本月销售总额', [1, 0]);
    registerEmbedding('本月销售总金额', [0.999, 0.0447]);
    await setCachedQuery(cacheKey('ds-iso-a', '本月销售总额'), { success: true }, { dataSourceId: 'ds-iso-a', question: '本月销售总额' });
    // 其他数据源不命中
    expect(await getSemanticCachedQuery('ds-iso-b', '本月销售总金额')).toBeNull();
    // 其他模型变体不命中
    expect(await getSemanticCachedQuery('ds-iso-a', '本月销售总金额', 'ollama:qwen')).toBeNull();
    // 同变体命中
    await setCachedQuery(cacheKey('ds-iso-a', '本月销售总额', 'ollama:qwen'), { success: true, tag: 'v' }, { dataSourceId: 'ds-iso-a', question: '本月销售总额', variant: 'ollama:qwen' });
    expect((await getSemanticCachedQuery('ds-iso-a', '本月销售总金额', 'ollama:qwen'))!.payload.tag).toBe('v');
  });

  it('embedding 不可用时静默不命中（fail-open，仅走 L1）', async () => {
    // 未注册向量的问题触发 mock 抛错
    await setCachedQuery(cacheKey('ds-sembad', '正常问题一'), { success: true }, { dataSourceId: 'ds-sembad', question: '正常问题一' });
    expect(await getSemanticCachedQuery('ds-sembad', '未注册向量的问题')).toBeNull();
    expect(vi.mocked(callEmbedding)).toHaveBeenCalled();
  });

  it('过短问题不参与语义缓存（归一化后 <4 字符）', async () => {
    const callsBefore = vi.mocked(callEmbedding).mock.calls.length;
    expect(await getSemanticCachedQuery('ds-sem', '你好')).toBeNull();
    expect(vi.mocked(callEmbedding).mock.calls.length).toBe(callsBefore);
  });

  it('invalidateQueryCache 同时清理语义索引', async () => {
    registerEmbedding('季度利润同比', [1, 0]);
    registerEmbedding('季度利润同比增长', [0.999, 0.0447]);
    await setCachedQuery(cacheKey('ds-seminv', '季度利润同比'), { success: true }, { dataSourceId: 'ds-seminv', question: '季度利润同比' });
    expect(await getSemanticCachedQuery('ds-seminv', '季度利润同比增长')).toBeTruthy();
    await invalidateQueryCache('ds-seminv');
    expect(await getSemanticCachedQuery('ds-seminv', '季度利润同比增长')).toBeNull();
  });

  it('不传 semantic 参数时不建索引（向后兼容）', async () => {
    const callsBefore = vi.mocked(callEmbedding).mock.calls.length;
    await setCachedQuery(cacheKey('ds-plain', '普通问题一二三'), { success: true });
    expect(vi.mocked(callEmbedding).mock.calls.length).toBe(callsBefore);
  });

  it('语义阈值默认 0.85（实测标定：同义 0.85~0.97 / 无关 ≤0.68，安全边距 0.17）', () => {
    delete process.env.SEMANTIC_CACHE_THRESHOLD;
    expect(semanticCacheThreshold()).toBe(0.85);
  });
});
