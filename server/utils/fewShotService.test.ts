/**
 * Few-Shot 示例库单测（v0.9.47 P0 回归）：
 * 注入 INSERT 对齐 few_shot_examples 真实列（回归：原写 knowledge_base 不存在的
 * content/doc_type/updated_at 列，注入 100% 失败且污染业务知识 RAG）、
 * bigram 相似度检索排序与命中计数、human_approval 复用入口。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 队列式 mock：按 SQL 调用顺序返回预设结果（与 expertPersonaStore.test.ts 同模式）
const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('fewShotService.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));
vi.mock('../infra/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { injectFewShotSamples, retrieveFewShotExamples, retrieveBestFewShot } from './fewShotService';

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
});

describe('injectFewShotSamples', () => {
  it('写入 few_shot_examples 表并携带 sample_id 溯源（回归：原写 knowledge_base 不存在的列）', async () => {
    queue.push({ insertId: 1 }, { insertId: 2 });
    const n = await injectFewShotSamples([
      { original_query: '上月销售额', expected_sql: 'SELECT 1', data_source_id: 'ds-1', sample_id: 9 },
      { original_query: 'TOP10 客户', expected_sql: 'SELECT 2', data_source_id: 'ds-1' },
    ]);

    expect(n).toBe(2);
    expect(querySpy).toHaveBeenCalledTimes(2);

    const [sql, params] = querySpy.mock.calls[0];
    expect(sql).toContain('INSERT INTO few_shot_examples');
    expect(sql).not.toContain('knowledge_base');
    expect(params).toEqual(['ds-1', '上月销售额', 'SELECT 1', 9]);

    const [, params2] = querySpy.mock.calls[1];
    expect(params2).toEqual(['ds-1', 'TOP10 客户', 'SELECT 2', null]);
  });

  it('缺 question 或 expected_sql 的样本被跳过', async () => {
    const n = await injectFewShotSamples([
      { original_query: 'q', expected_sql: '', data_source_id: 'ds' },
      { original_query: '', expected_sql: 'SELECT 1', data_source_id: 'ds' },
    ]);
    expect(n).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe('retrieveFewShotExamples', () => {
  it('按 bigram 相似度过滤排序并异步累计 hit_count', async () => {
    queue.push([[
      { id: 1, data_source_id: 'ds-1', question: '上月销售额是多少', expected_sql: 'SELECT SUM(amount) FROM sales' },
      { id: 2, data_source_id: 'ds-1', question: '库存周转率', expected_sql: 'SELECT 2' },
    ]]);
    queue.push({ affectedRows: 1 }); // hit_count UPDATE

    const result = await retrieveFewShotExamples('上月的销售额', 'ds-1', 2);

    // 相似问题命中，无关问题被过滤
    expect(result.length).toBe(1);
    expect(result[0].question).toBe('上月销售额是多少');
    expect(querySpy.mock.calls[0][0]).toContain('FROM few_shot_examples');

    // 命中后异步累计 hit_count（flush 微任务后断言）
    await new Promise((r) => setTimeout(r, 0));
    expect(querySpy.mock.calls[1][0]).toContain('UPDATE few_shot_examples');
  });

  it('无相似样本返回空且不更新 hit_count', async () => {
    queue.push([[]]);
    const result = await retrieveFewShotExamples('完全无关', 'ds-1');

    expect(result).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('查询异常时 fail-safe 返回空数组', async () => {
    querySpy.mockRejectedValueOnce(new Error('db down'));
    await expect(retrieveFewShotExamples('q', 'ds')).resolves.toEqual([]);
  });
});

describe('retrieveBestFewShot', () => {
  it('取最相似一条供 human_approval 策略复用', async () => {
    queue.push([[{ id: 3, data_source_id: 'ds-1', question: '上月销售额是多少', expected_sql: 'SELECT SUM(x) FROM t' }]]);
    queue.push({ affectedRows: 1 });

    const best = await retrieveBestFewShot('上月销售额', 'ds-1');
    expect(best).toEqual({ question: '上月销售额是多少', sql: 'SELECT SUM(x) FROM t' });
  });

  it('无匹配时返回 null（策略层据此降级）', async () => {
    queue.push([[]]);
    const best = await retrieveBestFewShot('无关问题', 'ds-1');
    expect(best).toBeNull();
  });
});
