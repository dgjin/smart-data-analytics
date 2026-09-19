import { describe, expect, it } from 'vitest';
import { buildOrgDataCode, suggestOrgDataCode } from './orgDataCode';
import type { OrgUnit } from '../types/analytics';

const unit = (over: Partial<OrgUnit>): OrgUnit => ({
  id: 1,
  parentId: null,
  level: 'BRANCH',
  name: '节点',
  dataCode: '',
  sortOrder: 10,
  userCount: 0,
  childCount: 0,
  ...over,
});

describe('buildOrgDataCode：层级路径编号（与服务端 buildDataCode 同规则）', () => {
  it('机构：空集合 → BR01；已有 BR01/BR02 → BR03', () => {
    expect(buildOrgDataCode('BRANCH', '', [])).toBe('BR01');
    expect(buildOrgDataCode('BRANCH', '', ['BR01', 'BR02'])).toBe('BR03');
  });

  it('部门：以机构编码为前缀，按同前缀序号递增', () => {
    expect(buildOrgDataCode('DEPT', 'BR01', [])).toBe('BR01-D01');
    expect(buildOrgDataCode('DEPT', 'BR01', ['BR01-D01', 'BR01-D02', 'BR02-D01'])).toBe('BR01-D03');
  });

  it('团队：以部门编码为前缀', () => {
    expect(buildOrgDataCode('TEAM', 'BR01-D01', [])).toBe('BR01-D01-T01');
    expect(buildOrgDataCode('TEAM', 'BR01-D01', ['BR01-D01-T01'])).toBe('BR01-D01-T02');
  });

  it('父编码缺失 → 退化为 D01 / T01；总部不参与编码', () => {
    expect(buildOrgDataCode('DEPT', '', [])).toBe('D01');
    expect(buildOrgDataCode('TEAM', '', ['T01', 'T02'])).toBe('T03');
    expect(buildOrgDataCode('HQ', '', [])).toBe('');
  });

  it('序号两位补零，超过 99 自然进位', () => {
    expect(buildOrgDataCode('BRANCH', '', ['BR09'])).toBe('BR10');
    expect(buildOrgDataCode('BRANCH', '', ['BR99'])).toBe('BR100');
  });

  it('手动业务编码不干扰序号识别（仅同前缀精确匹配）', () => {
    expect(buildOrgDataCode('BRANCH', '', ['AH', 'BR02', 'BR01'])).toBe('BR03');
    expect(buildOrgDataCode('DEPT', 'BR01', ['BR010-D01'])).toBe('BR01-D01');
  });
});

describe('suggestOrgDataCode：新增下级弹窗预填', () => {
  it('机构：忽略父级编码，按树内 BR 前缀递增', () => {
    const units = [unit({ id: 2, dataCode: 'BR01' }), unit({ id: 3, dataCode: 'AH' })];
    expect(suggestOrgDataCode(units, unit({ id: 1, level: 'HQ', name: '总部', dataCode: '' }), 'BRANCH')).toBe('BR02');
  });

  it('部门：父机构数据标识作为前缀（手填业务编码同样生效）', () => {
    const parent = unit({ id: 2, level: 'BRANCH', name: '安徽分公司', dataCode: 'AH' });
    const units = [
      parent,
      unit({ id: 4, level: 'DEPT', parentId: 2, dataCode: 'AH-D01' }),
      unit({ id: 5, level: 'DEPT', parentId: 3, dataCode: 'BR01-D01' }),
    ];
    expect(suggestOrgDataCode(units, parent, 'DEPT')).toBe('AH-D02');
  });

  it('团队：父部门编码作为前缀，父级无编码时退化', () => {
    const parent = unit({ id: 4, level: 'DEPT', parentId: 2, dataCode: 'AH-D01' });
    expect(suggestOrgDataCode([parent], parent, 'TEAM')).toBe('AH-D01-T01');
    const bare = unit({ id: 5, level: 'DEPT', parentId: 2, dataCode: '' });
    expect(suggestOrgDataCode([bare], bare, 'TEAM')).toBe('T01');
  });
});
