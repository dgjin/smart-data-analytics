import { describe, expect, it } from 'vitest';
import { buildContextSummary } from './queryContext';
import { MAX_TABLES_IN_PROMPT } from '../query/schemaLinking';

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

  it('v0.9.65 组织数据范围：档位描述下发，谓词已生效时标记 applied', () => {
    const out = buildContextSummary({ ...ctxBase, orgScopeHint: '【数据范围约束（系统级强制）】' }, false, {
      level: 'ORG',
      orgs: ['A01'],
    });
    expect(out.dataScope).toBe('本机构：A01');
    expect(out.dataScopeApplied).toBe(true);
  });

  it('数据源未配置组织隔离列（无谓词）时保留描述但标记未生效', () => {
    const out = buildContextSummary(ctxBase, false, { level: 'TEAM', teams: ['T1'] });
    expect(out.dataScope).toBe('本项目团队：T1');
    expect(out.dataScopeApplied).toBe(false);
  });

  it('未配置数据范围（存量用户）不下发范围描述', () => {
    const out = buildContextSummary(ctxBase, true);
    expect(out.dataScope).toBeNull();
    expect(out.dataScopeApplied).toBe(false);
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
