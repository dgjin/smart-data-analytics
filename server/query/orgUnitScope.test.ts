/**
 * 组织节点派生数据范围（IO 薄层）单元测试（v0.9.69）：
 * 鉴权链路「未显式配置 → 按所属组织派生」的取数与短路规则。
 * 覆盖：显式配置短路（不查组织树）、未绑定/节点缺失不派生、按层级派生、批量解析仅查一次树、查询异常上抛。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import { resolveEffectiveOrgScope, resolveEffectiveOrgScopes } from './orgUnitScope';

/** 组织树：总部 → 机构 → 部门（下辖 一团队、二团队） */
const treeRows = () => [
  { id: 1, parent_id: null, level: 'HQ', data_code: 'AH' },
  { id: 2, parent_id: 1, level: 'BRANCH', data_code: 'AH-B01' },
  { id: 3, parent_id: 2, level: 'DEPT', data_code: '一部门' },
  { id: 4, parent_id: 3, level: 'TEAM', data_code: '一团队' },
  { id: 5, parent_id: 3, level: 'TEAM', data_code: '二团队' },
];

const orgTreeCalls = () => querySpy.mock.calls.filter((c) => String(c[0]).includes('FROM org_units')).length;

beforeEach(() => {
  querySpy.mockReset();
  querySpy.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM org_units')) return [treeRows()];
    throw new Error(`[orgUnitScope.test] 未匹配的 SQL: ${String(sql)}`);
  });
});

describe('resolveEffectiveOrgScope：显式配置优先，缺省按所属组织派生', () => {
  it('显式 ORG → 直接用显式值，且不查组织树', async () => {
    expect(await resolveEffectiveOrgScope(JSON.stringify({ level: 'ORG', orgs: ['AH'] }), 3)).toEqual({
      level: 'ORG',
      orgs: ['AH'],
    });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('显式全辖 {"level":"ALL"} → null（不限制），不派生', async () => {
    expect(await resolveEffectiveOrgScope({ level: 'ALL' }, 3)).toBeNull();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('未配置 + 所属部门 → TEAM（本部门 + 下辖全部团队）', async () => {
    expect(await resolveEffectiveOrgScope(null, 3)).toEqual({ level: 'TEAM', teams: ['一部门', '一团队', '二团队'] });
  });

  it('未配置 + 所属机构 → ORG；所属总部 → null（全辖）', async () => {
    expect(await resolveEffectiveOrgScope(null, 2)).toEqual({ level: 'ORG', orgs: ['AH-B01'] });
    expect(await resolveEffectiveOrgScope(null, 1)).toBeNull();
  });

  it('未绑定组织节点 → null 且不查库；节点已删除 → null（查一次树后未命中）', async () => {
    expect(await resolveEffectiveOrgScope(null, null)).toBeNull();
    expect(querySpy).not.toHaveBeenCalled();
    expect(await resolveEffectiveOrgScope(null, 999)).toBeNull();
    expect(orgTreeCalls()).toBe(1);
  });

  it('组织树查询异常 → 向上抛出（由鉴权兜底 5xx，范围解析失败不静默放行）', async () => {
    querySpy.mockImplementation(async () => {
      throw new Error('db down');
    });
    await expect(resolveEffectiveOrgScope(null, 3)).rejects.toThrow('db down');
  });
});

describe('resolveEffectiveOrgScopes：管理端列表批量解析', () => {
  it('混合列表：仅未配置且有节点的用户派生，组织树只查一次', async () => {
    const res = await resolveEffectiveOrgScopes([
      { rawScope: { level: 'ORG', orgs: ['AH'] }, orgUnitId: 3 },
      { rawScope: null, orgUnitId: 3 },
      { rawScope: null, orgUnitId: 1 },
      { rawScope: null, orgUnitId: null },
    ]);
    expect(res[0]).toEqual({ effective: { level: 'ORG', orgs: ['AH'] }, derived: false });
    expect(res[1]).toEqual({ effective: { level: 'TEAM', teams: ['一部门', '一团队', '二团队'] }, derived: true });
    expect(res[2]).toEqual({ effective: null, derived: false });
    expect(res[3]).toEqual({ effective: null, derived: false });
    expect(orgTreeCalls()).toBe(1);
  });

  it('全部显式配置 → 完全不查组织树（含显式全辖 = 不限制）', async () => {
    const res = await resolveEffectiveOrgScopes([
      { rawScope: { level: 'ALL' }, orgUnitId: 3 },
      { rawScope: { level: 'SELF', selfCode: 'U1' }, orgUnitId: 3 },
    ]);
    expect(res[0]).toEqual({ effective: null, derived: false });
    expect(res[1]).toEqual({ effective: { level: 'SELF', selfCode: 'U1' }, derived: false });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('空列表 → 空数组且不查库', async () => {
    expect(await resolveEffectiveOrgScopes([])).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });
});
