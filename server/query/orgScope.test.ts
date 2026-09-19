/**
 * 组织数据范围（orgScope）单元测试：三层组织权限模型的解析与谓词生成纯函数。
 * 覆盖点：档位解析兜底（NULL/ALL/空值 = 不限制）、列映射校验、逐表大小写不敏感匹配、
 * 单值 =/多值 IN、字面量转义、同表 AND 合并、缓存指纹分桶、提示词文案。
 */
import { describe, expect, it } from 'vitest';
import {
  buildOrgRowFilters,
  buildUnitScopeIndex,
  deriveOrgScopeFromUnit,
  describeOrgScope,
  hasExplicitOrgScope,
  mergeRowFilters,
  orgScopeFingerprint,
  orgScopePromptHint,
  parseOrgColumns,
  parseUserOrgScope,
  resolveOrgScopeWithUnit,
  type OrgColumns,
  type OrgUnitScopeSource,
  type UserOrgScope,
} from './orgScope';
import type { SchemaTable } from './schemaTypes';

const COLS: OrgColumns = { org: 'JGBH', team: 'SSTD', owner: 'XMJBRBH' };

const tables = (): SchemaTable[] => [
  { name: 'dn_tzsy', columns: [{ name: 'JGBH' }, { name: 'JGMC' }, { name: 'SSTD' }, { name: 'XMJBRBH' }, { name: 'BNTFJE' }] },
  { name: 'dim_org', columns: [{ name: 'jgbh' }, { name: 'jbmc' }] },
  { name: 'dim_calendar', columns: [{ name: 'dt' }] },
];

describe('parseUserOrgScope：档位解析与防御性兜底', () => {
  it('NULL / 空 / ALL 档位 → null（不限制）', () => {
    expect(parseUserOrgScope(null)).toBeNull();
    expect(parseUserOrgScope(undefined)).toBeNull();
    expect(parseUserOrgScope('')).toBeNull();
    expect(parseUserOrgScope({ level: 'ALL' })).toBeNull();
    expect(parseUserOrgScope({ level: 'all' })).toBeNull();
  });

  it('非法档位 → null（不因脏数据误锁用户）', () => {
    expect(parseUserOrgScope({ level: 'UNKNOWN' })).toBeNull();
    expect(parseUserOrgScope('not-json')).toBeNull();
    expect(parseUserOrgScope([1, 2])).toBeNull();
  });

  it('ORG 档：机构列表清洗（去空白/剔空/去重/保持顺序）', () => {
    const scope = parseUserOrgScope({ level: 'ORG', orgs: [' A01 ', 'A02', '', 'A01', '  '] });
    expect(scope).toEqual({ level: 'ORG', orgs: ['A01', 'A02'] });
    // 配了档位却没给值：按不限制处理（管理端保存会拒绝，此处兜底避免锁死）
    expect(parseUserOrgScope({ level: 'ORG', orgs: [] })).toBeNull();
  });

  it('ORG 档：支持 JSON 文本（落库形态）', () => {
    expect(parseUserOrgScope('{"level":"ORG","orgs":["A01"]}')).toEqual({ level: 'ORG', orgs: ['A01'] });
  });

  it('TEAM 档：团队必填，机构可选（双重收敛）', () => {
    expect(parseUserOrgScope({ level: 'TEAM', teams: ['T1'] })).toEqual({ level: 'TEAM', teams: ['T1'] });
    expect(parseUserOrgScope({ level: 'TEAM', teams: ['T1'], orgs: ['A01'] })).toEqual({ level: 'TEAM', teams: ['T1'], orgs: ['A01'] });
    expect(parseUserOrgScope({ level: 'TEAM' })).toBeNull();
  });

  it('SELF 档：经办人编号必填', () => {
    expect(parseUserOrgScope({ level: 'SELF', selfCode: ' U100 ' })).toEqual({ level: 'SELF', selfCode: 'U100' });
    expect(parseUserOrgScope({ level: 'SELF' })).toBeNull();
  });
});

describe('parseOrgColumns：数据源组织列映射', () => {
  it('合法三列全部保留；大小写不限', () => {
    expect(parseOrgColumns({ org: 'JGBH', team: 'sstd', owner: 'XMJBRBH' })).toEqual({ org: 'JGBH', team: 'sstd', owner: 'XMJBRBH' });
  });

  it('部分配置：未配置的维度为 undefined', () => {
    expect(parseOrgColumns({ org: 'JGBH' })).toEqual({ org: 'JGBH', team: undefined, owner: undefined });
  });

  it('全空 / NULL → null（该数据源不做组织隔离）', () => {
    expect(parseOrgColumns(null)).toBeNull();
    expect(parseOrgColumns({})).toBeNull();
    expect(parseOrgColumns({ org: '  ' })).toBeNull();
  });

  it('非标识符列名被丢弃（防配置面注入）', () => {
    expect(parseOrgColumns({ org: 'JGBH; DROP TABLE x' })).toBeNull();
    expect(parseOrgColumns({ org: 'a b' })).toBeNull();
  });
});

describe('buildOrgRowFilters：行过滤谓词生成', () => {
  it('ORG 档：仅匹配到机构列的表生成谓词，无该列的表放行', () => {
    const scope: UserOrgScope = { level: 'ORG', orgs: ['A01', 'A02'] };
    expect(buildOrgRowFilters(tables(), COLS, scope)).toEqual({
      dn_tzsy: "JGBH IN ('A01', 'A02')",
      // 列名大小写不敏感匹配，谓词用表内真实列名 jgbh
      dim_org: "jgbh IN ('A01', 'A02')",
    });
  });

  it('单值用 = 而非 IN', () => {
    expect(buildOrgRowFilters(tables(), COLS, { level: 'ORG', orgs: ['A01'] })).toEqual({
      dn_tzsy: "JGBH = 'A01'",
      dim_org: "jgbh = 'A01'",
    });
  });

  it('TEAM 档：团队列谓词；同时登记机构时同表 AND 收敛', () => {
    expect(buildOrgRowFilters(tables(), COLS, { level: 'TEAM', teams: ['团队一'] })).toEqual({
      dn_tzsy: "SSTD = '团队一'",
    });
    expect(buildOrgRowFilters(tables(), COLS, { level: 'TEAM', teams: ['团队一'], orgs: ['A01'] })).toEqual({
      dn_tzsy: "SSTD = '团队一' AND JGBH = 'A01'",
      // 无团队列但有机构列的表：仍按机构收敛
      dim_org: "jgbh = 'A01'",
    });
  });

  it('SELF 档：按经办人列等值过滤', () => {
    expect(buildOrgRowFilters(tables(), COLS, { level: 'SELF', selfCode: 'U100' })).toEqual({
      dn_tzsy: "XMJBRBH = 'U100'",
    });
  });

  it('单引号字面量转义（防拼接注入）', () => {
    const cols: OrgColumns = { org: 'JGBH' };
    expect(buildOrgRowFilters(tables(), cols, { level: 'ORG', orgs: ["A'01"] })).toEqual({ dn_tzsy: "JGBH = 'A''01'", dim_org: "jgbh = 'A''01'" });
  });

  it('未配置列映射 / 未配置范围 → 空谓词（与现状行为一致）', () => {
    expect(buildOrgRowFilters(tables(), null, { level: 'ORG', orgs: ['A01'] })).toEqual({});
    expect(buildOrgRowFilters(tables(), COLS, null)).toEqual({});
    // owner 列未配置时 SELF 档不产生任何过滤
    expect(buildOrgRowFilters(tables(), { org: 'JGBH' }, { level: 'SELF', selfCode: 'U100' })).toEqual({});
  });
});

describe('mergeRowFilters：数据源级 + 用户级合并', () => {
  it('同表 AND，异表各自保留', () => {
    expect(mergeRowFilters({ a: 'x = 1' }, { a: 'y = 2', b: 'z = 3' })).toEqual({
      a: '(x = 1) AND (y = 2)',
      b: 'z = 3',
    });
  });

  it('空值容错', () => {
    expect(mergeRowFilters(null, { a: 'x = 1' })).toEqual({ a: 'x = 1' });
    expect(mergeRowFilters({ a: 'x = 1' }, null)).toEqual({ a: 'x = 1' });
    expect(mergeRowFilters({ a: 'x = 1' }, {})).toEqual({ a: 'x = 1' });
  });
});

describe('orgScopeFingerprint：结果缓存分桶', () => {
  it('不限制 → 空串（存量缓存键不变）', () => {
    expect(orgScopeFingerprint(null)).toBe('');
    expect(orgScopeFingerprint(undefined)).toBe('');
  });

  it('同范围稳定、异范围不同（机构顺序不影响结果）', () => {
    const a = orgScopeFingerprint({ level: 'ORG', orgs: ['A01', 'A02'] });
    expect(a).toHaveLength(16);
    expect(orgScopeFingerprint({ level: 'ORG', orgs: ['A02', 'A01'] })).toBe(a);
    expect(orgScopeFingerprint({ level: 'ORG', orgs: ['A03'] })).not.toBe(a);
    expect(orgScopeFingerprint({ level: 'SELF', selfCode: 'A01' })).not.toBe(a);
  });
});

describe('describeOrgScope / orgScopePromptHint：文案', () => {
  it('范围描述按档位输出', () => {
    expect(describeOrgScope(null)).toBe('全辖（不限制）');
    expect(describeOrgScope({ level: 'ORG', orgs: ['A01'] })).toBe('本机构：A01');
    expect(describeOrgScope({ level: 'SELF', selfCode: 'U100' })).toBe('仅本人经办：U100');
  });

  it('提示词包含范围描述与实际注入谓词；无谓词时为空串', () => {
    const hint = orgScopePromptHint(COLS, { level: 'ORG', orgs: ['A01'] });
    expect(hint).toContain('本机构：A01');
    expect(hint).toContain("JGBH = 'A01'");
    expect(orgScopePromptHint(null, { level: 'ORG', orgs: ['A01'] })).toBe('');
    expect(orgScopePromptHint(COLS, null)).toBe('');
    // SELF 档但未登记责任人列：无实际过滤 → 不产生提示（避免误导 LLM）
    expect(orgScopePromptHint({ org: 'JGBH' }, { level: 'SELF', selfCode: 'U100' })).toBe('');
  });
});

// v0.9.69 用户「所属组织」→ 数据范围派生（未显式配置时的缺省隔离）
/** 构造节点来源（level 取运行时可出现的任意非法值，验证防御） */
const unitOf = (level: string, dataCode: string, descendantCodes?: string[]) =>
  ({ level, dataCode, descendantCodes }) as unknown as OrgUnitScopeSource;

describe('deriveOrgScopeFromUnit：按所属组织节点派生范围', () => {
  it('总部 → null（全辖不限制）', () => {
    expect(deriveOrgScopeFromUnit(unitOf('HQ', 'AH'))).toBeNull();
  });

  it('机构 → ORG（本机构编号）', () => {
    expect(deriveOrgScopeFromUnit(unitOf('BRANCH', 'AH'))).toEqual({ level: 'ORG', orgs: ['AH'] });
  });

  it('部门 → TEAM（本部门 + 下辖全部团队，去重剔空保序）', () => {
    expect(deriveOrgScopeFromUnit(unitOf('DEPT', 'D01', ['T01', 'T02', 'D01', ' ']))).toEqual({
      level: 'TEAM',
      teams: ['D01', 'T01', 'T02'],
    });
  });

  it('团队 → TEAM（仅本团队）；层级大小写不敏感', () => {
    expect(deriveOrgScopeFromUnit(unitOf('TEAM', 'T01'))).toEqual({ level: 'TEAM', teams: ['T01'] });
    expect(deriveOrgScopeFromUnit(unitOf('team', 'T09'))).toEqual({ level: 'TEAM', teams: ['T09'] });
  });

  it('数据标识为空 / 节点缺失 / 层级未知 → null（防御：无值可匹配时不误隔离）', () => {
    expect(deriveOrgScopeFromUnit(null)).toBeNull();
    expect(deriveOrgScopeFromUnit(undefined)).toBeNull();
    expect(deriveOrgScopeFromUnit(unitOf('BRANCH', '  '))).toBeNull();
    expect(deriveOrgScopeFromUnit(unitOf('DEPT', ''))).toBeNull();
    expect(deriveOrgScopeFromUnit(unitOf('TEAM', ''))).toBeNull();
    expect(deriveOrgScopeFromUnit(unitOf('UNKNOWN', 'X'))).toBeNull();
  });
});

describe('resolveOrgScopeWithUnit / hasExplicitOrgScope：显式配置优先', () => {
  const dept = unitOf('DEPT', 'D01', ['T01']);

  it('显式 ORG/SELF → 用显式值，忽略所属组织', () => {
    expect(resolveOrgScopeWithUnit({ level: 'ORG', orgs: ['AH'] }, dept)).toEqual({ level: 'ORG', orgs: ['AH'] });
    expect(resolveOrgScopeWithUnit({ level: 'SELF', selfCode: 'U1' }, dept)).toEqual({ level: 'SELF', selfCode: 'U1' });
  });

  it('显式 ALL → 判定为已配置，解析为 null（全辖），不回落到组织派生', () => {
    expect(hasExplicitOrgScope({ level: 'ALL' })).toBe(true);
    expect(hasExplicitOrgScope('{"level":"ALL"}')).toBe(true);
    expect(resolveOrgScopeWithUnit({ level: 'ALL' }, dept)).toBeNull();
  });

  it('NULL / 非法 JSON / 非法档位 → 未配置，按所属组织派生', () => {
    expect(hasExplicitOrgScope(null)).toBe(false);
    expect(hasExplicitOrgScope('{bad json')).toBe(false);
    expect(hasExplicitOrgScope({ level: 'NOPE' })).toBe(false);
    expect(resolveOrgScopeWithUnit(null, dept)).toEqual({ level: 'TEAM', teams: ['D01', 'T01'] });
    expect(resolveOrgScopeWithUnit({ level: 'NOPE' }, dept)).toEqual({ level: 'TEAM', teams: ['D01', 'T01'] });
  });

  it('未配置且未绑定节点 → null（不限制）', () => {
    expect(resolveOrgScopeWithUnit(null, null)).toBeNull();
  });
});

describe('buildUnitScopeIndex：扁平组织树 → 派生来源索引', () => {
  // 总部 → 机构 → 部门（下辖 一团队 → 子团队、二团队）；另挂一个无父节点团队
  const rows = [
    { id: 1, parentId: null, level: 'HQ', dataCode: 'AH' },
    { id: 2, parentId: 1, level: 'BRANCH', dataCode: 'AH-B01' },
    { id: 3, parentId: 2, level: 'DEPT', dataCode: '一部门' },
    { id: 4, parentId: 3, level: 'TEAM', dataCode: '一团队' },
    { id: 5, parentId: 3, level: 'TEAM', dataCode: '二团队' },
    { id: 6, parentId: 4, level: 'TEAM', dataCode: '子团队' },
    { id: 7, parentId: null, level: 'TEAM', dataCode: '孤立团队' },
  ];

  it('部门节点收集全部后代数据标识（多级展开）', () => {
    const index = buildUnitScopeIndex(rows);
    expect(deriveOrgScopeFromUnit(index.get(3))).toEqual({ level: 'TEAM', teams: ['一部门', '一团队', '二团队', '子团队'] });
  });

  it('机构节点仅按自身数据标识（不向下级收敛）', () => {
    const index = buildUnitScopeIndex(rows);
    expect(deriveOrgScopeFromUnit(index.get(2))).toEqual({ level: 'ORG', orgs: ['AH-B01'] });
  });

  it('团队节点 → 仅本团队（不向下收敛）；叶子与孤立节点仅自身', () => {
    const index = buildUnitScopeIndex(rows);
    // 所属团队只授予本团队数据（下层节点由其自身归属的用户分别授权）
    expect(deriveOrgScopeFromUnit(index.get(4))).toEqual({ level: 'TEAM', teams: ['一团队'] });
    expect(deriveOrgScopeFromUnit(index.get(5))).toEqual({ level: 'TEAM', teams: ['二团队'] });
    expect(deriveOrgScopeFromUnit(index.get(7))).toEqual({ level: 'TEAM', teams: ['孤立团队'] });
  });

  it('空树与非法行（缺 id）→ 空索引，不报错', () => {
    expect(buildUnitScopeIndex([]).size).toBe(0);
    const index = buildUnitScopeIndex([{ id: NaN, parentId: null, level: 'TEAM', dataCode: 'X' }]);
    expect(index.size).toBe(0);
  });
});
