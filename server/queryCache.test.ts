import { describe, expect, it } from 'vitest';
import { normalizeQuestion, cacheKey, getCachedQuery, setCachedQuery, invalidateQueryCache } from './queryCache';

describe('queryCache: 问数结果缓存', () => {
  it('normalizeQuestion 忽略空白、标点与大小写差异', () => {
    expect(normalizeQuestion('各客户类型的数量？')).toBe(normalizeQuestion('各客户类型的数量'));
    expect(normalizeQuestion(' 统计 Sales 总额 ')).toBe(normalizeQuestion('统计sales总额'));
  });

  it('cacheKey 包含数据源隔离前缀', () => {
    expect(cacheKey('ds1', '问题')).toBe(`ds1::${normalizeQuestion('问题')}`);
    expect(cacheKey('ds1', '问题')).not.toBe(cacheKey('ds2', '问题'));
  });

  it('命中与写入：同键可读取缓存 payload', () => {
    const key = cacheKey('ds-cache', '本月销售额');
    setCachedQuery(key, { success: true, result: { x: 1 } });
    const hit = getCachedQuery(key);
    expect(hit).toBeTruthy();
    expect(hit.result.x).toBe(1);
  });

  it('未写入的键返回 null', () => {
    expect(getCachedQuery(cacheKey('ds-cache', '不存在的提问'))).toBeNull();
  });

  it('invalidateQueryCache 按数据源清理', () => {
    const k1 = cacheKey('ds-a', '问题一');
    const k2 = cacheKey('ds-b', '问题二');
    setCachedQuery(k1, { success: true });
    setCachedQuery(k2, { success: true });
    invalidateQueryCache('ds-a');
    expect(getCachedQuery(k1)).toBeNull();
    expect(getCachedQuery(k2)).toBeTruthy();
    invalidateQueryCache();
    expect(getCachedQuery(k2)).toBeNull();
  });
});
