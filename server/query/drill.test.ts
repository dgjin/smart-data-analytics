/**
 * P2-2 报表图表点击下钻：buildDrillSql 纯函数单测。
 * 覆盖：GROUP BY 去除、WHERE 合并、JOIN 保留、数字维度值、回退路径。
 */
import { describe, it, expect } from 'vitest';
import { buildDrillSql } from './drill';

describe('buildDrillSql: P2-2 下钻 SQL 生成', () => {
  it('聚合查询：去除 GROUP BY 与聚合列，改为 SELECT * + 维度谓词 + LIMIT 50', () => {
    const sql = buildDrillSql(
      "SELECT region, COUNT(*) AS cnt FROM clients GROUP BY region",
      'region',
      '合肥市'
    );
    expect(sql).toBe("SELECT * FROM `clients` WHERE `region` = '合肥市' LIMIT 50");
  });

  it('保留原 WHERE 并以 AND 合并维度谓词', () => {
    const sql = buildDrillSql(
      "SELECT region, COUNT(*) AS cnt FROM clients WHERE status = 'active' GROUP BY region LIMIT 10",
      'region',
      '合肥市'
    );
    expect(sql).toBe(
      "SELECT * FROM `clients` WHERE `status` = 'active' AND `region` = '合肥市' LIMIT 50"
    );
  });

  it('JOIN 查询：保留 FROM 与 JOIN 结构', () => {
    const sql = buildDrillSql(
      'SELECT v.type, SUM(v.duration) FROM visits v JOIN clients c ON v.client_id = c.id GROUP BY v.type',
      'type',
      '电话'
    );
    expect(sql).toContain('`visits` AS `v`');
    expect(sql).toContain('INNER JOIN `clients` AS `c`');
    expect(sql).toContain("`type` = '电话'");
    expect(sql).toContain('LIMIT 50');
    expect(sql).not.toMatch(/GROUP BY/i);
  });

  it('数字维度值不加引号', () => {
    const sql = buildDrillSql('SELECT 月份 FROM t ORDER BY 月份', '月份', 2026);
    expect(sql).toBe('SELECT * FROM `t` WHERE `月份` = 2026 LIMIT 50');
  });

  it('AST 解析失败：回退正则提取主表名', () => {
    const sql = buildDrillSql('garbage not sql but from clients where 1', 'region', '合肥');
    expect(sql).toBe("SELECT * FROM `clients` WHERE `region` = '合肥' LIMIT 50");
  });

  it('无法提取表名时返回 null', () => {
    expect(buildDrillSql('this has no table at all', 'region', '合肥')).toBeNull();
  });

  it('字符串维度值中的单引号在回退路径被转义', () => {
    // 构造一个 AST 解析不了但含 from 表的输入，走回退路径
    const sql = buildDrillSql('??? from clients ???', 'region', "O'Hara");
    expect(sql).toBe("SELECT * FROM `clients` WHERE `region` = 'O\\'Hara' LIMIT 50");
  });
});
