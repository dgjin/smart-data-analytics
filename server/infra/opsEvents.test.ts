/**
 * v0.9.93 自动运维事件流单测：去重键/窗口合并/新插入截断/traceId 注入/fail-open。
 * mock db 与 monitoring（Prometheus 旁路不在本层验证）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const querySpy = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('./monitoring', () => ({ observeOpsEvent: vi.fn() }));

import { recordOpsEvent, buildEventKey, OPS_EVENT_DEDUP_WINDOW_MINUTES } from './opsEvents';
import { runWithLogContext } from './asyncContext';

beforeEach(() => {
  querySpy.mockReset();
});

describe('buildEventKey：事件身份（不含消息文本）', () => {
  it('由 source:category:entityType:entityId 组合', () => {
    expect(buildEventKey({ source: 'task', category: 'TASK', entityType: 'task', entityId: 't1' })).toBe('task:TASK:task:t1');
    expect(buildEventKey({ source: 'audit', category: 'NL2SQL' })).toBe('audit:NL2SQL::');
  });

  it('超长键截断到 160（对齐表列宽）', () => {
    const key = buildEventKey({ source: 'drift', category: 'DRIFT', entityType: 'drift_column', entityId: 'x'.repeat(300) });
    expect(key.length).toBeLessThanOrEqual(160);
  });
});

describe('recordOpsEvent：窗口去重合并与新插入', () => {
  it('窗口内存在同键 NEW 事件 → 仅累加 dedup_count/last_seen_at', async () => {
    querySpy.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM ops_events')) return [[{ id: 42 }]];
      return [{ affectedRows: 1 }];
    });
    recordOpsEvent({ source: 'task', category: 'TASK', severity: 'ERROR', message: 'boom', entityType: 'task', entityId: 't1' });
    await vi.waitFor(() => expect(querySpy).toHaveBeenCalledTimes(2));
    const [selectSql, selectParams] = querySpy.mock.calls[0];
    expect(String(selectSql)).toContain(`INTERVAL ${OPS_EVENT_DEDUP_WINDOW_MINUTES} MINUTE`);
    expect(selectParams).toEqual(['task:TASK:task:t1']);
    const [updateSql, updateParams] = querySpy.mock.calls[1];
    expect(String(updateSql)).toContain('dedup_count = dedup_count + 1');
    expect(updateParams).toEqual([42]);
    // 去重命中时不得 INSERT
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('INSERT INTO ops_events'))).toBe(false);
  });

  it('无同键事件 → INSERT（message 截断 500、traceId 取上下文 requestId）', async () => {
    querySpy.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM ops_events')) return [[]];
      return [{ affectedRows: 1 }];
    });
    runWithLogContext({ requestId: 'req-1' }, () => {
      recordOpsEvent({
        source: 'audit',
        category: 'NL2SQL',
        severity: 'ERROR',
        message: 'x'.repeat(600),
        entityType: 'endpoint',
        entityId: 'query',
      });
    });
    await vi.waitFor(() => expect(querySpy).toHaveBeenCalledTimes(2));
    const [insertSql, params] = querySpy.mock.calls[1];
    expect(String(insertSql)).toContain('INSERT INTO ops_events');
    const p = params as unknown[];
    expect(p[0]).toBe('audit:NL2SQL:endpoint:query');
    expect(p[1]).toBe('ERROR');
    expect(p[2]).toBe('audit');
    expect((p[6] as string).length).toBe(500);
    expect(p[8]).toBe('req-1');
  });

  it('显式 traceId 优先于上下文', async () => {
    querySpy.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM ops_events')) return [[]];
      return [{ affectedRows: 1 }];
    });
    runWithLogContext({ requestId: 'req-1' }, () => {
      recordOpsEvent({ source: 'task', category: 'TASK', severity: 'ERROR', message: 'm', traceId: 'task-9' });
    });
    await vi.waitFor(() => expect(querySpy).toHaveBeenCalledTimes(2));
    expect((querySpy.mock.calls[1][1] as unknown[])[8]).toBe('task-9');
  });

  it('detail 循环引用降级为 unserializable 预览（不抛错）', async () => {
    querySpy.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM ops_events')) return [[]];
      return [{ affectedRows: 1 }];
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    recordOpsEvent({ source: 'fatal', category: 'PROCESS', severity: 'CRITICAL', message: 'm', detail: cyclic });
    await vi.waitFor(() => expect(querySpy).toHaveBeenCalledTimes(2));
    const detail = (querySpy.mock.calls[1][1] as unknown[])[7] as string;
    expect(detail).toContain('unserializable');
  });
});

describe('fail-open：写入失败绝不影响调用方', () => {
  it('getPool/query 同步抛错 → recordOpsEvent 不抛出', () => {
    querySpy.mockImplementation(() => {
      throw new Error('no pool');
    });
    expect(() =>
      recordOpsEvent({ source: 'task', category: 'TASK', severity: 'ERROR', message: 'm' })
    ).not.toThrow();
  });

  it('query Promise 拒绝 → 不产生未处理拒绝', async () => {
    querySpy.mockRejectedValue(new Error('db down'));
    expect(() =>
      recordOpsEvent({ source: 'task', category: 'TASK', severity: 'ERROR', message: 'm' })
    ).not.toThrow();
    await vi.waitFor(() => expect(querySpy).toHaveBeenCalled());
    // 让 catch 分支执行完毕（无抛出即通过）
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
