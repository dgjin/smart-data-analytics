/**
 * P2-4 连接池分级 + 场景超时（企业级改进计划 2-4）。
 * 覆盖：场景配额公式（DS_POOL_MAX=10 → 10/5/2 基准）、场景超时档位（15s/120s/60s）、
 * MySQL MAX_EXECUTION_TIME hint 注入、按 数据源+场景 的池隔离与失效。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// mock 驱动层：捕获建池参数（连接惰性，不产生真实网络连接）
// vi.mock 调用被提升到文件顶部，工厂内引用必须用 vi.hoisted 初始化
const { mysqlCreatePool, pgPoolCtor } = vi.hoisted(() => ({
  mysqlCreatePool: vi.fn((cfg: any) => ({ __cfg: cfg, end: vi.fn().mockResolvedValue(undefined), query: vi.fn() })),
  pgPoolCtor: vi.fn(function (this: any, cfg: any) {
    return { __cfg: cfg, end: vi.fn().mockResolvedValue(undefined), query: vi.fn() };
  }),
}));
vi.mock('mysql2/promise', () => ({ default: { createPool: mysqlCreatePool } }));
vi.mock('pg', () => ({ default: { Pool: pgPoolCtor } }));

import {
  dsPoolMax,
  dsPoolScenarioMax,
  scenarioTimeoutMs,
  injectMysqlMaxExecTime,
  getDsPool,
  invalidateExecutorPool,
} from './sqlExecutor';

const ENV_KEYS = [
  'DS_POOL_MAX',
  'EXPECTED_CONCURRENT_USERS',
  'DS_POOL_INTERACTIVE',
  'DS_POOL_CHAIN',
  'DS_POOL_EXPORT',
  'QUERY_TIMEOUT_INTERACTIVE_MS',
  'QUERY_TIMEOUT_CHAIN_MS',
  'QUERY_TIMEOUT_EXPORT_MS',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  invalidateExecutorPool();
  mysqlCreatePool.mockClear();
  pgPoolCtor.mockClear();
});

describe('dsPoolScenarioMax: 场景化连接池配额', () => {
  it('DS_POOL_MAX=10 时恰为 交互10 / 分析链5 / 导出2（改进计划基准）', () => {
    process.env.DS_POOL_MAX = '10';
    expect(dsPoolScenarioMax('interactive')).toBe(10);
    expect(dsPoolScenarioMax('chain')).toBe(5);
    expect(dsPoolScenarioMax('export')).toBe(2);
  });

  it('默认公式（20 并发用户 → base=5）：交互5 / 链3 / 导出1', () => {
    expect(dsPoolMax()).toBe(5);
    expect(dsPoolScenarioMax('interactive')).toBe(5);
    expect(dsPoolScenarioMax('chain')).toBe(3); // max(2, ceil(5/2))
    expect(dsPoolScenarioMax('export')).toBe(1); // max(1, floor(5/5))
  });

  it('场景 env 显式配置优先于公式，clamp 到 [1, 100]', () => {
    process.env.DS_POOL_MAX = '10';
    process.env.DS_POOL_INTERACTIVE = '12';
    process.env.DS_POOL_CHAIN = '7';
    process.env.DS_POOL_EXPORT = '3';
    expect(dsPoolScenarioMax('interactive')).toBe(12);
    expect(dsPoolScenarioMax('chain')).toBe(7);
    expect(dsPoolScenarioMax('export')).toBe(3);
    process.env.DS_POOL_CHAIN = '500';
    expect(dsPoolScenarioMax('chain')).toBe(100);
  });

  it('非法场景 env 回退公式', () => {
    process.env.DS_POOL_MAX = '10';
    process.env.DS_POOL_CHAIN = 'abc';
    process.env.DS_POOL_EXPORT = '0';
    expect(dsPoolScenarioMax('chain')).toBe(5);
    expect(dsPoolScenarioMax('export')).toBe(2);
  });
});

describe('scenarioTimeoutMs: 场景化执行超时档位', () => {
  it('默认档位：交互 15s / 分析链 120s / 导出 60s', () => {
    expect(scenarioTimeoutMs('interactive')).toBe(15_000);
    expect(scenarioTimeoutMs('chain')).toBe(120_000);
    expect(scenarioTimeoutMs('export')).toBe(60_000);
  });

  it('env 显式覆盖；非法值回退默认档位', () => {
    process.env.QUERY_TIMEOUT_INTERACTIVE_MS = '8000';
    process.env.QUERY_TIMEOUT_CHAIN_MS = 'bad';
    expect(scenarioTimeoutMs('interactive')).toBe(8_000);
    expect(scenarioTimeoutMs('chain')).toBe(120_000);
    expect(scenarioTimeoutMs('export')).toBe(60_000);
  });
});

describe('injectMysqlMaxExecTime: MySQL 服务端执行时限 hint', () => {
  it('SELECT 开头注入 MAX_EXECUTION_TIME 优化器提示', () => {
    expect(injectMysqlMaxExecTime('SELECT a FROM t LIMIT 10', 15_000)).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(15000) */ a FROM t LIMIT 10'
    );
  });

  it('大小写不敏感且容忍前导空白', () => {
    expect(injectMysqlMaxExecTime('  select a from t', 60_000)).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(60000) */ a from t'
    );
  });

  it('超时值取整且下限 1ms', () => {
    expect(injectMysqlMaxExecTime('SELECT 1', 0)).toContain('MAX_EXECUTION_TIME(1)');
    expect(injectMysqlMaxExecTime('SELECT 1', 1234.9)).toContain('MAX_EXECUTION_TIME(1234)');
  });
});

describe('getDsPool: 按 数据源+场景 分级建池', () => {
  const cfg = { host: '127.0.0.1', port: 3306, username: 'u', password: 'p', database: 'd' };

  it('同数据源同场景复用同一池；不同场景是独立池（配额隔离的结构基础）', () => {
    const a1 = getDsPool('ds1', 'mysql', cfg, 'interactive');
    const a2 = getDsPool('ds1', 'mysql', cfg, 'interactive');
    const b = getDsPool('ds1', 'mysql', cfg, 'export');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(mysqlCreatePool).toHaveBeenCalledTimes(2);
  });

  it('mysql 建池参数按场景分级：connectionLimit 取场景配额', () => {
    process.env.DS_POOL_MAX = '10';
    getDsPool('ds1', 'mysql', cfg, 'interactive');
    getDsPool('ds1', 'mysql', cfg, 'chain');
    getDsPool('ds1', 'mysql', cfg, 'export');
    const limits = mysqlCreatePool.mock.calls.map((c) => c[0].connectionLimit);
    expect(limits).toEqual([10, 5, 2]);
  });

  it('pg 建池参数按场景分级：max 取场景配额，statement_timeout 取场景超时', () => {
    process.env.DS_POOL_MAX = '10';
    getDsPool('ds1', 'pg', { ...cfg, port: 5432 }, 'interactive');
    getDsPool('ds1', 'pg', { ...cfg, port: 5432 }, 'chain');
    const calls = pgPoolCtor.mock.calls.map((c) => c[0]);
    expect(calls[0].max).toBe(10);
    expect(calls[0].statement_timeout).toBe(15_000);
    expect(calls[1].max).toBe(5);
    expect(calls[1].statement_timeout).toBe(120_000);
  });

  it('invalidateExecutorPool(dataSourceId) 失效该数据源的全部场景池，不影响其他数据源', async () => {
    const ds1Interactive = getDsPool('ds1', 'mysql', cfg, 'interactive');
    const ds1Export = getDsPool('ds1', 'mysql', cfg, 'export');
    const ds2 = getDsPool('ds2', 'mysql', cfg, 'interactive');
    invalidateExecutorPool('ds1');
    expect((ds1Interactive.pool as any).end).toHaveBeenCalled();
    expect((ds1Export.pool as any).end).toHaveBeenCalled();
    expect((ds2.pool as any).end).not.toHaveBeenCalled();
    // ds1 重建为新池；ds2 仍复用
    expect(getDsPool('ds1', 'mysql', cfg, 'interactive')).not.toBe(ds1Interactive);
    expect(getDsPool('ds2', 'mysql', cfg, 'interactive')).toBe(ds2);
  });

  it('invalidateExecutorPool() 无参清空全部池', () => {
    const a = getDsPool('ds1', 'mysql', cfg, 'interactive');
    const b = getDsPool('ds2', 'mysql', cfg, 'chain');
    invalidateExecutorPool();
    expect((a.pool as any).end).toHaveBeenCalled();
    expect((b.pool as any).end).toHaveBeenCalled();
    expect(getDsPool('ds1', 'mysql', cfg, 'interactive')).not.toBe(a);
  });
});
