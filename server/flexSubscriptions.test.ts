/**
 * v0.9.77 P2-15 固定报表订阅单测：入站校验 / 阈值判定 / 环境收敛 / 到期原子领取 / 单次执行落史。
 * 重放链路（runSavedFlexQuery）与连接池以桩替代，专注订阅编排与落库语义（真实执行链路由 flexQueryRunner 测试覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./infra/db', () => ({
  getPool: (): never => {
    throw new Error('测试须注入 pool');
  },
}));
vi.mock('./infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./flexQueryRunner', () => ({ runSavedFlexQuery: vi.fn() }));

import { runSavedFlexQuery } from './flexQueryRunner';
import {
  FLEX_ALERT_OPS,
  FLEX_SUB_MAX_FREQUENCY,
  FLEX_SUB_MIN_FREQUENCY,
  claimDueSubscriptions,
  evaluateAlert,
  executeSubscription,
  flexSubscriptionIntervalMs,
  normalizeSubscriptionPayload,
  runDueSubscriptions,
  subscriptionRunMaxRows,
  subscriptionTickBatch,
  toSubscriptionRecord,
} from './flexSubscriptions';

type PoolLike = Parameters<typeof claimDueSubscriptions>[1];

/** 最小 Pool 桩：按 SQL 子串分派（支持按 params 动态返回） */
function fakePool(handlers: Array<[string, (sql: string, params?: unknown[]) => unknown]>): PoolLike {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      for (const [match, fn] of handlers) {
        if (sql.includes(match)) return fn(sql, params);
      }
      throw new Error(`[fakePool] 未匹配 SQL: ${String(sql).slice(0, 140)}`);
    }),
  } as unknown as PoolLike;
}

/** flex_query_subscriptions 行（列结构与 SELECT * 对齐） */
const subRow = (over: Record<string, unknown> = {}) => ({
  subscription_id: 'sub-1',
  query_id: 'flex-1',
  user_id: 5,
  username: 'u5',
  frequency_minutes: 60,
  alert_metric: '',
  alert_op: '>',
  alert_threshold: 0,
  status: 'ACTIVE',
  last_run_at: null,
  next_run_at: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

/** runSavedFlexQuery 成功返回（行集定制；rowCount 缺省 = 行数） */
const okRun = (over: { rows?: Record<string, unknown>[]; rowCount?: number } = {}) => {
  const rows = over.rows ?? [];
  return {
    ok: true as const,
    data: {
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows,
      rowCount: over.rowCount ?? rows.length,
      truncated: false,
      name: '月度报表',
      dataSourceId: 'ds-1',
    },
  };
};

beforeEach(() => {
  vi.mocked(runSavedFlexQuery).mockReset();
});

afterEach(() => {
  delete process.env.FLEX_SUB_MAX_ROWS;
  delete process.env.FLEX_SUB_TICK_BATCH;
  delete process.env.FLEX_SUB_INTERVAL_MS;
});

describe('normalizeSubscriptionPayload：订阅入站校验', () => {
  it('非对象 → 拒绝', () => {
    expect(normalizeSubscriptionPayload(null).ok).toBe(false);
    expect(normalizeSubscriptionPayload(['x']).ok).toBe(false);
    expect(normalizeSubscriptionPayload('x').ok).toBe(false);
  });

  it('周期越界 / 非数字 → 拒绝（范围 5 分钟 ~ 7 天）', () => {
    expect(normalizeSubscriptionPayload({ frequencyMinutes: FLEX_SUB_MIN_FREQUENCY - 1 }).ok).toBe(false);
    expect(normalizeSubscriptionPayload({ frequencyMinutes: FLEX_SUB_MAX_FREQUENCY + 1 }).ok).toBe(false);
    expect(normalizeSubscriptionPayload({ frequencyMinutes: 'abc' }).ok).toBe(false);
  });

  it('成功路径：周期向下取整、列名去空白、比较符缺省 >、字符串阈值数值化', () => {
    const out = normalizeSubscriptionPayload({ frequencyMinutes: 65.9, alertMetric: ' total_sales ', alertThreshold: '1000' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload).toEqual({ frequencyMinutes: 65, alertMetric: 'total_sales', alertOp: '>', alertThreshold: 1000 });
    }
    const noMetric = normalizeSubscriptionPayload({ frequencyMinutes: 60 });
    expect(noMetric.ok).toBe(true);
    if (noMetric.ok) expect(noMetric.payload.alertMetric).toBe('');
  });

  it('告警列名非法字符 / 超长 → 拒绝（ident-safe）', () => {
    expect(normalizeSubscriptionPayload({ frequencyMinutes: 60, alertMetric: 'bad-name!' }).ok).toBe(false);
    expect(normalizeSubscriptionPayload({ frequencyMinutes: 60, alertMetric: 'a b' }).ok).toBe(false);
    expect(normalizeSubscriptionPayload({ frequencyMinutes: 60, alertMetric: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('不支持的比较符 → 拒绝；阈值非数字 → 拒绝', () => {
    expect(normalizeSubscriptionPayload({ frequencyMinutes: 60, alertOp: '!=' }).ok).toBe(false);
    expect(normalizeSubscriptionPayload({ frequencyMinutes: 60, alertThreshold: 'abc' }).ok).toBe(false);
  });

  it('比较符白名单全集可用', () => {
    for (const op of FLEX_ALERT_OPS) {
      expect(normalizeSubscriptionPayload({ frequencyMinutes: 60, alertOp: op }).ok).toBe(true);
    }
  });
});

describe('evaluateAlert：阈值判定', () => {
  it('五种比较符语义', () => {
    expect(evaluateAlert('>', 10, 5)).toBe(true);
    expect(evaluateAlert('>', 5, 5)).toBe(false);
    expect(evaluateAlert('>=', 5, 5)).toBe(true);
    expect(evaluateAlert('<', 3, 5)).toBe(true);
    expect(evaluateAlert('<=', 5, 5)).toBe(true);
    expect(evaluateAlert('=', 5, 5)).toBe(true);
    expect(evaluateAlert('=', 5, 6)).toBe(false);
  });

  it('非法数值 / 未知比较符 → 不触发', () => {
    expect(evaluateAlert('>', Number.NaN, 5)).toBe(false);
    expect(evaluateAlert('>', 10, Number.POSITIVE_INFINITY)).toBe(false);
    expect(evaluateAlert('~', 10, 5)).toBe(false);
  });
});

describe('环境参数收敛（env 缺省/越界/钳制）', () => {
  it('subscriptionRunMaxRows：缺省 1000，上限 10000，非法回退', () => {
    expect(subscriptionRunMaxRows()).toBe(1000);
    process.env.FLEX_SUB_MAX_ROWS = '500';
    expect(subscriptionRunMaxRows()).toBe(500);
    process.env.FLEX_SUB_MAX_ROWS = '99999';
    expect(subscriptionRunMaxRows()).toBe(10000);
    process.env.FLEX_SUB_MAX_ROWS = '0';
    expect(subscriptionRunMaxRows()).toBe(1000);
  });

  it('subscriptionTickBatch：缺省 3，上限 20', () => {
    expect(subscriptionTickBatch()).toBe(3);
    process.env.FLEX_SUB_TICK_BATCH = '50';
    expect(subscriptionTickBatch()).toBe(20);
  });

  it('flexSubscriptionIntervalMs：缺省 60s，下限 5s', () => {
    expect(flexSubscriptionIntervalMs()).toBe(60_000);
    process.env.FLEX_SUB_INTERVAL_MS = '1000';
    expect(flexSubscriptionIntervalMs()).toBe(60_000);
    process.env.FLEX_SUB_INTERVAL_MS = '10000';
    expect(flexSubscriptionIntervalMs()).toBe(10_000);
  });
});

describe('toSubscriptionRecord：行记录 → API 响应', () => {
  it('字段映射与时间归一（Date → ISO / null 保留 / 空比较符回退）', () => {
    const rec = toSubscriptionRecord(
      subRow({ last_run_at: new Date('2026-01-03T00:00:00.000Z'), next_run_at: null, alert_op: '' }) as never,
    );
    expect(rec.subscriptionId).toBe('sub-1');
    expect(rec.frequencyMinutes).toBe(60);
    expect(rec.alertOp).toBe('>'); // 空值回退
    expect(rec.lastRunAt).toBe('2026-01-03T00:00:00.000Z');
    expect(rec.nextRunAt).toBeNull();
    expect(rec.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('claimDueSubscriptions：到期原子领取', () => {
  it('仅 affectedRows=1 的订阅被领取（多实例防重）', async () => {
    const pool = fakePool([
      ['SELECT * FROM flex_query_subscriptions WHERE status', () => [[subRow({ subscription_id: 'sub-a' }), subRow({ subscription_id: 'sub-b' })]]],
      ['UPDATE flex_query_subscriptions SET next_run_at', (_sql, params) => [{ affectedRows: params?.[0] === 'sub-a' ? 1 : 0 }]],
    ]);
    const claimed = await claimDueSubscriptions(3, pool);
    expect(claimed.map((r) => r.subscription_id)).toEqual(['sub-a']);
  });

  it('无到期订阅 → 空数组', async () => {
    const pool = fakePool([['SELECT * FROM flex_query_subscriptions WHERE status', () => [[]]]]);
    expect(await claimDueSubscriptions(3, pool)).toEqual([]);
  });
});

describe('executeSubscription：单次执行与落史', () => {
  /** 执行落史所需的最小桩：读订阅 + 写运行记录 + 更新 last_run_at + 历史清理 */
  const execPool = (sub: Record<string, unknown>, seen: Array<{ sql: string; params?: unknown[] }> = []): PoolLike =>
    fakePool([
      ['SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1', () => [[sub]]],
      [
        'INSERT INTO flex_query_subscription_runs',
        (_sql, params) => {
          seen.push({ sql: 'insert-run', params });
          return [{}];
        },
      ],
      [
        'UPDATE flex_query_subscriptions SET last_run_at',
        (_sql, params) => {
          seen.push({ sql: 'last-run', params });
          return [{}];
        },
      ],
      [
        'DELETE FROM flex_query_subscription_runs WHERE subscription_id = ? AND id <',
        (_sql, params) => {
          seen.push({ sql: 'cleanup', params });
          return [{}];
        },
      ],
    ]);

  it('订阅不存在 → 抛出（调用方 404）', async () => {
    const pool = fakePool([['SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1', () => [[]]]]);
    await expect(executeSubscription('sub-404', pool)).rejects.toThrow('订阅不存在');
  });

  it('重放失败 → FAILED 落史（错误截断 500 字符）', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue({ ok: false, error: 'x'.repeat(600) });
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    const out = await executeSubscription('sub-1', execPool(subRow(), seen));
    expect(out.status).toBe('FAILED');
    expect(out.message.length).toBe(500);
    const insert = seen.find((s) => s.sql === 'insert-run');
    expect(insert?.params?.[1]).toBe('FAILED');
  });

  it('无告警列 → SUCCESS 摘要（含行数）', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [{ a: 1 }, { a: 2 }] }));
    const out = await executeSubscription('sub-1', execPool(subRow({ alert_metric: '' })));
    expect(out.status).toBe('SUCCESS');
    expect(out.message).toBe('执行成功（2 行）');
    expect(out.rowCount).toBe(2);
  });

  it('告警命中 → ALERT（记录告警值）', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [{ total_sales: 1200 }] }));
    const out = await executeSubscription('sub-1', execPool(subRow({ alert_metric: 'total_sales', alert_op: '>', alert_threshold: 1000 })));
    expect(out.status).toBe('ALERT');
    expect(out.alertValue).toBe('1200');
    expect(out.message).toContain('告警命中');
  });

  it('未触发阈值 → SUCCESS（消息说明实际值）', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [{ total_sales: 500 }] }));
    const out = await executeSubscription('sub-1', execPool(subRow({ alert_metric: 'total_sales', alert_op: '>', alert_threshold: 1000 })));
    expect(out.status).toBe('SUCCESS');
    expect(out.message).toContain('未触发告警');
  });

  it('告警列无数值 → SUCCESS 且提示未判定', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [{ total_sales: 'abc' }] }));
    const out = await executeSubscription('sub-1', execPool(subRow({ alert_metric: 'total_sales' })));
    expect(out.status).toBe('SUCCESS');
    expect(out.message).toContain('无有效数值');
  });

  it('空结果集 → SUCCESS 且跳过告警判定', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [] }));
    const out = await executeSubscription('sub-1', execPool(subRow({ alert_metric: 'total_sales' })));
    expect(out.status).toBe('SUCCESS');
    expect(out.message).toContain('无数据行');
  });

  it('成功路径落库：运行记录 + last_run_at + 历史清理', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [{ a: 1 }] }));
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    await executeSubscription('sub-1', execPool(subRow({ alert_metric: '' }), seen));
    expect(seen.find((s) => s.sql === 'last-run')?.params).toEqual(['sub-1']);
    expect(seen.find((s) => s.sql === 'cleanup')).toBeTruthy();
  });
});

describe('runDueSubscriptions：本轮调度', () => {
  it('领取并执行到期订阅（返回执行数）', async () => {
    vi.mocked(runSavedFlexQuery).mockResolvedValue(okRun({ rows: [{ a: 1 }] }));
    const pool = fakePool([
      ['SELECT * FROM flex_query_subscriptions WHERE status', () => [[subRow({ subscription_id: 'sub-a' })]]],
      ['UPDATE flex_query_subscriptions SET next_run_at', () => [{ affectedRows: 1 }]],
      ['SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1', () => [[subRow({ subscription_id: 'sub-a' })]]],
      ['INSERT INTO flex_query_subscription_runs', () => [{}]],
      ['UPDATE flex_query_subscriptions SET last_run_at', () => [{}]],
      ['DELETE FROM flex_query_subscription_runs WHERE subscription_id = ? AND id <', () => [{}]],
    ]);
    const n = await runDueSubscriptions(pool);
    expect(n).toBe(1);
    expect(runSavedFlexQuery).toHaveBeenCalledTimes(1);
  });
});
