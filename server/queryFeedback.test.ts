import { describe, expect, it, vi } from 'vitest';
import { bigramOverlap, normalizeSql, loadFewShotExamples, loadNegativeExamples } from './queryFeedback';
import { getPool } from './db';

vi.mock('./db', () => ({ getPool: vi.fn() }));

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

describe('loadNegativeExamples: 自主学习之点踩反例沉淀', () => {
  it('无相似点踩记录返回空数组', async () => {
    mockFeedbackRows([{ question: '完全无关', executed_sql: 'SELECT x FROM y' }]);
    const out = await loadNegativeExamples('ds1', '本月销售额趋势');
    expect(out).toEqual([]);
  });

  it('相似点踩问答对被检索为反例，按相似度排序', async () => {
    mockFeedbackRows([
      { question: '各客户类型的订单金额', executed_sql: 'SELECT SUM(amount) FROM orders' },
      { question: '各客户类型的数量', executed_sql: 'SELECT COUNT(*) FROM customers' },
    ]);
    const out = await loadNegativeExamples('ds1', '各客户类型的数量');
    expect(out.length).toBe(2);
    expect(out[0].sql).toContain('FROM customers');
  });

  it('相同归一化 SQL 只留一条，默认最多 2 条', async () => {
    mockFeedbackRows([
      { question: '问题甲', executed_sql: 'SELECT 1 FROM t' },
      { question: '问题甲乙', executed_sql: 'SELECT  1  FROM  t' },
      { question: '问题甲丙', executed_sql: 'SELECT 2 FROM t' },
      { question: '问题甲丁', executed_sql: 'SELECT 3 FROM t' },
    ]);
    const out = await loadNegativeExamples('ds1', '问题甲乙丙丁');
    expect(out.length).toBe(2);
    const sqls = out.map((n) => n.sql);
    expect(new Set(sqls).size).toBe(sqls.length);
  });
});
