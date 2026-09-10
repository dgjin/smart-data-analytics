/**
 * 主动学习优先级排序单测（v0.9.47 P0 回归）：
 * 覆盖 user_id 列名修复（原读 row.userId → undefined → totalScore 恒 NaN、排序失效）、
 * snake_case → camelCase 显式映射（原 {...row} 展开导致审批 API 字段全 undefined）、
 * 高频踩坑用户加权语义。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 队列式 mock：按 SQL 调用顺序返回预设结果（与 expertPersonaStore.test.ts 同模式）
const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('activeLearning.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));
vi.mock('../infra/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { prioritizePendingSamples, normalizeSQLTemplate } from './activeLearning';

/** 构造一条 PENDING 样本库行（snake_case，与 adversarial_samples 表列一致） */
const pendingRow = (over: any = {}) => ({
  id: 1,
  original_query: '上季度销售额',
  original_sql: 'SELECT SUM(amount) FROM sales WHERE quarter = 1',
  error_message: '',
  data_source_id: 'ds-1',
  user_id: 7,
  annotation_status: 'PENDING',
  expected_sql: null,
  resolved_strategy: null,
  created_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
});

describe('normalizeSQLTemplate', () => {
  it('数字与字符串字面量归一为占位符', () => {
    expect(normalizeSQLTemplate("SELECT SUM(amount) FROM sales WHERE date='2024-01-01' AND id=5"))
      .toBe("SELECT SUM(AMOUNT) FROM SALES WHERE DATE=? AND ID=?");
  });
});

describe('prioritizePendingSamples', () => {
  it('totalScore 为有限数字且按分数降序（回归：原 row.userId 读不存在的列恒为 NaN）', async () => {
    queue.push([[pendingRow({ id: 1 }), pendingRow({ id: 2, original_sql: 'SELECT 1', user_id: 8 })]]);
    const result = await prioritizePendingSamples();

    expect(result.length).toBe(2);
    for (const s of result) {
      expect(Number.isFinite(s.totalScore)).toBe(true);
      expect(s.userId).toBeTypeOf('number');
      // snake_case → camelCase 显式映射回归（原 {...row} 展开使审批 API 读到 undefined）
      expect(s.originalQuery).toBe('上季度销售额');
      expect(s.originalSQL).toBeTypeOf('string');
      expect(s.annotationStatus).toBe('PENDING');
    }
    expect(result[0].totalScore).toBeGreaterThanOrEqual(result[1].totalScore);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });

  it('同数据源失败频次高的样本 frequencyScore 更高', async () => {
    queue.push([[
      pendingRow({ id: 1, data_source_id: 'ds-hot' }),
      pendingRow({ id: 2, data_source_id: 'ds-hot' }),
      pendingRow({ id: 3, data_source_id: 'ds-hot' }),
      pendingRow({ id: 4, data_source_id: 'ds-cold' }),
    ]]);
    const result = await prioritizePendingSamples();
    const hot = result.find((s) => s.id === 1)!;
    const cold = result.find((s) => s.id === 4)!;
    expect(hot.frequencyScore).toBeGreaterThan(cold.frequencyScore);
  });

  it('高频踩坑用户加权更高（回归：原 userId/1000 归一化恒为 NaN）', async () => {
    queue.push([[
      pendingRow({ id: 1, user_id: 7 }),
      pendingRow({ id: 2, user_id: 7 }),
      pendingRow({ id: 3, user_id: 7 }),
      pendingRow({ id: 4, user_id: 9 }),
    ]]);
    const result = await prioritizePendingSamples();
    expect(result.find((s) => s.id === 1)!.userWeightScore)
      .toBeGreaterThan(result.find((s) => s.id === 4)!.userWeightScore);
  });

  it('查询异常时 fail-safe 返回空数组', async () => {
    querySpy.mockRejectedValueOnce(new Error('db down'));
    await expect(prioritizePendingSamples()).resolves.toEqual([]);
  });
});
