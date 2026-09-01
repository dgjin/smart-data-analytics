import { describe, expect, it } from 'vitest';
import { chunkText, cosineSimilarity, rankChunks, formatKnowledgeSnippets, KnowledgeChunk, TOP_K_CHUNKS, GUIDED_DOC_KEYWORDS, knowledgeMinScore } from './knowledgeBase';

describe('formatKnowledgeSnippets: v0.4.15 强指令升级', () => {
  it('注入「必须遵循」强指令，明确约束口径/枚举，不放开表列白名单', () => {
    const out = formatKnowledgeSnippets([
      { title: '高频指标口径速查', text: '不良率 = 不良贷款余额 / 贷款总余额', embedding: null },
    ]);
    expect(out).toContain('**必须遵循**');
    expect(out).not.toContain('参考'); // 旧弱指令措辞消失
    expect(out).toContain('禁止自行编造口径');
    expect(out).toContain('表与列仍必须逐字来自 Schema');
  });
});

describe('knowledgeMinScore: v0.4.15 相关性阈值配置', () => {
  it('env 未配置默认返回 0.35', () => {
    delete process.env.KNOWLEDGE_MIN_SCORE;
    expect(knowledgeMinScore()).toBe(0.35);
  });

  it('env 合法数值优先返回', () => {
    process.env.KNOWLEDGE_MIN_SCORE = '0.2';
    expect(knowledgeMinScore()).toBeCloseTo(0.2);
    delete process.env.KNOWLEDGE_MIN_SCORE;
  });

  it('非法值（负数/非数字）回退默认 0.35', () => {
    process.env.KNOWLEDGE_MIN_SCORE = '-1';
    expect(knowledgeMinScore()).toBe(0.35);
    process.env.KNOWLEDGE_MIN_SCORE = 'abc';
    expect(knowledgeMinScore()).toBe(0.35);
    delete process.env.KNOWLEDGE_MIN_SCORE;
  });
});

describe('rankChunks: v0.4.15 topK 扩容与相关性阈值', () => {
  const mk = (title: string, text: string, embedding: number[]): KnowledgeChunk => ({
    title,
    text,
    embedding,
  });

  it('v0.4.15：topK 从 4 扩容至 6（提升口径命中率）', () => {
    const chunks = Array.from({ length: 6 }, (_, i) => mk(`doc${i + 1}`, `内容${i + 1}`, [0.9 - i * 0.02, 0]));
    const out = rankChunks('问题', chunks, [1, 0]);
    expect(out.length).toBe(6); // 全量返回，不再硬截断在 4
  });

  it('v0.4.15：向量相似度低于阈值（默认 0.35）的片段被过滤（无关问题无注入）', () => {
    // 构造真实 embedding：相关块与 query 夹角小 → cos≈0.8；无关块夹角大 → cos≈0.15/0.2
    const q = [1, 0];
    const chunks = [
      mk('口径速查', '长龄业务判断标准', [0.89, 0.05]), // cos≈0.8
      mk('无关字典', 'xyz 字段说明', [0.15, 0.85]),       // cos≈0.16
      mk('另一无关', 'abc 定义', [0.2, 0.7]),             // cos≈0.24
    ];
    const out = rankChunks('长龄业务的判断标准是什么', chunks, q);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('口径速查');
  });

  it('v0.4.15：bigram 降级模式量纲不同，维持 score>0 过滤（不套用向量阈值）', () => {
    // bigram 模式需要 embedding=null（KnowledgeChunk 最小接口只 title/text/embedding）
    const chunks = [
      { title: '口径', text: '不良贷款余额', embedding: null } as any,
      { title: '无关', text: 'xyz', embedding: null, score: 0 } as any,
    ];
    const out = rankChunks('不良贷款余额是多少', chunks, null); // questionEmbedding=null → bigram
    expect(out).toHaveLength(1);
  });

  it('v0.4.15：GUIDED_DOC_KEYWORDS 增补「对比」「模式』，同比环比文档优先召回', () => {
    expect(GUIDED_DOC_KEYWORDS.includes('对比')).toBe(true);
    expect(GUIDED_DOC_KEYWORDS.includes('模式')).toBe(true);
    expect(GUIDED_DOC_KEYWORDS.includes('口径')).toBe(true);
  });
});

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
    expect(out).toContain('**必须遵循**'); // v0.4.15 强指令措辞
  });
});
