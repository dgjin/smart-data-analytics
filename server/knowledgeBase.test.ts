import { describe, expect, it } from 'vitest';
import { chunkText, cosineSimilarity, rankChunks, formatKnowledgeSnippets, KnowledgeChunk } from './knowledgeBase';

describe('chunkText: 段落切块', () => {
  it('空文本返回空数组', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('短文本返回单块', () => {
    expect(chunkText('不良率 = 不良贷款余额 / 贷款总余额')).toHaveLength(1);
  });

  it('多段落超长文本切成多块', () => {
    const para = '客户分层规则说明。'.repeat(60); // 约 540 字
    const chunks = chunkText(`${para}\n${para}`, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });
});

describe('cosineSimilarity: 余弦相似度', () => {
  it('相同向量相似度为 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });
  it('正交向量相似度为 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it('维度不一致返回 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
  it('零向量返回 0', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe('rankChunks: 检索排序', () => {
  const mk = (title: string, text: string, embedding: number[] | null): KnowledgeChunk => ({ title, text, embedding });

  it('有向量时按余弦相似度排序', () => {
    const chunks = [
      mk('A', '无关', [0, 1]),
      mk('B', '相关', [1, 0]),
    ];
    const out = rankChunks('问题', chunks, [1, 0], 3);
    expect(out[0].title).toBe('B');
  });

  it('无问题向量时降级为关键词检索', () => {
    const chunks = [
      mk('贷款', '不良贷款余额口径说明', null),
      mk('存款', '存款利率说明', null),
    ];
    const out = rankChunks('不良贷款余额是多少', chunks, null, 3);
    expect(out[0].title).toBe('贷款');
  });

  it('过滤无相关性的片段', () => {
    const chunks = [mk('完全无关', 'xyz', null)];
    const out = rankChunks('不良贷款', chunks, null, 3);
    expect(out).toHaveLength(0);
  });

  it('topK 截断', () => {
    const chunks = [mk('a', '不良贷款', null), mk('b', '不良贷款余额', null), mk('c', '不良率贷款', null)];
    const out = rankChunks('不良贷款', chunks, null, 2);
    expect(out).toHaveLength(2);
  });

  it('同一文档最多入选 maxPerDoc 块，剩余槽位让给其他文档', () => {
    const chunks = [
      mk('大字典', '不良贷款余额口径一', [1, 0]),
      mk('大字典', '不良贷款余额口径二', [0.98, 0.01]),
      mk('大字典', '不良贷款余额口径三', [0.96, 0.02]),
      mk('口径指南', '不良贷款余额判断标准', [0.9, 0.05]),
    ];
    const out = rankChunks('不良贷款余额', chunks, [1, 0], 4, 2);
    expect(out).toHaveLength(3);
    expect(out.filter((c) => c.title === '大字典')).toHaveLength(2);
    expect(out.some((c) => c.title === '口径指南')).toBe(true);
  });
  it('口径/指南类文档保留槽位：字典相似度更高时仍能注入', () => {
    const chunks = [
      mk('字段字典A', '长龄业务字段说明', [1, 0]),
      mk('字段字典B', '长龄业务配置明细', [0.99, 0.01]),
      mk('字段字典C', '长龄业务分类关系', [0.98, 0.02]),
      mk('高频指标口径速查', '长龄业务判断标准', [0.85, 0.1]),
    ];
    const out = rankChunks('长龄业务的判断标准是什么', chunks, [1, 0]);
    expect(out.some((c) => c.title === '高频指标口径速查')).toBe(true);
  });

  it('reserveGuided=false 时不做保留，纯按分数取 topK', () => {
    const chunks = [
      mk('字段字典A', '长龄业务字段说明', [1, 0]),
      mk('字段字典B', '长龄业务配置明细', [0.99, 0.01]),
      mk('高频指标口径速查', '长龄业务判断标准', [0.85, 0.1]),
    ];
    const out = rankChunks('长龄业务', chunks, [1, 0], 2, 2, false);
    expect(out.map((c) => c.title)).toEqual(['字段字典A', '字段字典B']);
  });

  it('保留槽位选块用混合打分：词法匹配更好的块优先于向量分略高的块', () => {
    const chunks = [
      mk('高频指标口径速查', '风险项目口径说明', [0.99, 0.01]),
      mk('高频指标口径速查', '长龄业务判断标准', [0.95, 0.05]),
    ];
    const out = rankChunks('长龄业务的判断标准是什么', chunks, [1, 0], 1);
    expect(out[0].text).toBe('长龄业务判断标准');
  });
});

describe('formatKnowledgeSnippets: prompt 注入块', () => {
  it('空数组返回空串', () => {
    expect(formatKnowledgeSnippets([])).toBe('');
  });
  it('包含标题与压缩后的正文', () => {
    const out = formatKnowledgeSnippets([{ title: '口径', text: '不良率  =  不良余额 / 总余额', embedding: null }]);
    expect(out).toContain('[口径]');
    expect(out).toContain('不良率 = 不良余额 / 总余额');
    expect(out).toContain('相关业务知识');
  });
});
