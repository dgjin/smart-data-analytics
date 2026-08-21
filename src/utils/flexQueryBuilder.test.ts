import { describe, expect, it } from 'vitest';
import {
  buildFlexQuerySql,
  filterValueToSql,
  measureAlias,
  betweenParts,
  aggExpression,
  FlexQueryConfig,
} from './flexQueryBuilder';
import { TableSchema } from '../types/analytics';

const TABLE: TableSchema = {
  id: 't1',
  name: 'fct_jc_main_biz_stat',
  displayName: '主营业务宽表',
  description: '',
  rowCount: 100,
  columns: [
    { name: 'JGMC', type: 'string' },
    { name: 'BNTFJE', type: 'number' },
    { name: 'SJRQ', type: 'date' },
  ],
};

const base = (over: Partial<FlexQueryConfig> = {}): FlexQueryConfig => ({
  table: 'fct_jc_main_biz_stat',
  dimensions: ['JGMC'],
  measures: [{ column: 'BNTFJE', agg: 'SUM' }],
  filters: [],
  havings: [],
  orderBy: { by: 'sum_bntfje', dir: 'desc' },
  limit: 100,
  ...over,
});

describe('buildFlexQuerySql: 灵活查询 SQL 构建（v0.4.9 基线）', () => {
  it('标准维度+指标构建（MySQL 反引号方言）', () => {
    const out = buildFlexQuerySql(base(), TABLE, 'mysql');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toBe(
        'SELECT `JGMC`, SUM(`BNTFJE`) AS `sum_bntfje` FROM `fct_jc_main_biz_stat` GROUP BY `JGMC` ORDER BY `sum_bntfje` DESC LIMIT 100'
      );
    }
  });

  it('PG 方言使用双引号标识符', () => {
    const out = buildFlexQuerySql(base({ orderBy: null }), TABLE, 'pg');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('FROM "fct_jc_main_biz_stat"');
  });

  it('全表聚合（无维度）不生成 GROUP BY', () => {
    const out = buildFlexQuerySql(base({ dimensions: [], orderBy: null }), TABLE, 'mysql');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).not.toContain('GROUP BY');
      expect(out.sql).toContain('SELECT SUM(`BNTFJE`)');
    }
  });

  it('筛选条件：数值不加引号、字符串单引号加倍转义防注入', () => {
    const out = buildFlexQuerySql(
      base({
        filters: [
          { column: 'BNTFJE', op: '>', value: '100' },
          { column: 'JGMC', op: 'LIKE', value: "北京'; DROP TABLE x;--" },
        ],
      }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('`BNTFJE` > 100');
      expect(out.sql).toContain("'%北京''; DROP TABLE x;--%'");
      // 单引号已加倍转义，字面量无法被提前终结（未出现未配对的单引号）
      expect(out.sql.includes("北京' ")).toBe(false);
    }
  });

  it('IN 筛选：中英文逗号分割、数值与字符串分别处理', () => {
    const out = buildFlexQuerySql(
      base({ filters: [{ column: 'JGMC', op: 'IN', value: '北京,上海，1' }] }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain("`JGMC` IN ('北京', '上海', 1)");
  });

  it('维度/指标/筛选列不在 schema 白名单内 → 拒绝', () => {
    expect(buildFlexQuerySql(base({ dimensions: ['EVIL'] }), TABLE, 'mysql').ok).toBe(false);
    expect(buildFlexQuerySql(base({ measures: [{ column: 'EVIL', agg: 'SUM' }] }), TABLE, 'mysql').ok).toBe(false);
    expect(
      buildFlexQuerySql(base({ filters: [{ column: 'EVIL', op: '=', value: '1' }] }), TABLE, 'mysql').ok
    ).toBe(false);
  });

  it('非法标识符字符（含空格/引号）→ 拒绝', () => {
    const hacked: TableSchema = { ...TABLE, columns: [...TABLE.columns, { name: 'A B', type: 'string' }] };
    expect(buildFlexQuerySql(base({ dimensions: ['A B'] }), hacked, 'mysql').ok).toBe(false);
  });

  it('维度与指标均为空 → 拒绝；limit 越界收敛到 [1,100000]', () => {
    expect(buildFlexQuerySql(base({ dimensions: [], measures: [] }), TABLE, 'mysql').ok).toBe(false);
    const out = buildFlexQuerySql(base({ limit: 999999 }), TABLE, 'mysql');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('LIMIT 100000');
  });

  it('筛选值为空 → 拒绝', () => {
    const out = buildFlexQuerySql(base({ filters: [{ column: 'JGMC', op: '=', value: '  ' }] }), TABLE, 'mysql');
    expect(out.ok).toBe(false);
  });

  it('表与 schema 不一致 / 未选表 → 拒绝', () => {
    expect(buildFlexQuerySql(base(), undefined, 'mysql').ok).toBe(false);
    expect(buildFlexQuerySql(base({ table: 'other' }), TABLE, 'mysql').ok).toBe(false);
  });

  it('filterValueToSql 与 measureAlias 辅助函数', () => {
    expect(filterValueToSql('=', '3.14')).toBe('3.14');
    expect(filterValueToSql('=', "O'Hara")).toBe("'O''Hara'");
    expect(filterValueToSql('IN', '')).toBe("('')");
    expect(measureAlias({ column: 'BNTFJE', agg: 'AVG' })).toBe('avg_bntfje');
    expect(measureAlias({ column: 'BNTFJE', agg: 'COUNT_DISTINCT' })).toBe('countd_bntfje');
    expect(aggExpression('COUNT_DISTINCT', '`JGMC`')).toBe('COUNT(DISTINCT `JGMC`)');
  });
});

describe('buildFlexQuerySql: v0.4.10 Agile Query 式增强', () => {
  it('COUNT_DISTINCT 去重计数：表达式与别名', () => {
    const out = buildFlexQuerySql(
      base({ measures: [{ column: 'JGMC', agg: 'COUNT_DISTINCT' }], orderBy: null }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('COUNT(DISTINCT `JGMC`) AS `countd_jgmc`');
  });

  it('BETWEEN 区间筛选：数值端点不加引号、字符串端点转义', () => {
    const out = buildFlexQuerySql(
      base({ filters: [{ column: 'BNTFJE', op: 'BETWEEN', value: '100, 500' }] }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('`BNTFJE` BETWEEN 100 AND 500');

    const str = buildFlexQuerySql(
      base({ filters: [{ column: 'SJRQ', op: 'BETWEEN', value: '2026-01，2026-08' }] }),
      TABLE,
      'mysql',
    );
    expect(str.ok).toBe(true);
    if (str.ok) expect(str.sql).toContain("`SJRQ` BETWEEN '2026-01' AND '2026-08'");
  });

  it('BETWEEN 端点数量错误 → 拒绝', () => {
    expect(
      buildFlexQuerySql(base({ filters: [{ column: 'BNTFJE', op: 'BETWEEN', value: '100' }] }), TABLE, 'mysql').ok
    ).toBe(false);
    expect(
      buildFlexQuerySql(base({ filters: [{ column: 'BNTFJE', op: 'BETWEEN', value: '1,2,3' }] }), TABLE, 'mysql').ok
    ).toBe(false);
    expect(betweenParts('a,b,c')).toBeNull();
  });

  it('IS NULL / IS NOT NULL 无需值且空值不报错', () => {
    const out = buildFlexQuerySql(
      base({
        filters: [
          { column: 'JGMC', op: 'IS NULL', value: '' },
          { column: 'SJRQ', op: 'IS NOT NULL', value: '   ' },
        ],
      }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('`JGMC` IS NULL');
      expect(out.sql).toContain('`SJRQ` IS NOT NULL');
    }
  });

  it('指标过滤（HAVING）：重复聚合表达式写法（全方言安全）', () => {
    const out = buildFlexQuerySql(
      base({ havings: [{ agg: 'SUM', column: 'BNTFJE', op: '>', value: '10000' }] }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('GROUP BY `JGMC` HAVING SUM(`BNTFJE`) > 10000 ORDER BY');
    }
  });

  it('指标过滤：列白名单校验与空值拒绝', () => {
    expect(
      buildFlexQuerySql(base({ havings: [{ agg: 'SUM', column: 'EVIL', op: '>', value: '1' }] }), TABLE, 'mysql').ok
    ).toBe(false);
    expect(
      buildFlexQuerySql(base({ havings: [{ agg: 'SUM', column: 'BNTFJE', op: '>', value: ' ' }] }), TABLE, 'mysql')
        .ok
    ).toBe(false);
    // LIKE 不在指标过滤操作符内
    expect(
      buildFlexQuerySql(
        base({ havings: [{ agg: 'SUM', column: 'BNTFJE', op: 'LIKE' as any, value: 'x' }] }),
        TABLE,
        'mysql',
      ).ok
    ).toBe(false);
  });

  it('排序目标可选任一指标别名或维度列；非法目标拒绝', () => {
    const byDim = buildFlexQuerySql(base({ orderBy: { by: 'JGMC', dir: 'asc' } }), TABLE, 'mysql');
    expect(byDim.ok).toBe(true);
    if (byDim.ok) expect(byDim.sql).toContain('ORDER BY `JGMC` ASC');

    const bySecond = buildFlexQuerySql(
      base({
        measures: [
          { column: 'BNTFJE', agg: 'SUM' },
          { column: 'BNTFJE', agg: 'COUNT' },
        ],
        orderBy: { by: 'count_bntfje', dir: 'desc' },
      }),
      TABLE,
      'mysql',
    );
    expect(bySecond.ok).toBe(true);
    if (bySecond.ok) expect(bySecond.sql).toContain('ORDER BY `count_bntfje` DESC');

    expect(buildFlexQuerySql(base({ orderBy: { by: 'evil_alias', dir: 'desc' } }), TABLE, 'mysql').ok).toBe(false);
  });

  it('orderBy 为 null 时不生成 ORDER BY', () => {
    const out = buildFlexQuerySql(base({ orderBy: null }), TABLE, 'mysql');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).not.toContain('ORDER BY');
  });

  it('复合增强：筛选+HAVING+排序+COUNT_DISTINCT 组合 SQL 结构完整', () => {
    const out = buildFlexQuerySql(
      base({
        dimensions: ['JGMC', 'SJRQ'],
        measures: [{ column: 'BNTFJE', agg: 'COUNT_DISTINCT' }],
        filters: [{ column: 'BNTFJE', op: 'BETWEEN', value: '1, 999' }],
        havings: [{ agg: 'COUNT_DISTINCT', column: 'BNTFJE', op: '>=', value: '2' }],
        orderBy: { by: 'countd_bntfje', dir: 'asc' },
        limit: 50,
      }),
      TABLE,
      'mysql',
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toBe(
        'SELECT `JGMC`, `SJRQ`, COUNT(DISTINCT `BNTFJE`) AS `countd_bntfje` FROM `fct_jc_main_biz_stat` ' +
          'WHERE `BNTFJE` BETWEEN 1 AND 999 GROUP BY `JGMC`, `SJRQ` ' +
          'HAVING COUNT(DISTINCT `BNTFJE`) >= 2 ORDER BY `countd_bntfje` ASC LIMIT 50'
      );
    }
  });
});

// v0.4.14：多表 JOIN 测试
describe('buildFlexQuerySql: 多表 JOIN', () => {
  const DIM_TABLE: TableSchema = {
    id: 't2',
    name: 'dim_region',
    displayName: '区域维表',
    description: '',
    rowCount: 50,
    columns: [
      { name: 'region_code', type: 'string' },
      { name: 'region_name', type: 'string' },
    ],
  };

  it('INNER JOIN 生成正确 SQL', () => {
    const out = buildFlexQuerySql(
      base({
        joins: [{ table: 'dim_region', type: 'INNER', on: { left: 'JGMC', right: 'region_code' } }],
        dimensions: ['JGMC', 'dim_region.region_name'],
      }),
      TABLE,
      'mysql',
      [TABLE, DIM_TABLE]
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('INNER JOIN `dim_region` ON `JGMC` = `dim_region`.`region_code`');
      expect(out.sql).toContain('`dim_region`.`region_name`');
    }
  });

  it('LEFT JOIN 生成正确 SQL', () => {
    const out = buildFlexQuerySql(
      base({ joins: [{ table: 'dim_region', type: 'LEFT', on: { left: 'JGMC', right: 'region_code' } }] }),
      TABLE,
      'mysql',
      [TABLE, DIM_TABLE]
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('LEFT JOIN `dim_region`');
  });

  it('关联表不在白名单 → 拒绝', () => {
    const out = buildFlexQuerySql(
      base({ joins: [{ table: 'evil_table', type: 'INNER', on: { left: 'JGMC', right: 'id' } }] }),
      TABLE,
      'mysql',
      [TABLE, DIM_TABLE]
    );
    expect(out.ok).toBe(false);
  });

  it('JOIN 条件字段不存在 → 拒绝', () => {
    const out = buildFlexQuerySql(
      base({ joins: [{ table: 'dim_region', type: 'INNER', on: { left: 'EVIL', right: 'region_code' } }] }),
      TABLE,
      'mysql',
      [TABLE, DIM_TABLE]
    );
    expect(out.ok).toBe(false);
  });

  it('跨表字段作为维度与指标（table.column 格式）', () => {
    const out = buildFlexQuerySql(
      base({
        joins: [{ table: 'dim_region', type: 'LEFT', on: { left: 'JGMC', right: 'region_code' } }],
        dimensions: ['JGMC', 'dim_region.region_name'],
        measures: [{ column: 'BNTFJE', agg: 'SUM' }],
      }),
      TABLE,
      'mysql',
      [TABLE, DIM_TABLE]
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('`dim_region`.`region_name`');
      expect(out.sql).toContain('GROUP BY `JGMC`, `dim_region`.`region_name`');
      expect(out.sql).toContain('LEFT JOIN `dim_region` ON `JGMC` = `dim_region`.`region_code`');
    }
  });
});
