import { describe, expect, it } from 'vitest';
import { bigramCoverage, cosineSimilarity, memoryRelevance } from './similarity';

describe('similarity: 向量与词法打分', () => {
  it('余弦相似度：同向为 1、正交为 0、维度不一致为 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('bigram 覆盖率：包含关系接近 1，无关文本接近 0', () => {
    expect(bigramCoverage('2024年有效客户数', '2024年有效客户数')).toBeCloseTo(1);
    expect(bigramCoverage('2024年有效客户数', '2024年有效客户数量')).toBeGreaterThan(0.7);
    expect(bigramCoverage('2024年有效客户数', '本月订单金额')).toBeLessThan(0.2);
  });

  it('memoryRelevance：向量可用时取 max(cosine, 词法×0.9)', () => {
    // 向量正交但词法完全一致：词法通道仍能救回
    const rel = memoryRelevance('有效客户数', '有效客户数统计', [1, 0], [0, 1]);
    expect(rel).toBeGreaterThan(0.8);
    // 向量高相似：以向量为准
    const rel2 = memoryRelevance('有效客户数', '完全不同的问法', [1, 0], [0.99, 0.01]);
    expect(rel2).toBeGreaterThan(0.9);
  });

  it('memoryRelevance：无向量时退化为纯词法', () => {
    expect(memoryRelevance('有效客户数', '有效客户数', null, null)).toBeCloseTo(1);
  });
});
