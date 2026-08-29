/**
 * v0.9.2 长任务队列单测（改进计划 2-1）：mock mysql pool，验证状态机、原子领取、
 * 在途上限、孤儿恢复与结果序列化。worker 循环（setInterval）不在单测内启动。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  submitTask,
  claimNextTask,
  completeTask,
  failTask,
  recoverOrphanTasks,
  toAsyncTask,
  taskWorkerConcurrency,
  taskUserQueueMax,
  TASK_MAX_ATTEMPTS,
  type TaskType,
} from './taskQueue';

/** 构造最小 mock pool：按序返回预设的 query 结果 */
function mockPool(queryImpl?: (sql: string, params?: any[]) => any) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const conn = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
    query: vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return queryImpl ? queryImpl(sql, params) : [[]];
    }),
  };
  const pool = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return queryImpl ? queryImpl(sql, params) : [[]];
    }),
    getConnection: vi.fn(async () => conn),
  } as any;
  return { pool, conn, calls };
}

const user = { id: 7, username: 'tester' };

describe('submitTask：提交与在途上限', () => {
  it('在途任务未超限时插入 PENDING 并返回 taskId', async () => {
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) return [[{ cnt: 1 }]];
      return [[]];
    });
    const out = await submitTask('report_generate', { a: 1 }, user, pool);
    expect(out).not.toBeNull();
    expect(out!.taskId).toMatch(/^task_[0-9a-f-]{36}$/);
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO async_tasks'));
    expect(insert).toBeDefined();
    expect(insert!.params![1]).toBe('report_generate');
    expect(insert!.params![2]).toBe('PENDING');
    expect(insert!.params![3]).toBe(7);
    expect(JSON.parse(insert!.params![5])).toEqual({ a: 1 });
  });

  it('在途任务达到上限（默认 3）时拒绝并返回 null', async () => {
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) return [[{ cnt: 3 }]];
      return [[]];
    });
    const out = await submitTask('report_export_pdf', {}, user, pool);
    expect(out).toBeNull();
    expect(calls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
  });
});

describe('claimNextTask：原子领取', () => {
  it('无 PENDING 任务返回 null 且不更新', async () => {
    const { pool, conn } = mockPool(() => [[]]);
    const out = await claimNextTask('w_test', pool);
    expect(out).toBeNull();
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    // 只有 SELECT，没有 UPDATE
    expect(conn.query.mock.calls.filter((c: any[]) => String(c[0]).startsWith('UPDATE'))).toHaveLength(0);
    expect(conn.release).toHaveBeenCalled();
  });

  it('有任务时 SELECT FOR UPDATE SKIP LOCKED + 置 RUNNING，payload 解析为对象', async () => {
    const { pool, conn } = mockPool((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return [[{ id: 'task_abc', type: 'report_generate', payload_json: '{"x":2}', attempts: 0 }]];
      }
      return [[]];
    });
    const out = await claimNextTask('w_test', pool);
    expect(out).toEqual({ id: 'task_abc', type: 'report_generate', payload: { x: 2 } });
    const update = conn.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE async_tasks'));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain("status = 'RUNNING'");
    const updateParams = update![1] as any[];
    expect(updateParams[0]).toBe('w_test');
    expect(updateParams[1]).toBe('task_abc');
  });

  it('payload_json 非法 JSON 时降级为空对象（不阻断领取）', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return [[{ id: 'task_bad', type: 'report_export_pdf', payload_json: 'broken{', attempts: 0 }]];
      }
      return [[]];
    });
    const out = await claimNextTask('w_test', pool);
    expect(out!.payload).toEqual({});
  });

  it('SELECT 抛错时回滚并释放连接', async () => {
    const { pool, conn } = mockPool(() => {
      throw new Error('conn lost');
    });
    await expect(claimNextTask('w_test', pool)).rejects.toThrow('conn lost');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

describe('completeTask / failTask', () => {
  it('completeTask 置 SUCCESS 并序列化结果', async () => {
    const { pool, calls } = mockPool();
    await completeTask('task_1', { report: { title: 't' } }, pool);
    const c = calls[0];
    expect(c.sql).toContain("status = 'SUCCESS'");
    expect(JSON.parse(c.params![0])).toEqual({ report: { title: 't' } });
    expect(c.params![1]).toBe('task_1');
  });

  it('failTask 置 FAILED 并截断超长错误', async () => {
    const { pool, calls } = mockPool();
    await failTask('task_2', 'x'.repeat(600), pool);
    const c = calls[0];
    expect(c.sql).toContain("status = 'FAILED'");
    expect(c.params![0]).toHaveLength(500);
  });
});

describe('recoverOrphanTasks：孤儿恢复', () => {
  it('attempts 未超限回 PENDING 重跑；超限标 FAILED 不丢任务', async () => {
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes("status = 'RUNNING'") && sql.startsWith('SELECT')) {
        return [[{ id: 'task_retry', attempts: 1 }, { id: 'task_dead', attempts: TASK_MAX_ATTEMPTS }]];
      }
      return [[]];
    });
    const n = await recoverOrphanTasks(pool, 90_000);
    expect(n).toBe(2);
    const retry = calls.find((c) => c.sql.includes("status = 'PENDING'") && c.params?.[0] === 'task_retry');
    const dead = calls.find((c) => c.sql.includes("status = 'FAILED'") && c.sql.includes('已达最大重试次数') && c.params?.[0] === 'task_dead');
    expect(retry).toBeDefined();
    expect(dead).toBeDefined();
  });

  it('无孤儿时不产生 UPDATE', async () => {
    const { pool, calls } = mockPool(() => [[]]);
    const n = await recoverOrphanTasks(pool);
    expect(n).toBe(0);
    expect(calls.filter((c) => c.sql.startsWith('UPDATE'))).toHaveLength(0);
  });
});

describe('toAsyncTask：行记录 → API 出参', () => {
  const baseRow = {
    id: 'task_x',
    type: 'report_generate' as TaskType,
    status: 'SUCCESS',
    user_id: 7,
    username: 'tester',
    progress: '',
    error: '',
    attempts: 1,
    result_json: '{"success":true}',
    created_at: new Date('2026-08-29T01:00:00Z'),
    started_at: new Date('2026-08-29T01:00:01Z'),
    finished_at: new Date('2026-08-29T01:02:00Z'),
  };

  it('SUCCESS 解析 result_json，时间转 ISO', () => {
    const t = toAsyncTask(baseRow);
    expect(t.result).toEqual({ success: true });
    expect(t.createdAt).toBe('2026-08-29T01:00:00.000Z');
    expect(t.finishedAt).toBe('2026-08-29T01:02:00.000Z');
  });

  it('非 SUCCESS 不下发 result 字段', () => {
    const t = toAsyncTask({ ...baseRow, status: 'RUNNING' });
    expect('result' in t).toBe(false);
  });

  it('result_json 非法 JSON 时 result 为 null（不抛错）', () => {
    const t = toAsyncTask({ ...baseRow, result_json: 'oops{' });
    expect(t.result).toBeNull();
  });
});

describe('配置函数：环境变量覆盖与非法回退', () => {
  beforeEach(() => {
    delete process.env.TASK_WORKER_CONCURRENCY;
    delete process.env.TASK_QUEUE_USER_MAX;
  });
  afterEach(() => {
    delete process.env.TASK_WORKER_CONCURRENCY;
    delete process.env.TASK_QUEUE_USER_MAX;
  });

  it('默认值：worker 并发 2 / 用户在途上限 3', () => {
    expect(taskWorkerConcurrency()).toBe(2);
    expect(taskUserQueueMax()).toBe(3);
  });

  it('合法覆盖生效，非法值回退默认', () => {
    process.env.TASK_WORKER_CONCURRENCY = '4';
    process.env.TASK_QUEUE_USER_MAX = 'abc';
    expect(taskWorkerConcurrency()).toBe(4);
    expect(taskUserQueueMax()).toBe(3);
  });

  it('超过上限被 clamp（worker ≤10 / 用户 ≤50）', () => {
    process.env.TASK_WORKER_CONCURRENCY = '99';
    process.env.TASK_QUEUE_USER_MAX = '1000';
    expect(taskWorkerConcurrency()).toBe(10);
    expect(taskUserQueueMax()).toBe(50);
  });
});
