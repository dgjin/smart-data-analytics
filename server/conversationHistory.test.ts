import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { recordConversation, searchConversations, deleteConversation, loadConversationFewShot, pruneConversationHistory } from './conversationHistory';
import { getPool } from './db';

vi.mock('./db', () => ({ getPool: vi.fn() }));

function mockPool(queryMock: any) {
  (getPool as any).mockReturnValue({ query: queryMock });
}

describe('recordConversation: 对话历史落库', () => {
  beforeEach(() => {
    // 抽样清理压制：recordConversation 内 10% 概率触发窗口清理（额外 query），
    // 会随机把 INSERT 计数从 1 变 2；固定 random 不落入抽样区间，保证计数确定性
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('SQL 归一化、字段截断后写入 conversation_history', async () => {
    const query = vi.fn().mockResolvedValue([{}]);
    mockPool(query);
    await recordConversation({
      userId: 1,
      username: 'alice',
      dataSourceId: 'ds1',
      question: '各客户类型的数量',
      executedSql: 'SELECT  type,\n COUNT(*)  FROM customers',
      answerSummary: '结论摘要',
      status: 'SUCCESS',
      provenance: 'live',
      rowCount: 3,
      durationMs: 1200,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO conversation_history');
    expect(params[4]).toBe('SELECT type, COUNT(*) FROM customers');
    expect(params[6]).toBe('SUCCESS');
    expect(params[7]).toBe('live');
  });

  it('rowCount/durationMs 非法值落 0，缺省 SQL 落空串', async () => {
    const query = vi.fn().mockResolvedValue([{}]);
    mockPool(query);
    await recordConversation({
      userId: 1,
      username: 'alice',
      dataSourceId: 'ds1',
      question: '问题',
      status: 'FALLBACK',
      provenance: 'simulated',
      rowCount: NaN as any,
      durationMs: undefined as any,
    });
    const params = query.mock.calls[0][1];
    expect(params[4]).toBe('');
    expect(params[8]).toBe(0);
    expect(params[9]).toBe(0);
  });
});

describe('searchConversations: 本人 + 数据源维度检索', () => {
  it('无关键词：按用户与数据源过滤', async () => {
    const query = vi.fn().mockResolvedValue([[]]);
    mockPool(query);
    await searchConversations(7, 'ds1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('user_id = ? AND data_source_id = ?');
    expect(sql).not.toContain('LIKE');
    expect(params).toEqual([7, 'ds1']);
  });

  it('带关键词：问题与结论摘要模糊匹配', async () => {
    const query = vi.fn().mockResolvedValue([[]]);
    mockPool(query);
    await searchConversations(7, 'ds1', ' 客户 ');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('question LIKE ? OR answer_summary LIKE ?');
    expect(params[2]).toBe('%客户%');
  });

  it('结果映射为结构化记录', async () => {
    mockPool(vi.fn().mockResolvedValue([[
      { id: 3, question: 'q', executed_sql: 'SELECT 1', answer_summary: 'a', status: 'SUCCESS', provenance: 'live', row_count: 2, duration_ms: 99, created_at: new Date('2026-08-15T00:00:00Z') },
    ]]));
    const out = await searchConversations(7, 'ds1');
    expect(out[0]).toMatchObject({ id: 3, question: 'q', sql: 'SELECT 1', status: 'SUCCESS', rowCount: 2 });
    expect(out[0].createdAt).toBe('2026-08-15T00:00:00.000Z');
  });
});

describe('deleteConversation: 仅限本人记录', () => {
  it('命中本人记录返回 true', async () => {
    mockPool(vi.fn().mockResolvedValue([{ affectedRows: 1 }]));
    expect(await deleteConversation(9, 7)).toBe(true);
  });
  it('越权或不存在返回 false', async () => {
    mockPool(vi.fn().mockResolvedValue([{ affectedRows: 0 }]));
    expect(await deleteConversation(9, 7)).toBe(false);
  });
});

describe('loadConversationFewShot: 个人对话沉淀自学习', () => {
  it('仅检索成功 live 记录：无关问题返回空', async () => {
    mockPool(vi.fn().mockResolvedValue([[{ question: '完全无关', executed_sql: 'SELECT x FROM y' }]]));
    const out = await loadConversationFewShot(1, 'ds1', '本月销售额趋势', []);
    expect(out).toEqual([]);
  });

  it('相似历史问答被检索为个人 few-shot（表重合加分）', async () => {
    mockPool(vi.fn().mockResolvedValue([[
      { question: '各客户类型的数量', executed_sql: 'SELECT type, COUNT(*) FROM customers GROUP BY type' },
      { question: '各客户类型的数量', executed_sql: 'SELECT type, COUNT(*) FROM orders GROUP BY type' },
    ]]));
    const out = await loadConversationFewShot(1, 'ds1', '各客户类型的数量', ['customers']);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].sql).toContain('FROM customers');
  });

  it('相同归一化 SQL 去重，最多返回 2 组', async () => {
    mockPool(vi.fn().mockResolvedValue([[
      { question: '问题甲', executed_sql: 'SELECT 1 FROM t' },
      { question: '问题甲乙', executed_sql: 'SELECT  1  FROM  t' },
      { question: '问题甲丙', executed_sql: 'SELECT 2 FROM t' },
      { question: '问题甲丁', executed_sql: 'SELECT 3 FROM t' },
    ]]));
    const out = await loadConversationFewShot(1, 'ds1', '问题甲乙丙丁', []);
    expect(out.length).toBeLessThanOrEqual(2);
    const sqls = out.map((p) => p.sql);
    expect(new Set(sqls).size).toBe(sqls.length);
  });
});

describe('pruneConversationHistory: P1-2 保留窗口治理', () => {
  it('超出保留窗口时按最旧优先清理', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ cnt: 520 }]])   // COUNT 超出默认 500
      .mockResolvedValueOnce([{ affectedRows: 20 }]); // DELETE
    mockPool(query);
    const removed = await pruneConversationHistory(1, 'ds1');
    expect(removed).toBe(20);
    expect(query.mock.calls[1][0]).toContain('ORDER BY id ASC LIMIT ?');
    expect(query.mock.calls[1][1]).toEqual([1, 'ds1', 20]);
  });

  it('窗口内不触发删除；CONVERSATION_RETENTION=0 关闭治理', async () => {
    mockPool(vi.fn().mockResolvedValue([[{ cnt: 100 }]]));
    expect(await pruneConversationHistory(1, 'ds1')).toBe(0);
    process.env.CONVERSATION_RETENTION = '0';
    try {
      expect(await pruneConversationHistory(1, 'ds1')).toBe(0);
    } finally {
      delete process.env.CONVERSATION_RETENTION;
    }
  });
});
