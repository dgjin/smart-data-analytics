/**
 * v0.9.112 本体自动搭建规则引擎单测（纯函数）：
 * 覆盖编号-名称列对实体、表主题实体、枚举解析、跨表关联、分级列族层级与边界输入。
 */
import { describe, it, expect } from 'vitest';
import { buildOntologyDraft, parseEnumValues } from './ontologyAutoBuild';
import type { AutoBuildTable } from './ontologyAutoBuild';

const tables: AutoBuildTable[] = [
  {
    name: 'fct_fin',
    displayName: '财务宽表',
    description: '财务宽表',
    rowCount: 1000,
    columns: [
      { name: 'SJRQ', description: '数据日期（月末快照日期）', isDimension: true },
      { name: 'BB', description: '版本（1=核算版；2=分成版）', isDimension: true },
      { name: 'JGBH', description: '机构', isDimension: true },
      { name: 'JGMC', description: '机构名称', isDimension: true },
      { name: 'YJFL', description: '一级分类（取值如：主营业务、金融市场业务）', isDimension: true },
      { name: 'EJFL', description: '二级分类（取值如：处置类、收购处置类）', isDimension: true },
      { name: 'AMT', description: '金额（BB=1 防重复）', isMetric: true },
    ],
  },
  {
    name: 'fct_biz',
    displayName: '主营业务-业务粒度宽表',
    description: '主营业务',
    rowCount: 100,
    columns: [
      { name: 'BBRQ', description: '报表日期', isDimension: true },
      { name: 'JGBH', description: '机构编号', isDimension: true },
      { name: 'JGMC', description: '机构名称', isDimension: true },
      { name: 'YWBH', description: '业务', isDimension: true },
      { name: 'YWMC', description: '业务名称', isDimension: true },
      { name: 'SFYQ', description: '是否逾期（取值：是/否）', isDimension: true },
      { name: 'YWYJLB', description: '业务一级类别（如：不良资产相关业务、投资业务）', isDimension: true },
      { name: 'YWEJLB', description: '业务二级类别（如：收购处置类、重组类）', isDimension: true },
      { name: 'SSSF', description: '所属省', isDimension: true },
      { name: 'SSCS', description: '所属市', isDimension: true },
    ],
  },
];

describe('parseEnumValues', () => {
  it('解析 X=Y 枚举，忽略 SQL 片段', () => {
    const values = parseEnumValues("版本（1=核算版；2=分成版）；长龄数用 SUM(SFCL='是')");
    expect(values).toEqual([
      { code: '1', meaning: '核算版' },
      { code: '2', meaning: '分成版' },
    ]);
  });

  it('解析取值：是/否', () => {
    expect(parseEnumValues('是否逾期（取值：是/否）')).toEqual([
      { code: '是', meaning: '是' },
      { code: '否', meaning: '否' },
    ]);
  });

  it('解析取值如 / 如 列表，单项不当作枚举', () => {
    expect(parseEnumValues('一级分类（取值如：主营业务、金融市场业务）')).toHaveLength(2);
    expect(parseEnumValues('数据日期（如：2026-08-31）')).toHaveLength(0);
  });
});

describe('buildOntologyDraft', () => {
  const draft = buildOntologyDraft(tables);

  it('从表主题与编号-名称列对生成实体，合并跨表绑定', () => {
    const names = draft.entities.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['财务', '主营业务', '机构', '业务']));
    const org = draft.entities.find((e) => e.name === '机构');
    expect(org?.entityType).toBe('SUBJECT');
    expect(org?.bindings).toEqual(
      expect.arrayContaining([
        { tableName: 'fct_fin', columnName: 'JGBH', role: 'IDENTITY' },
        { tableName: 'fct_fin', columnName: 'JGMC', role: 'ATTRIBUTE' },
        { tableName: 'fct_biz', columnName: 'JGBH', role: 'IDENTITY' },
        { tableName: 'fct_biz', columnName: 'JGMC', role: 'ATTRIBUTE' },
      ]),
    );
    expect(org?.aliases).toEqual(expect.arrayContaining(['JGBH', 'JGMC']));
  });

  it('表主题实体带表级绑定与日期关联键', () => {
    const fin = draft.entities.find((e) => e.name === '财务');
    expect(fin?.bindings).toEqual(
      expect.arrayContaining([
        { tableName: 'fct_fin', columnName: '', role: 'IDENTITY' },
        { tableName: 'fct_fin', columnName: 'SJRQ', role: 'RELATION_KEY' },
      ]),
    );
  });

  it('生成值域释义并跳过指标列、同名列口径与同形文本取值', () => {
    expect(draft.valueNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tableName: 'fct_fin', columnName: 'BB', valueCode: '1', meaning: '核算版' }),
        expect.objectContaining({ tableName: 'fct_fin', columnName: 'BB', valueCode: '2', meaning: '分成版' }),
      ]),
    );
    expect(draft.valueNotes.some((v) => v.columnName === 'AMT')).toBe(false);
    expect(draft.valueNotes.some((v) => v.valueCode === v.columnName)).toBe(false);
    // 「取值如：主营业务、金融市场业务」这类同形文本取值已在 Schema 列说明中，不重复写入
    expect(draft.valueNotes.some((v) => v.columnName === 'YJFL' || v.columnName === 'SFYQ')).toBe(false);
    expect(draft.skipped.some((s) => s.includes('代码与含义同形'))).toBe(true);
  });

  it('跨表同名编号列生成 N:1 关联路径（大表为起点）', () => {
    expect(draft.relations).toHaveLength(1);
    expect(draft.relations[0]).toMatchObject({
      fromTable: 'fct_fin',
      fromColumns: ['JGBH'],
      toTable: 'fct_biz',
      toColumns: ['JGBH'],
      joinType: 'LEFT',
      cardinality: 'N:1',
    });
  });

  it('识别分级列族与地域列族生成业务层级', () => {
    const byName = new Map(draft.hierarchies.map((h) => [h.name, h.levels]));
    expect(byName.get('财务分类层级')).toEqual(['YJFL', 'EJFL']);
    expect(byName.get('业务类别层级')).toEqual(['YWYJLB', 'YWEJLB']);
    expect(byName.get('地域层级')).toEqual(['SSSF', 'SSCS']);
  });

  it('空输入返回空草案与提示', () => {
    const empty = buildOntologyDraft([]);
    expect(empty.entities).toHaveLength(0);
    expect(empty.valueNotes).toHaveLength(0);
    expect(empty.relations).toHaveLength(0);
    expect(empty.hierarchies).toHaveLength(0);
    expect(empty.skipped[0]).toContain('未提供有效表结构');
  });

  it('非法表名与列名被跳过', () => {
    const dirty = buildOntologyDraft([
      { name: 'bad-name', columns: [{ name: 'JGBH', description: '机构' }] },
      { name: 'ok_table', columns: [{ name: '1bad', description: '非法列' }] },
    ]);
    expect(dirty.stats.tables).toBe(1);
    expect(dirty.skipped.some((s) => s.includes('bad-name'))).toBe(true);
  });

  it('无枚举描述时在 skipped 中说明', () => {
    const noEnum = buildOntologyDraft([{ name: 't1', columns: [{ name: 'C1', description: '普通列' }] }]);
    expect(noEnum.valueNotes).toHaveLength(0);
    expect(noEnum.skipped.some((s) => s.includes('值域释义未生成'))).toBe(true);
  });
});
