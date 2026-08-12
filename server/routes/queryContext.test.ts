import { describe, expect, it } from 'vitest';
import { buildContextSummary } from './queryContext';
import { MAX_TABLES_IN_PROMPT } from '../schemaLinking';

const ctxBase = {
  schema: [
    { name: 'orders', displayName: '订单表', columns: [] },
    { name: 'customers', columns: [] },
  ],
  sensitiveRemoved: ['orders.id_card'],
  status: 'connected',
  dsType: 'mysql',
};

describe('buildContextSummary: 问数上下文摘要（显示范围与实际问数同源）', () => {
  it('管理员可见表级明细与敏感过滤数', () => {
    const out = buildContextSummary(ctxBase, true);
    expect(out.tableCount).toBe(2);
    expect(out.tables).toEqual([
      { name: 'orders', displayName: '订单表' },
      { name: 'customers', displayName: 'customers' },
    ]);
    expect(out.sensitiveFiltered).toBe(1);
    expect(out.status).toBe('connected');
    expect(out.maxTablesInPrompt).toBe(MAX_TABLES_IN_PROMPT);
  });

  it('非管理员仅暴露数量，不返回表名清单', () => {
    const out = buildContextSummary(ctxBase, false);
    expect(out.tableCount).toBe(2);
    expect(out.tables).toEqual([]);
  });

  it('scope 过滤后为空时 tableCount 为 0（前端据此提示问数范围为空）', () => {
    const out = buildContextSummary({ ...ctxBase, schema: [] }, true);
    expect(out.tableCount).toBe(0);
    expect(out.tables).toEqual([]);
  });

  it('未落库数据源（演示模式 status=null）原样透传', () => {
    const out = buildContextSummary(
      { schema: [{ name: 't1' }], sensitiveRemoved: [], status: null, dsType: null },
      true
    );
    expect(out.status).toBeNull();
    expect(out.dsType).toBeNull();
    expect(out.tableCount).toBe(1);
  });
});
