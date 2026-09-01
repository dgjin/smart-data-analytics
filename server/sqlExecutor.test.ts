/**
 * P0 安全执行层单元测试：SELECT-only、表名白名单、敏感列拒绝、单语句、LIMIT 强制。
 * 仅覆盖纯校验逻辑（validateSelectSql / extractTableRefs），不触碰真实数据库。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { checkAstSafety, dialectOfDsType, validateSelectSql, extractTableRefs, extractCteNames, stripCommentsAndStrings, injectRowFilters, injectMysqlMaxExecTime, repairTablePrefixes, dsPoolMax } from './sqlExecutor';
import { appPoolMax } from './db';

const ALLOWED = [
  { name: 'tbl_orders', columns: [{ name: 'id' }, { name: 'amount' }, { name: 'channel' }] },
  { name: 'tbl_clients', columns: [{ name: 'id' }, { name: 'name' }, { name: 'level' }] },
];
const SENSITIVE = ['tbl_users.password', 'tbl_users.phone'];

describe('validateSelectSql: SELECT-only 防线', () => {
  it('放行普通 SELECT 并自动追加 LIMIT', () => {
    const r = validateSelectSql('SELECT channel, SUM(amount) AS total FROM tbl_orders GROUP BY channel', ALLOWED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 100000$/);
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

  it('回归：返回 SQL 必须保留字符串字面量值（不得被安全副本的空字面量污染）', () => {
    const r = validateSelectSql("SELECT * FROM tbl_orders WHERE region = '合肥市' LIMIT 50", ALLOWED, [], 'mysql', 50);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toBe("SELECT * FROM tbl_orders WHERE region = '合肥市' LIMIT 50");
  });

  it('行尾注释剥除后追加的 LIMIT 不被吞掉，字面量仍保留', () => {
    const r = validateSelectSql("SELECT * FROM tbl_orders WHERE channel = '电话' -- trailing", ALLOWED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toContain("channel = '电话'");
      expect(r.sql).toMatch(/LIMIT 100000$/);
    }
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

  it('子查询 SELECT 列表的逗号不把列名/聚合函数误当表名（两期对比回归）', () => {
    // 回归：FROM 段补充扫描曾按逗号分表，把子查询内的 SUM（函数名）误当表名拒绝
    const subSum = validateSelectSql('SELECT x.jgmc FROM (SELECT JGMC jgmc, SUM(amount) s FROM tbl_orders GROUP BY JGMC) x', ALLOWED);
    expect(subSum.ok).toBe(true);
    // 回归：JOIN 两期子查询时内层列名（amount）曾被误判为表名 bntfje 同类问题
    const joinCols = validateSelectSql("SELECT c.jgmc, SUM(c.a) FROM (SELECT JGMC jgmc, amount a FROM tbl_orders WHERE dt='2026-08-31') c JOIN (SELECT JGMC jgmc, amount p FROM tbl_orders WHERE dt='2025-08-31') p ON p.jgmc=c.jgmc GROUP BY c.jgmc", ALLOWED);
    expect(joinCols.ok).toBe(true);
    // 无括号简单多表逗号写法仍被正确提取（不得因修复而漏判白名单外表）
    const multi = validateSelectSql('SELECT a.id FROM tbl_orders a, tbl_users b WHERE a.id = b.id', ALLOWED);
    expect(multi.ok).toBe(false);
  });

  it('拒绝非 SELECT 开头的语句（SET/SHOW 等）', () => {
    expect(validateSelectSql('SHOW TABLES', ALLOWED).ok).toBe(false);
    expect(validateSelectSql('SET @a = 1', ALLOWED).ok).toBe(false);
  });

  it('v0.4.15：WITH 开头（CTE）查询放行，CTE 名不参与白名单校验', () => {
    // CTE 基础：cte 是临时结果集别名，真实表 tbl_orders 在白名单内
    const r = validateSelectSql(
      'WITH cte AS (SELECT channel, amount FROM tbl_orders WHERE id > 10) SELECT channel, SUM(amount) AS total FROM cte GROUP BY channel',
      ALLOWED
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 100000$/);
    // 多段 CTE + JOIN
    const multi = validateSelectSql(
      'WITH a1 AS (SELECT id FROM tbl_orders), a2 AS (SELECT id FROM tbl_clients JOIN a1 ON tbl_clients.id = a1.id) SELECT * FROM a2',
      ALLOWED
    );
    expect(multi.ok).toBe(true);
    // CTE 内引用白名单外表仍被拒绝
    const bad = validateSelectSql('WITH cte AS (SELECT * FROM secret_table) SELECT * FROM cte', ALLOWED);
    expect(bad.ok).toBe(false);
    // WITH 包装写操作仍被拒绝（AST 层语句类型校验）
    const write = validateSelectSql('WITH cte AS (SELECT id FROM tbl_orders) DELETE FROM tbl_orders', ALLOWED);
    expect(write.ok).toBe(false);
  });

  it('v0.4.15：窗口函数/条件聚合/派生表/UNION 复杂语法放行', () => {
    const window = validateSelectSql(
      'SELECT channel, SUM(amount) AS total, ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC) AS rn FROM tbl_orders GROUP BY channel',
      ALLOWED
    );
    expect(window.ok).toBe(true);
    const caseAgg = validateSelectSql(
      "SELECT channel, SUM(CASE WHEN id > 100 THEN amount END) AS big_amt FROM tbl_orders GROUP BY channel",
      ALLOWED
    );
    expect(caseAgg.ok).toBe(true);
    const union = validateSelectSql('SELECT channel, amount FROM tbl_orders WHERE id > 1 UNION ALL SELECT channel, amount FROM tbl_orders WHERE id <= 1', ALLOWED);
    expect(union.ok).toBe(true);
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

describe('validateSelectSql: PG 方言双引号标识符（v0.9.1 回归）', () => {
  const PG_ALLOWED = [{ name: 'sales_performance', columns: [{ name: 'date' }, { name: 'revenue' }] }];

  it('PG：双引号表名/列名的合法查询放行（双引号是标识符而非字符串）', () => {
    const r = validateSelectSql(
      'SELECT "date", SUM("revenue") AS "sum_revenue" FROM "sales_performance" GROUP BY "date" ORDER BY "sum_revenue" DESC LIMIT 100',
      PG_ALLOWED,
      [],
      'pg',
    );
    expect(r.ok).toBe(true);
  });

  it('PG：stripCommentsAndStrings 保留双引号标识符、仍剥单引号字符串', () => {
    const out = stripCommentsAndStrings('SELECT "c" FROM "t" WHERE "c" = \'delete\'', 'pg');
    expect(out).toContain('"t"');
    expect(out).toContain("''");
  });

  it('PG：双引号包裹的范围外表仍被拒绝', () => {
    const r = validateSelectSql('SELECT * FROM "other_table"', PG_ALLOWED, [], 'pg');
    expect(r.ok).toBe(false);
  });

  it('MySQL：双引号仍按字符串字面量剥除（非 ANSI_QUOTES 默认模式不变）', () => {
    const out = stripCommentsAndStrings('SELECT a FROM tbl_orders WHERE a = "x"', 'mysql');
    expect(out).not.toContain('"x"');
    const r = validateSelectSql('SELECT channel FROM tbl_orders WHERE channel = "delete"', ALLOWED);
    expect(r.ok).toBe(true);
  });
});

describe('repairTablePrefixes: LLM 臆加表前缀纠偏', () => {
  const WIDE = [{ name: 'fct_jc_main_biz_stat', columns: [{ name: 'JGMC' }] }];

  it('tbl_/t_ 前缀去后与白名单逐字一致时纠偏通过（最终 SQL 用真实表名）', () => {
    const r = validateSelectSql('SELECT JGMC FROM tbl_fct_jc_main_biz_stat', WIDE);
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.sql).toContain('FROM fct_jc_main_biz_stat');
    const r2 = validateSelectSql('SELECT JGMC FROM t_fct_jc_main_biz_stat', WIDE);
    expect(r2.ok).toBe(true);
  });

  it('反引号写法同样纠偏且保留反引号', () => {
    expect(repairTablePrefixes('SELECT * FROM `tbl_fct_jc_main_biz_stat`', WIDE))
      .toBe('SELECT * FROM `fct_jc_main_biz_stat`');
  });

  it('去前缀后不在白名单的表不被纠偏（仍拒绝，不扩大可执行范围）', () => {
    const r = validateSelectSql('SELECT * FROM tbl_users', ALLOWED);
    expect(r.ok).toBe(false);
  });

  it('已正确的表名不受影响', () => {
    expect(repairTablePrefixes('SELECT * FROM fct_jc_main_biz_stat', WIDE))
      .toBe('SELECT * FROM fct_jc_main_biz_stat');
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
  it('无 LIMIT 追加 100000', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders', ALLOWED);
    expect(r.ok && /LIMIT 100000$/.test(r.sql)).toBe(true);
  });

  it('超出上限的 LIMIT 被 clamp 到 100000', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 999999', ALLOWED);
    expect(r.ok && /LIMIT 100000$/.test(r.sql)).toBe(true);
  });

  it('合理 LIMIT 保持不变', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 50', ALLOWED);
    expect(r.ok && /LIMIT 50$/.test(r.sql)).toBe(true);
  });

  it('LIMIT offset, count 形式的 count 被 clamp', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 10, 999999', ALLOWED);
    expect(r.ok && /LIMIT 10, 100000$/.test(r.sql)).toBe(true);
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

describe('checkAstSafety: P1 AST 二道防线', () => {
  const allowed = new Set(['tbl_orders', 'tbl_clients']);

  it('合法 SELECT（含 JOIN 与子查询）通过', () => {
    expect(checkAstSafety('SELECT o.id FROM tbl_orders o JOIN tbl_clients c ON o.id=c.id', allowed).ok).toBe(true);
    expect(checkAstSafety('SELECT * FROM (SELECT id FROM tbl_orders) t', allowed).ok).toBe(true);
  });

  it('AST 层拦截白名单外的表', () => {
    const r = checkAstSafety('SELECT * FROM secret_table', allowed);
    expect(r.ok).toBe(false);
  });

  it('AST 层拦截非 select 语句类型', () => {
    const r = checkAstSafety('DELETE FROM tbl_orders', allowed);
    expect(r.ok).toBe(false);
  });

  it('解析失败时放行（第一道正则防线兜底）', () => {
    expect(checkAstSafety('SELECT ???invalid syntax!!!', allowed).ok).toBe(true);
  });

  it('validateSelectSql 集成：合法查询在双层防线下仍通过', () => {
    const r = validateSelectSql(
      "SELECT channel, SUM(amount) AS total FROM tbl_orders WHERE channel = '线上' GROUP BY channel ORDER BY total DESC",
      [{ name: 'tbl_orders', columns: [{ name: 'id' }, { name: 'amount' }, { name: 'channel' }] }]
    );
    expect(r.ok).toBe(true);
  });
});

describe('injectRowFilters: P1-3 行级权限 AST 强制注入', () => {
  it('JOIN 中受控表被包裹为过滤派生表，别名与外层列引用不变', () => {
    const r = injectRowFilters(
      'SELECT c.name, COUNT(*) FROM clients c JOIN visits v ON v.client_id = c.id GROUP BY c.name',
      { clients: "region = '华东'" }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toContain("(SELECT * FROM `clients` WHERE `region` = '华东') AS `c`");
      expect(r.sql).toContain('GROUP BY');
    }
  });

  it('SQL 未引用受控表时原样返回', () => {
    const r = injectRowFilters('SELECT * FROM visits', { clients: 'status = 1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toBe('SELECT * FROM visits');
  });

  it('空过滤表不做任何改写', () => {
    const r = injectRowFilters('SELECT COUNT(*) FROM clients', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toBe('SELECT COUNT(*) FROM clients');
  });

  it('UNION 两侧均被注入', () => {
    const r = injectRowFilters('SELECT * FROM clients UNION SELECT * FROM clients', { clients: 'status = 1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const matches = r.sql.match(/WHERE `status` = 1/g) || [];
      expect(matches.length).toBe(2);
    }
  });

  it('WHERE 内 IN 子查询中的受控表同样被注入', () => {
    const r = injectRowFilters(
      'SELECT * FROM clients WHERE id IN (SELECT client_id FROM visits)',
      { visits: "type = '电话'" }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain("FROM (SELECT * FROM `visits` WHERE `type` = '电话') AS `visits`");
  });

  it('嵌套派生表内的受控表递归注入', () => {
    const r = injectRowFilters('SELECT * FROM (SELECT * FROM clients) t', { clients: 'id < 10' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain('WHERE `id` < 10');
  });

  it('非法谓词 fail-closed 拒绝（不降级放行）', () => {
    const r = injectRowFilters('SELECT * FROM clients', { clients: 'this is not sql @@@' });
    expect(r.ok).toBe(false);
  });

  it('表名键大小写不敏感', () => {
    const r = injectRowFilters('SELECT * FROM Clients', { CLIENTS: 'id > 0' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain('WHERE `id` > 0');
  });

  it('PG 方言同样生效', () => {
    const r = injectRowFilters('SELECT * FROM clients', { clients: "region = '华东'" }, 'pg');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/WHERE.*region.*华东/);
  });

  it('v0.4.15：WITH CTE 定义内的受控表被递归注入，主查询 CTE 引用不受影响', () => {
    const r = injectRowFilters(
      'WITH cte AS (SELECT region, amount FROM clients WHERE id > 10) SELECT region, SUM(amount) FROM cte GROUP BY region',
      { clients: "region = '华东'" }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // CTE 内部真实表被包裹为过滤派生表
      expect(r.sql).toContain("SELECT * FROM `clients` WHERE `region` = '华东'");
      // WITH 结构保留
      expect(r.sql).toMatch(/^\s*WITH/i);
    }
  });
});

describe('PG 方言（postgresql/greenplum）支持', () => {
  it('dialectOfDsType 类型映射', () => {
    expect(dialectOfDsType('mysql')).toBe('mysql');
    expect(dialectOfDsType('postgresql')).toBe('pg');
    expect(dialectOfDsType('greenplum')).toBe('pg');
    expect(dialectOfDsType('csv')).toBeNull();
    expect(dialectOfDsType('demo')).toBeNull();
  });

  it('PG 方言下 MySQL 逗号 LIMIT 改写为 OFFSET 形式', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 10, 100', ALLOWED, [], 'pg');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 100 OFFSET 10$/);
  });

  it('PG 方言下原生 OFFSET 写法保留且 clamp 到 100000', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders LIMIT 999999 OFFSET 5', ALLOWED, [], 'pg');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 100000 OFFSET 5$/);
  });

  it('PG 方言无 LIMIT 时追加 LIMIT 100000', () => {
    const r = validateSelectSql('SELECT id FROM tbl_orders', ALLOWED, [], 'pg');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/LIMIT 100000$/);
  });

  it('PG 方言 AST 解析双引号标识符表白名单', () => {
    const allowed = new Set(['tbl_orders']);
    expect(checkAstSafety('SELECT "id" FROM "tbl_orders"', allowed, 'pg').ok).toBe(true);
    expect(checkAstSafety('SELECT * FROM secret_table', allowed, 'pg').ok).toBe(false);
  });

  it('PG 方言 AST 拦截非 select 语句类型', () => {
    const allowed = new Set(['tbl_orders']);
    expect(checkAstSafety('DELETE FROM tbl_orders', allowed, 'pg').ok).toBe(false);
  });
});

describe('injectMysqlMaxExecTime: v0.4.15 WITH 查询服务端超时 hint', () => {
  it('普通 SELECT 在开头注入 hint', () => {
    expect(injectMysqlMaxExecTime('SELECT id FROM t', 15000)).toBe('SELECT /*+ MAX_EXECUTION_TIME(15000) */ id FROM t');
  });

  it('WITH 单段 CTE：hint 注入主 SELECT 而非 CTE 内部', () => {
    const sql = 'WITH cte AS (SELECT id FROM t1) SELECT * FROM cte';
    const out = injectMysqlMaxExecTime(sql, 15000);
    expect(out).toBe('WITH cte AS (SELECT id FROM t1) SELECT /*+ MAX_EXECUTION_TIME(15000) */ * FROM cte');
  });

  it('WITH 多段 CTE：hint 注入最后的主 SELECT', () => {
    const sql = 'WITH a AS (SELECT x FROM t1), b AS (SELECT y FROM t2 JOIN a ON t2.id = a.x) SELECT * FROM b';
    const out = injectMysqlMaxExecTime(sql, 15000);
    expect(out).toBe('WITH a AS (SELECT x FROM t1), b AS (SELECT y FROM t2 JOIN a ON t2.id = a.x) SELECT /*+ MAX_EXECUTION_TIME(15000) */ * FROM b');
  });
});

describe('extractCteNames: v0.4.15 CTE 名提取', () => {
  it('WITH 开头提取全部 CTE 名（小写）', () => {
    const names = extractCteNames('WITH a AS (SELECT 1), `B` AS (SELECT 2) SELECT * FROM a JOIN b');
    expect([...names].sort()).toEqual(['a', 'b']);
  });

  it('非 WITH 开头返回空集合', () => {
    expect(extractCteNames('SELECT a AS x FROM t').size).toBe(0);
  });
});

describe('dsPoolMax: P1-9 数据源连接池容量公式化', () => {
  afterEach(() => {
    delete process.env.DS_POOL_MAX;
    delete process.env.EXPECTED_CONCURRENT_USERS;
  });

  it('默认（20 并发用户）= ceil(20/4) = 5，不逊于原硬编码 3', () => {
    expect(dsPoolMax()).toBe(5);
  });

  it('公式：容量 ≈ 并发用户数 / 4，clamp 到 [3, 20]', () => {
    process.env.EXPECTED_CONCURRENT_USERS = '8';
    expect(dsPoolMax()).toBe(3); // 下限保底
    process.env.EXPECTED_CONCURRENT_USERS = '40';
    expect(dsPoolMax()).toBe(10);
    process.env.EXPECTED_CONCURRENT_USERS = '200';
    expect(dsPoolMax()).toBe(20); // 上限防打爆数据源
  });

  it('DS_POOL_MAX 显式配置优先于公式', () => {
    process.env.EXPECTED_CONCURRENT_USERS = '40';
    process.env.DS_POOL_MAX = '8';
    expect(dsPoolMax()).toBe(8);
  });

  it('非法显式值回退公式；显式值 clamp 到 [1, 100]', () => {
    process.env.DS_POOL_MAX = 'abc';
    expect(dsPoolMax()).toBe(5);
    process.env.DS_POOL_MAX = '500';
    expect(dsPoolMax()).toBe(100);
  });
});

describe('appPoolMax: P1-9 应用库连接池容量公式化', () => {
  afterEach(() => {
    delete process.env.APP_POOL_MAX;
    delete process.env.EXPECTED_CONCURRENT_USERS;
  });

  it('默认（20 并发用户）= ceil(20/2) = 10，与原硬编码一致', () => {
    expect(appPoolMax()).toBe(10);
  });

  it('公式：容量 ≈ 并发用户数 / 2，clamp 到 [10, 50]', () => {
    process.env.EXPECTED_CONCURRENT_USERS = '10';
    expect(appPoolMax()).toBe(10); // 下限保底
    process.env.EXPECTED_CONCURRENT_USERS = '60';
    expect(appPoolMax()).toBe(30);
    process.env.EXPECTED_CONCURRENT_USERS = '500';
    expect(appPoolMax()).toBe(50); // 上限
  });

  it('APP_POOL_MAX 显式配置优先于公式', () => {
    process.env.APP_POOL_MAX = '25';
    expect(appPoolMax()).toBe(25);
  });
});
