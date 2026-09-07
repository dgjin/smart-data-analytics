import { describe, expect, it } from 'vitest';
import {
  selectRelevantTables,
  MAX_TABLES_IN_PROMPT,
  pruneWideTableColumns,
  extractExprColumns,
  metricColumnsByTable,
  WIDE_TABLE_COLUMN_THRESHOLD,
  MAX_COLUMNS_IN_WIDE_TABLE,
} from './schemaLinking';

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

/** 构造宽表：n 列，前 two 列带业务描述，可指定主键列 */
function makeWideTable(name: string, n: number, opts: { pk?: string; descMap?: Record<number, string> } = {}) {
  return {
    name,
    displayName: name,
    columns: Array.from({ length: n }, (_, i) => ({
      name: i === 0 && opts.pk ? opts.pk : `col_${i}`,
      type: 'string',
      description: opts.descMap?.[i] ?? `字段${i}`,
      isPrimaryKey: i === 0 && Boolean(opts.pk),
    })),
  };
}

describe('pruneWideTableColumns: P1-5 宽表列级裁剪', () => {
  it('窄表（≤阈值）不裁剪原样返回', () => {
    const narrow = makeTable('t', '窄表', ['a', 'b']);
    const { tables, pruned } = pruneWideTableColumns([narrow], '任意问题');
    expect(tables[0]).toBe(narrow); // 引用相等，未复制
    expect(pruned).toHaveLength(0);
  });

  it('宽表裁剪到 top-N：保留与问题相关的列，且保持原列顺序', () => {
    const wide = makeWideTable('fin', 204, { descMap: { 10: '投放金额', 20: '机构编号' } });
    const { tables, pruned } = pruneWideTableColumns([wide], '各机构投放金额汇总');
    expect(pruned).toEqual([{ table: 'fin', before: 204, after: MAX_COLUMNS_IN_WIDE_TABLE }]);
    const kept = tables[0].columns.map((c: any) => c.description);
    expect(kept).toContain('投放金额');
    expect(kept).toContain('机构编号');
    // 原顺序保留：kept 列在原表中的下标递增
    const idxs = tables[0].columns.map((c: any) => wide.columns.indexOf(c));
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  });

  it('主键与指标层引用列强制保留（即使与问题无关，top-N 之外也保留）', () => {
    const wide = makeWideTable('fin', 120, { pk: 'id' });
    // 指标引用一个与问题完全无关的列 col_99
    const { tables } = pruneWideTableColumns([wide], '机构投放金额', { fin: ['col_99'] });
    const names = tables[0].columns.map((c: any) => c.name);
    expect(names).toContain('id'); // 主键
    expect(names).toContain('col_99'); // 指标引用列
    // id 主键因 isPrimaryKey 打分加权本就在 top-N 内，仅 col_99 在 top-N 外额外保留
    expect(tables[0].columns.length).toBe(MAX_COLUMNS_IN_WIDE_TABLE + 1);
  });

  it('不修改入参（不可变性）', () => {
    const wide = makeWideTable('fin', 80);
    const before = wide.columns.length;
    pruneWideTableColumns([wide], '问题');
    expect(wide.columns.length).toBe(before);
  });
});

describe('extractExprColumns / metricColumnsByTable', () => {
  it('从聚合表达式提取列名并排除 SQL 关键字', () => {
    expect(extractExprColumns('SUM(HTZE) / COUNT(DISTINCT JGBH)')).toEqual(['HTZE', 'JGBH']);
    expect(extractExprColumns("CASE WHEN BB = '1' THEN JE ELSE 0 END")).toEqual(['BB', 'JE']);
    expect(extractExprColumns('')).toEqual([]);
  });

  it('指标引用列按表归组（expr + filters，去重）', () => {
    const out = metricColumnsByTable([
      { tableName: 'fin', expr: 'SUM(JE)', filters: "BB = '1' AND SJRQ >= '2026-01'" },
      { tableName: 'fin', expr: 'COUNT(DISTINCT JGBH)' },
      { tableName: 'orders', expr: 'SUM(amount)' },
    ]);
    expect(out.fin).toEqual(expect.arrayContaining(['JE', 'BB', 'SJRQ', 'JGBH']));
    expect(out.orders).toEqual(['amount']);
  });

  it('宽表阈值常量符合计划约定（>50 列触发，top-30 注入）', () => {
    expect(WIDE_TABLE_COLUMN_THRESHOLD).toBe(50);
    expect(MAX_COLUMNS_IN_WIDE_TABLE).toBe(30);
  });
});
