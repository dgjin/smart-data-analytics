import { describe, expect, it } from 'vitest';
import { selectRelevantTables, MAX_TABLES_IN_PROMPT } from './schemaLinking';

function makeTable(name: string, displayName: string, colDescs: string[] = [], description = '') {
  return {
    name,
    displayName,
    description,
    columns: colDescs.map((d, i) => ({ name: `col_${i}`, description: d })),
  };
}

describe('selectRelevantTables: Schema Linking 自动圈表', () => {
  it('表数不超过上限时全量返回（小库无召回损失）', () => {
    const schema = [makeTable('a', '客户表'), makeTable('b', '订单表')];
    expect(selectRelevantTables(schema, '客户数量')).toHaveLength(2);
  });

  it('大 schema 时圈定与问题最相关的表', () => {
    const schema = [
      makeTable('t1', '客户表', ['客户类型', '客户名称']),
      makeTable('t2', '订单表', ['订单金额']),
      makeTable('t3', '拜访记录表', ['拜访时间']),
      ...Array.from({ length: 10 }, (_, i) => makeTable(`tx${i}`, `无关表${i}`, ['无关字段'])),
    ];
    const picked = selectRelevantTables(schema, '各客户类型的客户数量');
    expect(picked.length).toBeLessThanOrEqual(MAX_TABLES_IN_PROMPT);
    expect(picked.map((t) => t.displayName)).toContain('客户表');
    expect(picked.map((t) => t.displayName)).not.toContain('无关表9');
  });

  it('结果保持原 schema 相对顺序（prompt 稳定）', () => {
    const schema = [
      makeTable('t1', '订单表', ['订单金额']),
      makeTable('t2', '客户表', ['客户类型']),
      ...Array.from({ length: 10 }, (_, i) => makeTable(`tx${i}`, `杂表${i}`)),
    ];
    const picked = selectRelevantTables(schema, '客户类型与订单金额', 2);
    expect(picked.map((t) => t.name)).toEqual(['t1', 't2']);
  });

  it('全部 0 分时退化为前 N 张表（行为可预期）', () => {
    const schema = Array.from({ length: 12 }, (_, i) => makeTable(`t${i}`, `表${i}`));
    const picked = selectRelevantTables(schema, 'zzz 完全无关的问题');
    expect(picked.map((t) => t.name)).toEqual(schema.slice(0, MAX_TABLES_IN_PROMPT).map((t) => t.name));
  });

  it('空 schema 与非数组输入安全返回空', () => {
    expect(selectRelevantTables([], '问题')).toEqual([]);
    expect(selectRelevantTables(null as any, '问题')).toEqual([]);
  });
});
