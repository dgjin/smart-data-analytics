import { describe, expect, it, vi } from 'vitest';
import { bigramOverlap, normalizeSql, loadFewShotExamples, loadNegativeExamples, saveFeedback } from './queryFeedback';
import { getPool } from './db';
import { callEmbedding } from './llmClient';

vi.mock('./db', () => ({ getPool: vi.fn() }));
vi.mock('./llmClient', () => ({
  callLLMJson: vi.fn(),
  callEmbedding: vi.fn().mockRejectedValue(new Error('embedding 不可用')),
}));

function mockFeedbackRows(rows: any[]) {
  (getPool as any).mockReturnValue({ query: vi.fn().mockResolvedValue([rows]) });
}

describe('bigramOverlap: 中文 bigram 相似度', () => {
  it('完全相同的问题得分等于 bigram 总数', () => {
    const q = '各客户类型的数量';
    expect(bigramOverlap(q, q)).toBe(q.length - 1);
  });

  it('部分重合的问题得分大于 0', () => {
    expect(bigramOverlap('各客户类型的数量', '统计各客户类型的订单金额')).toBeGreaterThan(0);
  });

  it('完全不同的问题得分为 0', () => {
    expect(bigramOverlap('上个月销售额趋势', '今年渠道投放结构占比')).toBe(0);
  });

  it('超短字符串不产生 bigram，返回 0', () => {
    expect(bigramOverlap('嗯', '嗯')).toBe(0);
  });
});

describe('normalizeSql: SQL 归一化', () => {
  it('压缩多余空白为单空格并去除首尾空白', () => {
    expect(normalizeSql('SELECT  a\n   FROM\t t   ')).toBe('SELECT a FROM t');
  });
  it('空值返回空串', () => {
    expect(normalizeSql('')).toBe('');
    expect(normalizeSql(undefined as any)).toBe('');
  });
});

describe('loadFewShotExamples: DAIL-SQL 双维度打分（样例库统一读取）', () => {
  it('无匹配样例返回空数组', async () => {
    mockFeedbackRows([{ question: '完全无关', sql_text: 'SELECT x FROM y', source: 'MANUAL' }]);
    const out = await loadFewShotExamples('ds1', '本月销售额趋势', []);
    expect(out).toEqual([]);
  });

  it('表引用重合提升样例优先级（SQL 结构维度）', async () => {
    mockFeedbackRows([
      { question: '各客户类型的数量', sql_text: 'SELECT type, COUNT(*) FROM orders GROUP BY type', source: 'MANUAL' },
      { question: '各客户类型的数量', sql_text: 'SELECT type, COUNT(*) FROM customers GROUP BY type', source: 'FEEDBACK_UP' },
    ]);
    const out = await loadFewShotExamples('ds1', '各客户类型的数量', ['customers']);
    expect(out[0].sql).toContain('FROM customers');
  });

  it('相同归一化 SQL 只保留一条（去重）', async () => {
    mockFeedbackRows([
      { question: '问题甲', sql_text: 'SELECT 1 FROM t', source: 'MANUAL' },
      { question: '问题甲乙', sql_text: 'SELECT  1  FROM  t', source: 'MANUAL' },
    ]);
    const out = await loadFewShotExamples('ds1', '问题甲乙', ['t']);
    expect(out.length).toBe(1);
    expect(out[0].sql).toBe('SELECT 1 FROM t');
  });

  it('最多返回 3 条样例', async () => {
    mockFeedbackRows([
      { question: '查询A', sql_text: 'SELECT a FROM t1', source: 'MANUAL' },
      { question: '查询B', sql_text: 'SELECT b FROM t2', source: 'MANUAL' },
      { question: '查询C', sql_text: 'SELECT c FROM t3', source: 'IMPORT' },
      { question: '查询D', sql_text: 'SELECT d FROM t4', source: 'MANUAL' },
    ]);
    const out = await loadFewShotExamples('ds1', '查询', ['t1', 't2', 't3', 't4']);
    expect(out.length).toBe(3);
  });
});

describe('loadFewShotExamples: P1-3 语义检索（embedding 混合打分）', () => {
  it('embedding 引擎不可用时降级 bigram 词法（行为与旧版一致）', async () => {
    (callEmbedding as any).mockRejectedValueOnce(new Error('down'));
    mockFeedbackRows([
      { question: '各客户类型的数量', sql_text: 'SELECT type, COUNT(*) FROM customers GROUP BY type', source: 'MANUAL', embedding: '[1,0]' },
    ]);
    const out = await loadFewShotExamples('ds1', '各客户类型的数量', ['customers']);
    expect(out.length).toBe(1);
    expect(out[0].sql).toContain('customers');
  });

  it('同义不同词的问题也能靠向量召回（bigram 为 0 时仍命中）', async () => {
    (callEmbedding as any).mockResolvedValueOnce([1, 0]);
    mockFeedbackRows([
      { question: '客户流失率统计', sql_text: 'SELECT ratio FROM churn', source: 'MANUAL', embedding: '[0.99,0.01]' },
    ]);
    const out = await loadFewShotExamples('ds1', '流失客户占比', []); // 与样例 bigram 重合为 0
    expect(out.length).toBe(1);
    expect(out[0].question).toBe('客户流失率统计');
  });

  it('向量损坏（非法 JSON）不加分不抛错，降级词法', async () => {
    (callEmbedding as any).mockResolvedValueOnce([1, 0]);
    mockFeedbackRows([
      { question: '各客户类型的数量', sql_text: 'SELECT type, COUNT(*) FROM customers GROUP BY type', source: 'MANUAL', embedding: '{bad json' },
    ]);
    const out = await loadFewShotExamples('ds1', '各客户类型的数量', ['customers']);
    expect(out.length).toBe(1);
  });
});

describe('saveFeedback: P1-1 反馈幂等', () => {
  it('24h 内同用户同问答同结论重复提交直接跳过', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ cnt: 1 }]])   // 幂等查询命中
      .mockResolvedValue([{}]);
    (getPool as any).mockReturnValue({ query });
    await saveFeedback({ userId: 1, username: 'alice', dataSourceId: 'ds1', question: 'q1', executedSql: 'SELECT 1', verdict: 'UP', provenance: 'live' });
    expect(query).toHaveBeenCalledTimes(1); // 未走到 INSERT
  });

  it('非重复反馈正常插入，点赞 live 沉淀样例并落向量', async () => {
    (callEmbedding as any).mockResolvedValueOnce([0.1, 0.9]);
    const query = vi.fn()
      .mockResolvedValueOnce([[{ cnt: 0 }]])   // 幂等查询未命中
      .mockResolvedValueOnce([{}])            // INSERT query_feedback
      .mockResolvedValueOnce([[{ cnt: 0 }]])   // sql_examples 去重查
      .mockResolvedValueOnce([{}]);            // INSERT sql_examples
    (getPool as any).mockReturnValue({ query });
    await saveFeedback({ userId: 1, username: 'alice', dataSourceId: 'ds1', question: 'q1', executedSql: 'SELECT 1', verdict: 'UP', provenance: 'live' });
    expect(query).toHaveBeenCalledTimes(4);
    const insertCall = query.mock.calls[3][0];
    expect(insertCall).toContain('FEEDBACK_UP');
    expect(query.mock.calls[3][1][4]).toBe('[0.1,0.9]'); // embedding 落库
  });
});

describe('loadNegativeExamples: 自主学习之点踩反例沉淀', () => {
  it('无相似或低相似（bigram<4）点踩记录返回空数组，避免噪声反例误导', async () => {
    mockFeedbackRows([
      { question: '完全无关', executed_sql: 'SELECT x FROM y' },
      { question: '各客户类型的订单金额', executed_sql: 'SELECT SUM(amount) FROM orders' }, // 与查询 bigram 重合 3
    ]);
    const out = await loadNegativeExamples('ds1', '客户类型单');
    expect(out).toEqual([]);
  });

  it('相似点踩问答对被检索为反例，只携带表名特征不带完整错误 SQL', async () => {
    mockFeedbackRows([
      { question: '各客户类型的订单金额', executed_sql: 'SELECT SUM(amount) FROM orders' },
      { question: '各客户类型的数量', executed_sql: 'SELECT COUNT(*) FROM customers' },
    ]);
    const out = await loadNegativeExamples('ds1', '各客户类型的数量');
    expect(out.length).toBe(2);
    expect(out[0].wrongTables).toContain('customers');
    expect(JSON.stringify(out)).not.toContain('COUNT'); // 完整 SQL 不出库，防 LLM 照抄负例
  });

  it('相同归一化 SQL 只留一条，默认最多 2 条', async () => {
    mockFeedbackRows([
      { question: '问题甲乙丙丁', executed_sql: 'SELECT 1 FROM t' },
      { question: '问题甲乙丙丁戊', executed_sql: 'SELECT  1  FROM  t' },
      { question: '问题甲乙丙丁己', executed_sql: 'SELECT 2 FROM t' },
      { question: '问题甲乙丙丁庚', executed_sql: 'SELECT 3 FROM t' },
    ]);
    const out = await loadNegativeExamples('ds1', '问题甲乙丙丁戊己庚');
    expect(out.length).toBe(2);
    const qs = out.map((n) => n.question);
    expect(new Set(qs).size).toBe(qs.length); // 归一化同 SQL 去重后不出现重复问题
  });
});
