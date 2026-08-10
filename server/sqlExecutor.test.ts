/**
 * P0 安全执行层单元测试：SELECT-only、表名白名单、敏感列拒绝、单语句、LIMIT 强制。
 * 仅覆盖纯校验逻辑（validateSelectSql / extractTableRefs），不触碰真实数据库。
 */
import { describe, it, expect } from 'vitest';
import { validateSelectSql, extractTableRefs, stripCommentsAndStrings } from './sqlExecutor';

const ALLOWED = [
  { name: 'tbl_orders', columns: [{ name: 'id' }, { name: 'amount' }, { name: 'channel' }] },
  { name: 'tbl_clients', columns: [{ name: 'id' }, { name: 'name' }, { name: 'level' }] },
];
const SENSITIVE = ['tbl_users.password', 'tbl_users.phone'];

describe('validateSelectSql: SELECT-only 防线', () => {
  it('放行普通 SELECT 并自动追加 LIMIT', () => {
    const r = validateSelectSql('SELECT channel, SUM(amount) AS total FROM tbl_orders GROUP BY channel', ALLOWED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 500$/);
  });

  it('拒绝写操作与 DDL', () => {
    for (const bad of [
      'DELETE FROM tbl_orders',
      'UPDATE tbl_orders SET amount = 0',
      'DROP TABLE tbl_orders',
      'TRUNCATE tbl_orders',
      'INSERT INTO tbl_orders (id) VALUES (1)',
      'ALTER TABLE tbl_orders ADD COLUMN x INT',
    ]) {
      const r = validateSelectSql(bad, ALLOWED);
      expect(r.ok).toBe(false);
    }
  });

  it('拒绝多语句注入', () => {
    const r = validateSelectSql('SELECT * FROM tbl_orders; DROP TABLE tbl_orders--', ALLOWED);
    expect(r.ok).toBe(false);
  });

  it('注释中的危险关键字不影响校验，但注释无法夹带第二语句', () => {
    const ok = validateSelectSql('SELECT id FROM tbl_orders /* drop is scary */', ALLOWED);
    expect(ok.ok).toBe(true);
    const injected = validateSelectSql('SELECT id FROM tbl_orders /**/; DELETE FROM tbl_orders', ALLOWED);
    expect(injected.ok).toBe(false);
  });

  it('拒绝 INTO 写文件/写表', () => {
    expect(validateSelectSql('SELECT * INTO OUTFILE "/tmp/x" FROM tbl_orders', ALLOWED).ok).toBe(false);
    expect(validateSelectSql('SELECT id INTO tbl_clients FROM tbl_orders', ALLOWED).ok).toBe(false);
  });

  it('字符串字面量中的关键字不触发误杀', () => {
    const r = validateSelectSql("SELECT channel FROM tbl_orders WHERE channel = 'delete 渠道'", ALLOWED);
    expect(r.ok).toBe(true);
  });

  it('合法 SELECT 语法词不误杀（ORDER BY DESC / REPLACE 函数）', () => {
    const desc = validateSelectSql('SELECT channel, SUM(amount) AS total FROM tbl_orders GROUP BY channel ORDER BY total DESC', ALLOWED);
    expect(desc.ok).toBe(true);
    const rep = validateSelectSql("SELECT REPLACE(channel, 'A', 'B') AS ch FROM tbl_orders", ALLOWED);
    expect(rep.ok).toBe(true);
  });

  it('PROCEDURE ANALYSE 危险构造被拒绝', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders PROCEDURE ANALYSE()', ALLOWED);
    expect(r.ok).toBe(false);
  });

  it('拒绝非 SELECT 开头的语句（WITH/SET/SHOW 等）', () => {
    expect(validateSelectSql('WITH t AS (SELECT 1) SELECT * FROM t', ALLOWED).ok).toBe(false);
    expect(validateSelectSql('SHOW TABLES', ALLOWED).ok).toBe(false);
    expect(validateSelectSql('SET @a = 1', ALLOWED).ok).toBe(false);
  });
});

describe('validateSelectSql: 表名白名单', () => {
  it('范围外表名被拒绝', () => {
    const r = validateSelectSql('SELECT * FROM tbl_users', ALLOWED);
    expect(r.ok).toBe(false);
    if (r.ok !== true) expect(r.reason).toContain('tbl_users');
  });

  it('JOIN 的每张表都必须白名单内', () => {
    const ok = validateSelectSql(
      'SELECT o.id, c.name FROM tbl_orders o JOIN tbl_clients c ON o.id = c.id',
      ALLOWED
    );
    expect(ok.ok).toBe(true);
    const bad = validateSelectSql(
      'SELECT o.id FROM tbl_orders o JOIN tbl_users u ON o.id = u.id',
      ALLOWED
    );
    expect(bad.ok).toBe(false);
  });

  it('子查询中的表同样受白名单约束', () => {
    const ok = validateSelectSql(
      'SELECT * FROM (SELECT id FROM tbl_orders) t',
      ALLOWED
    );
    expect(ok.ok).toBe(true);
    const bad = validateSelectSql(
      'SELECT * FROM (SELECT id FROM tbl_users) t',
      ALLOWED
    );
    expect(bad.ok).toBe(false);
  });

  it('库名前缀与反引号写法按表名部分校验', () => {
    const ok = validateSelectSql('SELECT * FROM `crm`.`tbl_orders`', ALLOWED);
    expect(ok.ok).toBe(true);
    const bad = validateSelectSql('SELECT * FROM `crm`.`tbl_users`', ALLOWED);
    expect(bad.ok).toBe(false);
  });

  it('逗号分隔多表形式全部校验', () => {
    const ok = validateSelectSql('SELECT * FROM tbl_orders, tbl_clients', ALLOWED);
    expect(ok.ok).toBe(true);
    const bad = validateSelectSql('SELECT * FROM tbl_orders, tbl_users', ALLOWED);
    expect(bad.ok).toBe(false);
  });
});

describe('validateSelectSql: 敏感列拒绝', () => {
  it('引用敏感列（含反引号）被拒绝', () => {
    expect(validateSelectSql('SELECT password FROM tbl_orders', ALLOWED, SENSITIVE).ok).toBe(false);
    expect(validateSelectSql('SELECT `phone` FROM tbl_orders', ALLOWED, SENSITIVE).ok).toBe(false);
  });

  it('不含敏感列的正常查询不受影响', () => {
    const r = validateSelectSql('SELECT id, amount FROM tbl_orders', ALLOWED, SENSITIVE);
    expect(r.ok).toBe(true);
  });
});

describe('validateSelectSql: LIMIT 强制', () => {
  it('无 LIMIT 追加 500', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders', ALLOWED);
    expect(r.ok && /LIMIT 500$/.test(r.sql)).toBe(true);
  });

  it('超出上限的 LIMIT 被 clamp 到 500', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 99999', ALLOWED);
    expect(r.ok && /LIMIT 500$/.test(r.sql)).toBe(true);
  });

  it('合理 LIMIT 保持不变', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 50', ALLOWED);
    expect(r.ok && /LIMIT 50$/.test(r.sql)).toBe(true);
  });

  it('LIMIT offset, count 形式的 count 被 clamp', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 10, 800', ALLOWED);
    expect(r.ok && /LIMIT 10, 500$/.test(r.sql)).toBe(true);
  });
});

describe('extractTableRefs: 表引用提取', () => {
  it('覆盖 JOIN 链与逗号多表', () => {
    const refs = extractTableRefs(
      stripCommentsAndStrings('SELECT * FROM a JOIN b ON a.x=b.x LEFT JOIN c ON b.y=c.y, d')
    );
    expect(refs.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ON 条件中的列名不会被误识别为表', () => {
    const refs = extractTableRefs(stripCommentsAndStrings('SELECT * FROM orders o JOIN users u ON o.uid = u.id'));
    expect(refs.sort()).toEqual(['orders', 'users']);
  });

  it('子查询内部表被提取', () => {
    const refs = extractTableRefs(stripCommentsAndStrings('SELECT * FROM (SELECT x FROM inner_tbl) t JOIN outer_tbl o ON t.x=o.x'));
    expect(refs.sort()).toEqual(['inner_tbl', 'outer_tbl']);
  });
});
