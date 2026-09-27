import { describe, expect, it } from 'vitest';
import {
  buildFlexQuerySql,
  filterValueToSql,
  measureAlias,
  betweenParts,
  aggExpression,
  dimResultAlias,
  metricAlias,
  derivedAlias,
  YOY_LAG_BY_UNIT,
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
  orderBys: [{ by: 'sum_bntfje', dir: 'desc' }],
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
    const out = buildFlexQuerySql(base({ orderBys: [] }), TABLE, 'pg');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('FROM "fct_jc_main_biz_stat"');
  });

  it('全表聚合（无维度）不生成 GROUP BY', () => {
    const out = buildFlexQuerySql(base({ dimensions: [], orderBys: [] }), TABLE, 'mysql');
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
      base({ measures: [{ column: 'JGMC', agg: 'COUNT_DISTINCT' }], orderBys: [] }),
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
    const byDim = buildFlexQuerySql(base({ orderBys: [{ by: 'JGMC', dir: 'asc' }] }), TABLE, 'mysql');
    expect(byDim.ok).toBe(true);
    if (byDim.ok) expect(byDim.sql).toContain('ORDER BY `JGMC` ASC');

    const bySecond = buildFlexQuerySql(
      base({
        measures: [
          { column: 'BNTFJE', agg: 'SUM' },
          { column: 'BNTFJE', agg: 'COUNT' },
        ],
        orderBys: [{ by: 'count_bntfje', dir: 'desc' }],
      }),
      TABLE,
      'mysql',
    );
    expect(bySecond.ok).toBe(true);
    if (bySecond.ok) expect(bySecond.sql).toContain('ORDER BY `count_bntfje` DESC');

    expect(buildFlexQuerySql(base({ orderBys: [{ by: 'evil_alias', dir: 'desc' }] }), TABLE, 'mysql').ok).toBe(false);
  });

  it('排序为空（orderBys 空数组）时不生成 ORDER BY', () => {
    const out = buildFlexQuerySql(base({ orderBys: [] }), TABLE, 'mysql');
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
        orderBys: [{ by: 'countd_bntfje', dir: 'asc' }],
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

/** v0.5.4 金额单位换算用表：金额列带业务描述（关键词命中），另有非金额数值列 */
const AMOUNT_TABLE: TableSchema = {
  id: 't-amt',
  name: 'fct_jc_main_biz_stat',
  displayName: '主营业务宽表',
  description: '',
  rowCount: 100,
  columns: [
    { name: 'JGMC', type: 'string' },
    { name: 'BNTFJE', type: 'number', description: '本年投放金额' },
    { name: 'BS', type: 'number', description: '业务笔数' },
  ],
};

const WAN = { label: '万元', divisor: 10000 };
const YUAN = { label: '元', divisor: 1 };

describe('buildFlexQuerySql: v0.5.4 金额单位换算', () => {
  it('金额列 SUM 按除数换算（ROUND(SUM/除数, 2)），别名不变', () => {
    const out = buildFlexQuerySql(
      base({ measures: [{ column: 'BNTFJE', agg: 'SUM' }] }),
      AMOUNT_TABLE,
      'mysql',
      undefined,
      WAN
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('ROUND(SUM(`BNTFJE`)/10000, 2) AS `sum_bntfje`');
    }
  });

  it('金额列 AVG/MIN/MAX 换算，COUNT 与 COUNT_DISTINCT 不换算', () => {
    const out = buildFlexQuerySql(
      base({
        measures: [
          { column: 'BNTFJE', agg: 'AVG' },
          { column: 'BNTFJE', agg: 'MAX' },
          { column: 'BNTFJE', agg: 'COUNT' },
          { column: 'BNTFJE', agg: 'COUNT_DISTINCT' },
        ],
        orderBys: [],
      }),
      AMOUNT_TABLE,
      'mysql',
      undefined,
      WAN
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('ROUND(AVG(`BNTFJE`)/10000, 2) AS `avg_bntfje`');
      expect(out.sql).toContain('ROUND(MAX(`BNTFJE`)/10000, 2) AS `max_bntfje`');
      expect(out.sql).toContain('COUNT(`BNTFJE`) AS `count_bntfje`');
      expect(out.sql).toContain('COUNT(DISTINCT `BNTFJE`) AS `countd_bntfje`');
      expect(out.sql).not.toContain('ROUND(COUNT');
    }
  });

  it('非金额数值列不换算（关键词未命中）', () => {
    const out = buildFlexQuerySql(
      base({ measures: [{ column: 'BS', agg: 'SUM' }], orderBys: [] }),
      AMOUNT_TABLE,
      'mysql',
      undefined,
      WAN
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('SUM(`BS`) AS `sum_bs`');
      expect(out.sql).not.toContain('ROUND');
    }
  });

  it('「元」为原值口径：不换算；不传 amountUnit 保持原行为', () => {
    const yuan = buildFlexQuerySql(base(), AMOUNT_TABLE, 'mysql', undefined, YUAN);
    expect(yuan.ok).toBe(true);
    if (yuan.ok) expect(yuan.sql).toContain('SUM(`BNTFJE`) AS `sum_bntfje`');
    const none = buildFlexQuerySql(base(), AMOUNT_TABLE, 'mysql');
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.sql).not.toContain('ROUND');
  });

  it('HAVING 中金额列与 SELECT 同口径换算，阈值按所选单位理解', () => {
    const out = buildFlexQuerySql(
      base({
        measures: [{ column: 'BNTFJE', agg: 'SUM' }],
        havings: [{ column: 'BNTFJE', agg: 'SUM', op: '>', value: '1000' }],
      }),
      AMOUNT_TABLE,
      'mysql',
      undefined,
      WAN
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('HAVING ROUND(SUM(`BNTFJE`)/10000, 2) > 1000');
    }
  });

  it('PG 方言下金额换算保持双引号标识符', () => {
    const out = buildFlexQuerySql(base({ orderBys: [] }), AMOUNT_TABLE, 'pg', undefined, WAN);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('ROUND(SUM("BNTFJE")/10000, 2) AS "sum_bntfje"');
  });
});

// v0.9.75：灵活查询 P0 增强（时间粒度 / 多列排序 / LIKE 模式 / 维度结果列名）
describe('buildFlexQuerySql: v0.9.75 P0 增强', () => {
  const DIM: TableSchema = {
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

  it('时间粒度：MySQL 按月 DATE_FORMAT 分组并以末段列名做别名', () => {
    const out = buildFlexQuerySql(base({ dimensions: ['SJRQ'], dimTimeUnits: { SJRQ: 'month' }, orderBys: [] }), TABLE, 'mysql');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain("DATE_FORMAT(`SJRQ`, '%Y-%m') AS `SJRQ`");
      expect(out.sql).toContain("GROUP BY DATE_FORMAT(`SJRQ`, '%Y-%m')");
    }
  });

  it('时间粒度：MySQL 按周两位周序、按季度编码，排序按粒度表达式', () => {
    const week = buildFlexQuerySql(
      base({ dimensions: ['SJRQ'], dimTimeUnits: { SJRQ: 'week' }, orderBys: [{ by: 'SJRQ', dir: 'asc' }] }),
      TABLE,
      'mysql'
    );
    expect(week.ok).toBe(true);
    if (week.ok) {
      expect(week.sql).toContain("'%x-W%v') AS `SJRQ`");
      expect(week.sql).toContain("ORDER BY DATE_FORMAT(`SJRQ`, '%x-W%v') ASC");
    }
    const quarter = buildFlexQuerySql(
      base({ dimensions: ['SJRQ'], dimTimeUnits: { SJRQ: 'quarter' }, orderBys: [] }),
      TABLE,
      'mysql'
    );
    expect(quarter.ok).toBe(true);
    if (quarter.ok) expect(quarter.sql).toContain("CONCAT(YEAR(`SJRQ`), '-Q', QUARTER(`SJRQ`)) AS `SJRQ`");
  });

  it('时间粒度：PG 按年/季度 TO_CHAR 表达式', () => {
    const year = buildFlexQuerySql(base({ dimensions: ['SJRQ'], dimTimeUnits: { SJRQ: 'year' }, orderBys: [] }), TABLE, 'pg');
    expect(year.ok).toBe(true);
    if (year.ok) {
      expect(year.sql).toContain('TO_CHAR("SJRQ"::date');
      expect(year.sql).toContain('AS "SJRQ"');
    }
    const quarter = buildFlexQuerySql(
      base({ dimensions: ['SJRQ'], dimTimeUnits: { SJRQ: 'quarter' }, orderBys: [] }),
      TABLE,
      'pg'
    );
    expect(quarter.ok).toBe(true);
    if (quarter.ok) {
      expect(quarter.sql).toContain('CONCAT(TO_CHAR("SJRQ"::date');
      expect(quarter.sql).toContain("'-Q'");
    }
  });

  it('非法时间粒度 → 拒绝', () => {
    expect(buildFlexQuerySql(base({ dimensions: ['SJRQ'], dimTimeUnits: { SJRQ: 'decade' as any } }), TABLE, 'mysql').ok).toBe(
      false
    );
  });

  it('多列排序：维度 + 指标组合生成复合 ORDER BY', () => {
    const out = buildFlexQuerySql(
      base({ orderBys: [{ by: 'JGMC', dir: 'asc' }, { by: 'sum_bntfje', dir: 'desc' }] }),
      TABLE,
      'mysql'
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('ORDER BY `JGMC` ASC, `sum_bntfje` DESC');
  });

  it('LIKE 匹配模式：包含/开头是/结尾是/精确，数值型同按模式包裹', () => {
    expect(filterValueToSql('LIKE', '北京', 'contains')).toBe("'%北京%'");
    expect(filterValueToSql('LIKE', '北京', 'startsWith')).toBe("'北京%'");
    expect(filterValueToSql('LIKE', '北京', 'endsWith')).toBe("'%北京'");
    expect(filterValueToSql('LIKE', '北京', 'exact')).toBe("'北京'");
    expect(filterValueToSql('LIKE', '123')).toBe("'%123%'");
  });

  it('LIKE 模式透传进 WHERE；非法模式拒绝', () => {
    const out = buildFlexQuerySql(
      base({ filters: [{ column: 'JGMC', op: 'LIKE', value: '北京', likeMode: 'startsWith' }] }),
      TABLE,
      'mysql'
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain("`JGMC` LIKE '北京%'");
    const bad = buildFlexQuerySql(
      base({ filters: [{ column: 'JGMC', op: 'LIKE', value: 'x', likeMode: 'evil' as any }] }),
      TABLE,
      'mysql'
    );
    expect(bad.ok).toBe(false);
  });

  it('维度结果列名冲突 → 拒绝（主表同名末段列与跨表维度）', () => {
    const withSameName: TableSchema = { ...TABLE, columns: [...TABLE.columns, { name: 'region_name', type: 'string' }] };
    const out = buildFlexQuerySql(
      base({
        joins: [{ table: 'dim_region', type: 'LEFT', on: { left: 'JGMC', right: 'region_code' } }],
        dimensions: ['region_name', 'dim_region.region_name'],
      }),
      withSameName,
      'mysql',
      [withSameName, DIM]
    );
    expect(out.ok).toBe(false);
  });

  it('跨表指标别名点号归一（修复旧版别名非法）', () => {
    const out = buildFlexQuerySql(
      base({
        joins: [{ table: 'dim_region', type: 'LEFT', on: { left: 'JGMC', right: 'region_code' } }],
        measures: [{ column: 'dim_region.region_name', agg: 'COUNT_DISTINCT' }],
        orderBys: [],
      }),
      TABLE,
      'mysql',
      [TABLE, DIM]
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('COUNT(DISTINCT `dim_region`.`region_name`) AS `countd_dim_region_region_name`');
    expect(measureAlias({ column: 'dim_region.region_name', agg: 'SUM' })).toBe('sum_dim_region_region_name');
    expect(dimResultAlias('dim_region.region_name')).toBe('region_name');
    expect(dimResultAlias('JGMC')).toBe('JGMC');
  });

  it('跨表维度支持以末段结果列名排序', () => {
    const out = buildFlexQuerySql(
      base({
        joins: [{ table: 'dim_region', type: 'LEFT', on: { left: 'JGMC', right: 'region_code' } }],
        dimensions: ['JGMC', 'dim_region.region_name'],
        orderBys: [{ by: 'region_name', dir: 'asc' }],
      }),
      TABLE,
      'mysql',
      [TABLE, DIM]
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sql).toContain('ORDER BY `dim_region`.`region_name` ASC');
  });
});

describe('buildFlexQuerySql: v0.9.76 P1 增强（OR 组 / 语义指标 / 时间衍生列）', () => {
  const DIM: TableSchema = {
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

  it('OR 分组：组内 OR、组间 AND，空组忽略', () => {
    const out = buildFlexQuerySql(
      base({
        filters: [{ column: 'BNTFJE', op: '>', value: '100' }],
        orGroups: [
          [
            { column: 'JGMC', op: '=', value: '北京' },
            { column: 'JGMC', op: '=', value: '上海' },
          ],
          [],
        ],
      }),
      TABLE,
      'mysql'
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain("WHERE `BNTFJE` > 100 AND (`JGMC` = '北京' OR `JGMC` = '上海')");
    }
  });

  it('OR 分组：组内条件值缺失 → 拒绝；组数超限 → 拒绝', () => {
    const missingValue = buildFlexQuerySql(
      base({ orGroups: [[{ column: 'JGMC', op: '=', value: '' }]] }),
      TABLE,
      'mysql'
    );
    expect(missingValue.ok).toBe(false);

    const tooMany = buildFlexQuerySql(
      base({ orGroups: Array.from({ length: 6 }, () => [{ column: 'JGMC', op: '=', value: 'x' }]) }),
      TABLE,
      'mysql'
    );
    expect(tooMany.ok).toBe(false);
  });

  it('语义指标：expr 作为结果列 metric_<id>，固定过滤并入 WHERE（括号包裹）', () => {
    const out = buildFlexQuerySql(
      base({
        measures: [],
        orderBys: [],
        metrics: [
          { id: 3, name: '投放金额', expr: 'SUM(BNTFJE)', tableName: 'fct_jc_main_biz_stat', filters: "JGMC = '北京'" },
        ],
      }),
      TABLE,
      'mysql'
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toBe(
        "SELECT `JGMC`, SUM(BNTFJE) AS `metric_3` FROM `fct_jc_main_biz_stat` WHERE (JGMC = '北京') GROUP BY `JGMC` LIMIT 100"
      );
    }
    expect(metricAlias(3)).toBe('metric_3');
  });

  it('语义指标：归属表不一致 / 与所选表不符 / 含 JOIN / 过滤不一致 → 均拒绝', () => {
    const m1 = { id: 1, name: 'A', expr: 'SUM(BNTFJE)', tableName: 'fct_jc_main_biz_stat', filters: '' };
    const m2 = { id: 2, name: 'B', expr: 'SUM(BNTFJE)', tableName: 'other_table', filters: '' };
    expect(buildFlexQuerySql(base({ metrics: [m1, m2] }), TABLE, 'mysql').ok).toBe(false);
    expect(
      buildFlexQuerySql(
        base({ metrics: [{ ...m1, tableName: 'another_table' }] }),
        TABLE,
        'mysql'
      ).ok
    ).toBe(false);
    expect(
      buildFlexQuerySql(
        base({ metrics: [m1], joins: [{ table: 'dim_region', type: 'LEFT', on: { left: 'JGMC', right: 'region_code' } }] }),
        TABLE,
        'mysql',
        [TABLE, DIM]
      ).ok
    ).toBe(false);
    expect(
      buildFlexQuerySql(
        base({ metrics: [m1, { ...m1, id: 2, filters: 'BNTFJE > 0' }] }),
        TABLE,
        'mysql'
      ).ok
    ).toBe(false);
  });

  it('时间衍生列：按月同比（LAG 12）与移动平均（3 期），外层包装查询', () => {
    const out = buildFlexQuerySql(
      base({
        dimensions: ['SJRQ'],
        dimTimeUnits: { SJRQ: 'month' },
        orderBys: [],
        deriveds: [
          { by: 'sum_bntfje', kind: 'yoy' },
          { by: 'sum_bntfje', kind: 'ma', periods: 3 },
        ],
      }),
      TABLE,
      'mysql'
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('SELECT t.*, ');
      expect(out.sql).toContain('LAG(t.`sum_bntfje`, 12) OVER (ORDER BY t.`SJRQ`)');
      expect(out.sql).toContain('AS `sum_bntfje_yoy`');
      expect(out.sql).toContain('ROWS BETWEEN 2 PRECEDING AND CURRENT ROW');
      expect(out.sql).toContain('AS `sum_bntfje_ma3`');
      expect(out.sql).toContain("FROM (SELECT DATE_FORMAT(`SJRQ`, '%Y-%m') AS `SJRQ`, SUM(`BNTFJE`) AS `sum_bntfje` FROM `fct_jc_main_biz_stat` GROUP BY DATE_FORMAT(`SJRQ`, '%Y-%m')) AS t");
      expect(out.sql.endsWith('ORDER BY t.`SJRQ` ASC LIMIT 100')).toBe(true);
    }
  });

  it('时间衍生列：累计（SUM OVER UNBOUNDED）与按季同比回看 4 期（PG 双引号）', () => {
    const out = buildFlexQuerySql(
      base({
        dimensions: ['SJRQ'],
        dimTimeUnits: { SJRQ: 'quarter' },
        orderBys: [{ by: 'sum_bntfje', dir: 'desc' }],
        deriveds: [
          { by: 'sum_bntfje', kind: 'cum' },
          { by: 'sum_bntfje', kind: 'mom' },
        ],
      }),
      TABLE,
      'pg'
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toContain('SUM(t."sum_bntfje") OVER (ORDER BY t."SJRQ" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "sum_bntfje_cum"');
      expect(out.sql).toContain('LAG(t."sum_bntfje", 1) OVER (ORDER BY t."SJRQ")');
      expect(out.sql).toContain('ORDER BY t."sum_bntfje" DESC');
    }
    expect(YOY_LAG_BY_UNIT.quarter).toBe(4);
    expect(derivedAlias('sum_bntfje', 'ma', 7)).toBe('sum_bntfje_ma7');
  });

  it('时间衍生列：无时间粒度 / 目标别名不存在 / 重复衍生 → 均拒绝', () => {
    expect(
      buildFlexQuerySql(base({ deriveds: [{ by: 'sum_bntfje', kind: 'yoy' }] }), TABLE, 'mysql').ok
    ).toBe(false);
    expect(
      buildFlexQuerySql(
        base({ dimTimeUnits: { JGMC: 'month' }, deriveds: [{ by: 'not_exist', kind: 'yoy' }] }),
        TABLE,
        'mysql'
      ).ok
    ).toBe(false);
    expect(
      buildFlexQuerySql(
        base({
          dimensions: ['SJRQ'],
          dimTimeUnits: { SJRQ: 'month' },
          deriveds: [
            { by: 'sum_bntfje', kind: 'yoy' },
            { by: 'sum_bntfje', kind: 'yoy' },
          ],
        }),
        TABLE,
        'mysql'
      ).ok
    ).toBe(false);
  });
});
