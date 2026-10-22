/**
 * v0.9.114 P1-1 事务封装（withTransaction / abortTransaction）单测。
 * 通过 mock mysql2 与初始化依赖，在无真实 MySQL 的前提下验证 commit/rollback/release 语义与错误传播。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const txEvents: string[] = [];
const connQuery = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve([]));
let rollbackError: Error | null = null;

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: async () => ({
      query: async () => undefined,
      end: async () => undefined,
    }),
    createPool: () => ({
      query: async () => [[], []],
      getConnection: async () => ({
        query: (...args: unknown[]) => connQuery(...args),
        beginTransaction: async () => {
          txEvents.push('begin');
        },
        commit: async () => {
          txEvents.push('commit');
        },
        rollback: async () => {
          txEvents.push('rollback');
          if (rollbackError) throw rollbackError;
        },
        release: () => {
          txEvents.push('release');
        },
      }),
      end: async () => undefined,
    }),
  },
}));
vi.mock('./schema', () => ({ createSchema: async () => undefined }));
vi.mock('./seed', () => ({ seedInitialData: async () => undefined }));
vi.mock('./migration', () => ({ migrateSchema: async () => undefined, migrateData: async () => undefined }));

import { initSchema, withTransaction, abortTransaction, getPool } from './db';

beforeEach(async () => {
  txEvents.length = 0;
  connQuery.mockClear();
  rollbackError = null;
  await initSchema();
});

describe('withTransaction', () => {
  it('回调正常返回 → begin → commit → release，并透传返回值', async () => {
    const result = await withTransaction(async (conn) => {
      await conn.query('INSERT INTO t VALUES (?)', [1]);
      return { ok: true as const, id: 7 };
    });
    expect(result).toEqual({ ok: true, id: 7 });
    expect(txEvents).toEqual(['begin', 'commit', 'release']);
    expect(connQuery).toHaveBeenCalledWith('INSERT INTO t VALUES (?)', [1]);
  });

  it('回调抛错 → rollback 后继续抛出，且连接仍会 release', async () => {
    await expect(
      withTransaction(async () => {
        throw new Error('db exploded');
      })
    ).rejects.toThrow('db exploded');
    expect(txEvents).toEqual(['begin', 'rollback', 'release']);
  });

  it('abortTransaction → rollback 并返回携带的业务结果（不抛错）', async () => {
    const result = await withTransaction(async () => {
      abortTransaction({ ok: false as const, error: '业务失败' });
    });
    expect(result).toEqual({ ok: false, error: '业务失败' });
    expect(txEvents).toEqual(['begin', 'rollback', 'release']);
  });

  it('业务失败前已执行的写操作会随 rollback 一并撤销（事件顺序证明）', async () => {
    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM bindings WHERE entity_id = ?', [1]);
      abortTransaction(false);
    });
    expect(txEvents).toEqual(['begin', 'rollback', 'release']);
    expect(connQuery).toHaveBeenCalledWith('DELETE FROM bindings WHERE entity_id = ?', [1]);
  });

  it('rollback 自身失败不掩盖原始错误', async () => {
    rollbackError = new Error('rollback failed');
    await expect(
      withTransaction(async () => {
        throw new Error('原始错误');
      })
    ).rejects.toThrow('原始错误');
    expect(txEvents).toEqual(['begin', 'rollback', 'release']);
  });
});

describe('getPool', () => {
  it('初始化后返回可用连接池', () => {
    expect(getPool()).toBeTruthy();
  });
});
