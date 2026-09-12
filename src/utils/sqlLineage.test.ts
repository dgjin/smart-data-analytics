/**
 * P0-3 三级溯源（L2）单测：SQL 表关联解析（主表 / JOIN 链 / ON 条件 / 干扰防御）。
 */
import { describe, it, expect } from 'vitest';
import { parseSqlLineage } from './sqlLineage';

describe('parseSqlLineage', () => {
  it('单表查询：仅主表，无别名', () => {
    const r = parseSqlLineage('SELECT a, b FROM orders WHERE x > 1');
    expect(r.edges).toEqual([{ name: 'orders', joinType: 'MAIN' }]);
    expect(r.hasSubquery).toBe(false);
  });

  it('JOIN 链：类型 / 别名 / ON 条件逐段解析', () => {
    const sql =
      'SELECT * FROM clients c LEFT JOIN visits v ON c.id = v.client_id INNER JOIN departments d ON v.dept_id = d.id WHERE c.status = 1';
    const r = parseSqlLineage(sql);
    expect(r.edges).toEqual([
      { name: 'clients', alias: 'c', joinType: 'MAIN' },
      { name: 'visits', alias: 'v', joinType: 'LEFT', onCondition: 'c.id = v.client_id' },
      { name: 'departments', alias: 'd', joinType: 'INNER', onCondition: 'v.dept_id = d.id' },
    ]);
  });

  it('反引号与库名前缀归一 + USING 连接', () => {
    const r = parseSqlLineage('SELECT * FROM `db`.`orders` o JOIN `lines` USING (order_id)');
    expect(r.edges).toEqual([
      { name: 'orders', alias: 'o', joinType: 'MAIN' },
      { name: 'lines', joinType: 'INNER', onCondition: 'USING (order_id)' },
    ]);
  });

  it('注释与字符串字面量中的 from/join 不误判', () => {
    const sql = "SELECT * FROM t -- from fake_table\nWHERE name = 'join x from y'";
    const r = parseSqlLineage(sql);
    expect(r.edges).toEqual([{ name: 't', joinType: 'MAIN' }]);
  });

  it('子查询：标记 hasSubquery，抽取值内 FROM 表', () => {
    const sql = 'SELECT * FROM (SELECT * FROM t1) x JOIN t2 ON x.id = t2.id';
    const r = parseSqlLineage(sql);
    expect(r.hasSubquery).toBe(true);
    expect(r.edges.map((e) => e.name)).toEqual(['t1', 't2']);
    expect(r.edges[1].joinType).toBe('INNER');
  });

  it('空 SQL 返回空结果', () => {
    expect(parseSqlLineage('')).toEqual({ edges: [], hasSubquery: false });
    expect(parseSqlLineage('   ')).toEqual({ edges: [], hasSubquery: false });
  });
});
