/**
 * metrics 路由契约测试（质量优化 Stage 2）：语义指标层治理（列表/创建/统一查询/导入导出/审批/版本/删除）。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404/409/429）+ 成功路径（含统一查询执行链路）。
 * 注：本路由为 router.use(authMiddleware)，仅 /query 与写端点叠加 requireRole。
 * 说明：executeSafeSql 为真实 DB 执行入口，契约层按模块级 spy 替换（其余导出经 importActual 保留），
 *      以便 dbStub 仅承担字符串形式的应用库查询。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

/** 安全执行层桩：metrics 仅直接依赖 executeSafeSql，其余导出经 importActual 原样保留 */
const execSpy = vi.fn();
vi.mock('../query/sqlExecutor', async () => {
  const actual: Record<string, unknown> = await vi.importActual('../query/sqlExecutor');
  return { ...actual, executeSafeSql: (...args: unknown[]) => execSpy(...args) };
});

import metricsRoutes from './metrics';
import { checkUserQueryLimit, _resetForTest } from '../infra/userQueryLimit';

applyTestEnv();

const app = buildApp('/api/metrics', metricsRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const ANALYST_TOKEN = tokenFor('ANALYST', 7);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const analystAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 7)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

/** 以鉴权行开头拼装桩规则（authMiddleware 回查恒最先执行） */
const adminStub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);
const analystStub = (...rules: DbStubRule[]) => dbStub([analystAuth, ...rules]);

/** INSERT/UPDATE 的 ResultSetHeader 语义返回（dbStub 原样透传行集，用「带属性的数组」冒充 affectedRows/insertId） */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** 指标定义行（列名与 metric_definitions 表对齐） */
const metricRow = (over: Record<string, unknown> = {}) => ({
  id: 5,
  data_source_id: 'ds_m1',
  name: '有效客户数',
  aliases_json: '["客户数"]',
  description: '口径：去重客户',
  expr: 'COUNT(DISTINCT id)',
  table_name: 'clients',
  filters: '',
  dimensions_json: '["region"]',
  status: 'ACTIVE',
  version: 1,
  approved_by: '',
  approved_at: null,
  created_by: 'admin',
  ...over,
});

/** data_sources 上下文加载行（loadSchemaContext SELECT 列对齐） */
const dsSchemaRow = (over: Record<string, unknown> = {}) => ({
  name: '数据源一',
  schema_json: '[]',
  scope_json: null,
  status: 'connected',
  type: 'mysql',
  allow_introspection: 0,
  config_json: null,
  ...over,
});

const analyzedRow = { region: '华东', value: 10 };

const get = (url: string, token = ADMIN_TOKEN) => request(app).get(url).set('Authorization', `Bearer ${token}`);
const post = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).post(url).set('Authorization', `Bearer ${token}`).send(body as object);
const put = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).put(url).set('Authorization', `Bearer ${token}`).send(body as object);
const del = (url: string, token = ADMIN_TOKEN) => request(app).delete(url).set('Authorization', `Bearer ${token}`);

beforeEach(() => {
  querySpy.mockReset();
  execSpy.mockReset();
  _resetForTest();
});

describe('鉴权与角色守卫', () => {
  it('GET / 缺少 token → 401', async () => {
    const res = await request(app).get('/api/metrics?dataSourceId=ds_m1');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('POST /query 角色 VIEWER → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await post('/api/metrics/query', { metricId: 5 }, VIEWER_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('GET /export 角色 ANALYST → 403（仅 ADMIN）', async () => {
    querySpy.mockImplementation(dbStub([analystAuth]));
    const res = await get('/api/metrics/export?dataSourceId=ds_m1', ANALYST_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('PUT /:id 角色 ANALYST → 403（仅 ADMIN）', async () => {
    querySpy.mockImplementation(dbStub([analystAuth]));
    const res = await put('/api/metrics/5', { name: '改名', expr: 'SUM(y)', tableName: 't2' }, ANALYST_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/metrics：指标列表', () => {
  it('缺少 dataSourceId → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await get('/api/metrics');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('成功 → 200 返回指标定义列表', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'FROM metric_definitions WHERE data_source_id = ? ORDER BY created_at DESC', rows: () => [metricRow()] }),
    );
    const res = await get('/api/metrics?dataSourceId=ds_m1');
    expect(res.status).toBe(200);
    expect(res.body.metrics).toHaveLength(1);
    expect(res.body.metrics[0]).toMatchObject({
      id: 5,
      dataSourceId: 'ds_m1',
      name: '有效客户数',
      expr: 'COUNT(DISTINCT id)',
      tableName: 'clients',
      status: 'ACTIVE',
    });
    expect(res.body.metrics[0].dimensions).toEqual(['region']);
  });

  it('DB 异常 → 500 兜底文案', async () => {
    // 仅装配鉴权行：列表 SQL 未配桩 → dbStub 抛错 → 路由 catch
    querySpy.mockImplementation(adminStub());
    const res = await get('/api/metrics?dataSourceId=ds_m1');
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('查询指标失败');
  });
});

describe('POST /api/metrics：新建指标（治理状态机）', () => {
  it('指标名缺失 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/metrics', { dataSourceId: 'ds_m1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('指标名必填且不超过 50 字');
  });

  it('同名指标已存在 → 409', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? LIMIT 1', rows: [{ id: 9 }] }),
    );
    const res = await post('/api/metrics', { dataSourceId: 'ds_m1', name: '有效客户数', expr: 'SUM(x)', tableName: 't1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('同名指标已存在');
  });

  it('ADMIN 创建 → 200 直接生效（ACTIVE）', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? LIMIT 1', rows: [] },
        { match: 'INSERT INTO metric_definitions', rows: resultSet({ insertId: 55, affectedRows: 1 }) },
        { match: 'INSERT INTO metric_versions', rows: [] },
      ),
    );
    const res = await post('/api/metrics', { dataSourceId: 'ds_m1', name: '新指标', expr: 'SUM(amount)', tableName: 't1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(55);
    expect(res.body.status).toBe('ACTIVE');
  });

  it('ANALYST 创建 → 200 提交为提议（PENDING）', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: 'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? LIMIT 1', rows: [] },
        { match: 'INSERT INTO metric_definitions', rows: resultSet({ insertId: 56, affectedRows: 1 }) },
        { match: 'INSERT INTO metric_versions', rows: [] },
      ),
    );
    const res = await post('/api/metrics', { dataSourceId: 'ds_m1', name: '提议指标', expr: 'SUM(amount)', tableName: 't1' }, ANALYST_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
  });
});

describe('POST /api/metrics/query：统一指标查询', () => {
  it('非法指标 ID → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/metrics/query', { metricId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('非法指标 ID');
  });

  it('指标不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: [] }));
    const res = await post('/api/metrics/query', { metricId: 5 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('指标不存在');
  });

  it('无该数据源访问权限 → 403', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ id: 6, data_source_id: 'ds_acl' })] },
        { match: 'SELECT acl_json FROM data_sources WHERE id = ?', rows: [{ acl_json: '{"departments":["其他部门"],"userIds":[]}' }] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post('/api/metrics/query', { metricId: 6 }, ANALYST_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有该数据源的访问权限，可向管理员申请开通');
  });

  it('指标未生效（PENDING）→ 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'PENDING' })] }),
    );
    const res = await post('/api/metrics/query', { metricId: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('指标未生效，不可查询');
  });

  it('用户级配额耗尽 → 429', async () => {
    process.env.USER_QUERY_RATE_MAX = '1';
    _resetForTest();
    await checkUserQueryLimit(1); // 预先消耗唯一配额
    try {
      querySpy.mockImplementation(
        adminStub(
          { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow()] },
          { match: 'INSERT INTO query_audit_log', rows: [] },
        ),
      );
      const res = await post('/api/metrics/query', { metricId: 5 });
      expect(res.status).toBe(429);
      expect(String(res.body.error)).toContain('问数上限');
    } finally {
      delete process.env.USER_QUERY_RATE_MAX;
      _resetForTest();
    }
  });

  it('成功 → 200 返回口径 SQL/结果行/金额单位标注', async () => {
    execSpy.mockResolvedValue({
      ok: true,
      result: {
        rows: [analyzedRow],
        rowCount: 1,
        truncated: false,
        finalSql: 'SELECT region, COUNT(DISTINCT id) AS `value` FROM clients GROUP BY region LIMIT 100',
      },
    });
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ data_source_id: 'ds_q_ok' })] },
        { match: 'schema_json, scope_json', rows: () => [dsSchemaRow()] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post('/api/metrics/query', { metricId: 5, dimensions: ['region'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.metric).toMatchObject({ id: 5, name: '有效客户数', expr: 'COUNT(DISTINCT id)', tableName: 'clients' });
    expect(res.body.groupBy).toEqual(['region']);
    expect(typeof res.body.sql).toBe('string');
    expect(res.body.rows).toEqual([analyzedRow]);
    expect(res.body.rowCount).toBe(1);
    expect(res.body.truncated).toBe(false);
    expect(res.body.amountUnit).toEqual({ label: '元', applied: false });
  });
});

describe('GET /api/metrics/export：导出指标库', () => {
  it('缺少 dataSourceId → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await get('/api/metrics/export');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('数据源不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'SELECT name FROM data_sources WHERE id = ?', rows: [] }));
    const res = await get('/api/metrics/export?dataSourceId=ds_missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('数据源不存在：ds_missing');
  });

  it('成功 → 200 返回指标库 JSON 备份', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT name FROM data_sources WHERE id = ?', rows: [{ name: '数据源一' }] },
        { match: 'FROM metric_definitions WHERE data_source_id = ? ORDER BY created_at DESC', rows: () => [metricRow()] },
      ),
    );
    const res = await get('/api/metrics/export?dataSourceId=ds_m1');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    expect(res.body.type).toBe('metric-definitions');
    expect(res.body.dataSourceId).toBe('ds_m1');
    expect(res.body.metricCount).toBe(1);
  });
});

describe('POST /api/metrics/import：导入指标库（仅 ADMIN）', () => {
  it('缺少 fileData → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/metrics/import', { dataSourceId: 'ds_m1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 fileData（备份文件的 JSON 内容）');
  });

  it('mergeStrategy 非法 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/metrics/import', { fileData: { type: 'metric-definitions', metrics: [{}] }, mergeStrategy: 'append' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('mergeStrategy 必须是 skip / overwrite');
  });

  it('文件格式不可识别 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/metrics/import', { fileData: { type: 'other', metrics: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无法识别的文件格式：应为指标库导出文件（type=metric-definitions）');
  });

  it('文件中无可导入指标 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/metrics/import', { fileData: { type: 'metric-definitions', metrics: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('文件中没有可导入的指标');
  });

  it('目标数据源不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'SELECT id, name FROM data_sources WHERE id = ?', rows: [] }));
    const res = await post('/api/metrics/import', {
      fileData: { type: 'metric-definitions', metrics: [{ name: 'A', expr: 'SUM(x)', tableName: 't1' }] },
      dataSourceId: 'ds_missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('目标数据源不存在：ds_missing');
  });

  it('dryRun 预检成功 → 200 且不写库', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT id, name FROM data_sources WHERE id = ?', rows: [{ id: 'ds_imp', name: '导入源' }] },
        { match: 'SELECT id, name FROM metric_definitions WHERE data_source_id = ?', rows: [] },
      ),
    );
    const res = await post('/api/metrics/import', {
      fileData: { type: 'metric-definitions', metrics: [{ name: '指标A', expr: 'SUM(x)', tableName: 't1' }] },
      dataSourceId: 'ds_imp',
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.importedCount).toBe(1);
    expect(res.body.dataSourceName).toBe('导入源');
  });
});

describe('PUT /api/metrics/:id：更新指标（仅 ADMIN）', () => {
  const body = { name: '改名', expr: 'SUM(y)', tableName: 't2' };

  it('非法指标 ID → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await put('/api/metrics/abc', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('非法指标 ID');
  });

  it('指标不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: [] }));
    const res = await put('/api/metrics/5', body);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('指标不存在');
  });

  it('成功 → 200', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow()] },
        { match: 'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? AND id <> ? LIMIT 1', rows: [] },
        { match: 'UPDATE metric_definitions SET', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO metric_versions', rows: [] },
      ),
    );
    const res = await put('/api/metrics/5', body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('审批 / 重新提议 / 版本历史 / 回溯', () => {
  it('POST /:id/approve 非待审批状态 → 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'ACTIVE' })] }),
    );
    const res = await post('/api/metrics/5/approve', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('该指标不在待审批状态');
  });

  it('POST /:id/approve 成功 → 200', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'PENDING' })] },
        { match: 'UPDATE metric_definitions SET status', rows: [] },
        { match: 'INSERT INTO metric_versions', rows: [] },
      ),
    );
    const res = await post('/api/metrics/5/approve', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /:id/repropose 非被驳回 → 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'ACTIVE' })] }),
    );
    const res = await post('/api/metrics/5/repropose', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('仅被驳回的指标可重新提议');
  });

  it('POST /:id/repropose 成功 → 200 置回 PENDING', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'REJECTED' })] },
        { match: 'UPDATE metric_definitions SET status', rows: resultSet({ affectedRows: 1 }) },
      ),
    );
    const res = await post('/api/metrics/5/repropose', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /:id/reject 非待审批状态 → 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'ACTIVE' })] }),
    );
    const res = await post('/api/metrics/5/reject', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('该指标不在待审批状态');
  });

  it('POST /:id/reject 成功 → 200 置为 REJECTED', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'PENDING' })] },
        { match: 'UPDATE metric_definitions SET status', rows: resultSet({ affectedRows: 1 }) },
      ),
    );
    const res = await post('/api/metrics/5/reject', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /:id/versions 非法指标 ID → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await get('/api/metrics/abc/versions');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('非法指标 ID');
  });

  it('GET /:id/versions 成功 → 200 返回版本历史', async () => {
    querySpy.mockImplementation(
      adminStub({
        match: 'SELECT * FROM metric_versions WHERE metric_id = ? ORDER BY version DESC',
        rows: [{ id: 1, metric_id: 5, version: 2, snapshot_json: '{"name":"旧名"}', action: 'UPDATE', actor: 'admin', created_at: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    const res = await get('/api/metrics/5/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0]).toMatchObject({ version: 2, action: 'UPDATE', actor: 'admin' });
  });

  it('POST /:id/restore 待审批指标不可回溯 → 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'PENDING' })] }),
    );
    const res = await post('/api/metrics/5/restore', { version: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('待审批指标不可回溯');
  });

  it('POST /:id/restore 版本不存在 → 404', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'ACTIVE' })] },
        { match: 'SELECT * FROM metric_versions WHERE metric_id = ? AND version = ?', rows: [] },
      ),
    );
    const res = await post('/api/metrics/5/restore', { version: 99 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('版本不存在');
  });

  it('POST /:id/restore 成功 → 200 且写 RESTORE 历史', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', rows: () => [metricRow({ status: 'ACTIVE' })] },
        {
          match: 'SELECT * FROM metric_versions WHERE metric_id = ? AND version = ?',
          rows: [{ snapshot_json: JSON.stringify({ name: '旧名', aliases: [], description: '', expr: 'SUM(x)', tableName: 't1', filters: '', dimensions: [] }) }],
        },
        { match: 'UPDATE metric_definitions SET', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO metric_versions', rows: [] },
      ),
    );
    const res = await post('/api/metrics/5/restore', { version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('DELETE /api/metrics/:id：删除指标（仅 ADMIN）', () => {
  it('非法指标 ID → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await del('/api/metrics/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('非法指标 ID');
  });

  it('指标不存在（affectedRows=0）→ 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'DELETE FROM metric_definitions WHERE id = ?', rows: resultSet({ affectedRows: 0 }) }));
    const res = await del('/api/metrics/5');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('指标不存在');
  });

  it('成功 → 200', async () => {
    querySpy.mockImplementation(adminStub({ match: 'DELETE FROM metric_definitions WHERE id = ?', rows: resultSet({ affectedRows: 1 }) }));
    const res = await del('/api/metrics/5');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
