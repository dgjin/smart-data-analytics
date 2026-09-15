/**
 * patrols 路由契约测试（质量优化 Stage 2）：异常巡检订阅（列表/新建/更新/删除/立即执行/运行历史）。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404）+ 成功路径（列表/创建/更新/删除/执行）。
 * 注：本路由为 router.use(authMiddleware)，各端点在 handler 内叠加 requireRole('ADMIN','ANALYST')。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import patrolsRoutes from './patrols';

applyTestEnv();

const app = buildApp('/api/patrols', patrolsRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

/** authMiddleware 回查行（ADMIN；恒为请求链上第一条 SQL） */
const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
/** authMiddleware 回查行（VIEWER，仅用于 403 用例） */
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

/** 以鉴权行开头拼装桩规则（authMiddleware 回查恒最先执行） */
const stub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/**
 * INSERT/UPDATE 的 ResultSetHeader 语义返回（dbStub 原样透传行集，用「带属性的数组」冒充 affectedRows/insertId）。
 */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** 巡检计划行（列名与 anomaly_patrols 表对齐） */
const patrolRow = (over: Record<string, unknown> = {}) => ({
  patrol_id: 'patrol-abc',
  user_id: 1,
  username: 'u1',
  data_source_id: 'ds_1',
  name: '测试巡检',
  interval_minutes: 60,
  status: 'ACTIVE',
  next_run_at: new Date('2026-09-15T10:00:00.000Z'),
  last_run_at: null,
  last_run_status: '',
  last_anomaly_count: 0,
  created_at: new Date('2026-09-15T09:00:00.000Z'),
  ...over,
});

/** 巡检运行记录行（列名与 anomaly_patrol_runs 表对齐） */
const runRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  patrol_id: 'patrol-abc',
  run_at: new Date('2026-09-15T10:00:00.000Z'),
  status: 'CLEAN',
  report_id: 'report-1',
  report_title: '测试报表',
  anomaly_count: 0,
  high_count: 0,
  anomalies_json: null,
  error: '',
  ...over,
});

const get = (url: string, token = ADMIN_TOKEN) => request(app).get(url).set('Authorization', `Bearer ${token}`);
const post = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).post(url).set('Authorization', `Bearer ${token}`).send(body as object);
const put = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).put(url).set('Authorization', `Bearer ${token}`).send(body as object);
const del = (url: string, token = ADMIN_TOKEN) => request(app).delete(url).set('Authorization', `Bearer ${token}`);

beforeEach(() => {
  querySpy.mockReset();
});

describe('鉴权与角色守卫（router.use(authMiddleware) + requireRole）', () => {
  it('缺少 token → 401', async () => {
    const res = await request(app).get('/api/patrols');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('token 有效但账号被禁用 → 401', async () => {
    querySpy.mockImplementation(
      dbStub([{ match: 'must_change_password FROM users WHERE id', rows: [{ ...activeUserRow('ADMIN', 1), status: 'DISABLED' }] }]),
    );
    const res = await get('/api/patrols');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('账号不存在或已被禁用');
  });

  it('非 ADMIN/ANALYST 角色访问新建端点 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await post('/api/patrols', { dataSourceId: 'ds_1', intervalMinutes: 60 }, VIEWER_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('非 ADMIN/ANALYST 角色访问立即执行端点 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await post('/api/patrols/patrol-abc/run', {}, VIEWER_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/patrols：巡检计划列表', () => {
  it('成功（无过滤）→ 200 返回全部计划', async () => {
    querySpy.mockImplementation(stub({ match: 'FROM anomaly_patrols ORDER BY id DESC LIMIT 200', rows: () => [patrolRow()] }));
    const res = await get('/api/patrols');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.patrols).toHaveLength(1);
    expect(res.body.patrols[0]).toMatchObject({ patrolId: 'patrol-abc', dataSourceId: 'ds_1', intervalMinutes: 60, status: 'ACTIVE' });
  });

  it('按 dataSourceId 过滤 → 200 且命中过滤 SQL', async () => {
    querySpy.mockImplementation(
      stub({ match: 'FROM anomaly_patrols WHERE data_source_id = ?', rows: () => [patrolRow({ data_source_id: 'ds_2' })] }),
    );
    const res = await get('/api/patrols?dataSourceId=ds_2');
    expect(res.status).toBe(200);
    expect(res.body.patrols[0].dataSourceId).toBe('ds_2');
  });

  it('DB 异常 → 500 兜底错误码文案', async () => {
    // 仅装配鉴权行：列表 SQL 未配桩 → dbStub 抛错 → 路由 catch
    querySpy.mockImplementation(stub());
    const res = await get('/api/patrols');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('获取巡检计划失败');
  });
});

describe('POST /api/patrols：新建巡检计划', () => {
  it('缺少 dataSourceId → 400', async () => {
    querySpy.mockImplementation(stub());
    const res = await post('/api/patrols', { intervalMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('巡检间隔越界（<15 分钟）→ 400', async () => {
    querySpy.mockImplementation(stub());
    const res = await post('/api/patrols', { dataSourceId: 'ds_1', intervalMinutes: 5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('巡检间隔需为 15~43200 之间的整数分钟');
  });

  it('数据源不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT id, name FROM data_sources WHERE id = ?', rows: [] }));
    const res = await post('/api/patrols', { dataSourceId: 'ds_missing', intervalMinutes: 60 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('数据源不存在：ds_missing');
  });

  it('成功 → 201 返回新建计划（名称缺省按数据源命名）', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT id, name FROM data_sources WHERE id = ?', rows: () => [{ id: 'ds_1', name: '数据源一' }] },
        { match: 'INSERT INTO anomaly_patrols', rows: resultSet({ affectedRows: 1 }) },
        { match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: () => [patrolRow()] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post('/api/patrols', { dataSourceId: 'ds_1', intervalMinutes: 60 });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.patrol).toMatchObject({ patrolId: 'patrol-abc', intervalMinutes: 60, status: 'ACTIVE' });
  });
});

describe('PUT /api/patrols/:patrolId：更新计划', () => {
  it('巡检间隔越界（>43200 分钟）→ 400', async () => {
    querySpy.mockImplementation(stub());
    const res = await put('/api/patrols/patrol-abc', { intervalMinutes: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('巡检间隔需为 15~43200 之间的整数分钟');
  });

  it('status 非法值 → 400', async () => {
    querySpy.mockImplementation(stub());
    const res = await put('/api/patrols/patrol-abc', { status: 'STOPPED' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('status 仅支持 ACTIVE / PAUSED');
  });

  it('没有可更新字段 → 400', async () => {
    querySpy.mockImplementation(stub());
    const res = await put('/api/patrols/patrol-abc', {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('没有可更新的字段');
  });

  it('计划不存在（越权/缺失统一 404 防探测）→ 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: [] }));
    const res = await put('/api/patrols/patrol-none', { status: 'PAUSED' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('巡检计划不存在');
  });

  it('成功 → 200 返回更新后计划', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: () => [patrolRow({ status: 'PAUSED' })] },
        { match: 'UPDATE anomaly_patrols SET', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await put('/api/patrols/patrol-abc', { status: 'PAUSED', intervalMinutes: 120 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.patrol).toMatchObject({ patrolId: 'patrol-abc', status: 'PAUSED' });
  });
});

describe('DELETE /api/patrols/:patrolId：删除计划', () => {
  it('计划不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: [] }));
    const res = await del('/api/patrols/patrol-none');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('巡检计划不存在');
  });

  it('成功 → 200 且连带清理运行历史', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: () => [patrolRow()] },
        { match: 'DELETE FROM anomaly_patrols', rows: resultSet({ affectedRows: 1 }) },
        { match: 'DELETE FROM anomaly_patrol_runs', rows: resultSet({ affectedRows: 2 }) },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await del('/api/patrols/patrol-abc');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/patrols/:patrolId/run：立即执行一次', () => {
  it('计划不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: [] }));
    const res = await post('/api/patrols/patrol-none/run', {});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('巡检计划不存在');
  });

  it('成功（无 live 报表 → NO_DATA）→ 200 返回本次结果', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: () => [patrolRow()] },
        { match: 'FROM saved_reports', rows: [] },
        { match: 'INSERT INTO anomaly_patrol_runs', rows: resultSet({ affectedRows: 1 }) },
        { match: 'UPDATE anomaly_patrols SET last_run_at', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post('/api/patrols/patrol-abc/run', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toMatchObject({ status: 'NO_DATA', anomalyCount: 0, reportId: '' });
  });
});

describe('GET /api/patrols/:patrolId/runs：运行历史', () => {
  it('计划不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: [] }));
    const res = await get('/api/patrols/patrol-none/runs');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('巡检计划不存在');
  });

  it('成功 → 200 返回运行历史（新→旧）', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT * FROM anomaly_patrols WHERE patrol_id', rows: () => [patrolRow()] },
        { match: 'SELECT * FROM anomaly_patrol_runs WHERE patrol_id', rows: () => [runRow()] },
      ),
    );
    const res = await get('/api/patrols/patrol-abc/runs?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ patrolId: 'patrol-abc', status: 'CLEAN', anomalyCount: 0 });
  });
});
