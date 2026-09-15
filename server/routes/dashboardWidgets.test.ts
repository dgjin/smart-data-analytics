/**
 * dashboardWidgets 路由契约测试（质量优化 Stage 2）：看板固化图表 CRUD + 批量排序。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404/409）+ 成功路径。
 * 注：本路由为端点级内联 authMiddleware（GET 全员可见；固化/排序/更新/删除限 ADMIN/ANALYST）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import dashboardWidgetRoutes from './dashboardWidgets';

applyTestEnv();

const app = buildApp('/api/dashboard-widgets', dashboardWidgetRoutes);

const ANALYST_TOKEN = tokenFor('ANALYST', 5);
const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

/** authMiddleware 回查行（ANALYST，id=5） */
const analystAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 5)] };
/** authMiddleware 回查行（ADMIN，id=1） */
const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
/** authMiddleware 回查行（VIEWER，仅用于 403 用例） */
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

/** 以 ANALYST 鉴权行开头拼装桩规则 */
const analystStub = (...rules: DbStubRule[]) => dbStub([analystAuth, ...rules]);

/** 按 widget_id 查单条的 SQL 唯一子串（不能只写 'FROM dashboard_widgets WHERE widget_id'，否则会抢占 DELETE 语句） */
const SELECT_BY_WIDGET_ID = 'SELECT widget_id, user_id, username, widget_data FROM dashboard_widgets WHERE widget_id';

/** dashboard_widgets 表行（列结构与路由 SELECT 对齐） */
const widgetRow = (over: Record<string, unknown> = {}) => ({
  widget_id: 'w-1',
  user_id: 5,
  username: 'u5',
  widget_data: JSON.stringify({ id: 'w-1', title: '总览', chartConfig: { type: 'bar' }, data: [] }),
  ...over,
});

/** 最小合法载荷 */
const widgetPayload = (over: Record<string, unknown> = {}) => ({ id: 'w-1', title: '总览', chartConfig: { type: 'bar' }, data: [], ...over });

beforeEach(() => {
  querySpy.mockReset();
  // 默认仅装配鉴权回查；需要业务 SQL 的用例再行覆盖（dbStub 未命中规则即抛错，避免假通过）
  querySpy.mockImplementation(analystStub());
});

describe('鉴权与角色守卫（端点级内联 authMiddleware / requireRole）', () => {
  it('GET / 缺少 token → 401', async () => {
    const res = await request(app).get('/api/dashboard-widgets');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('POST / 非 ADMIN/ANALYST 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/dashboard-widgets')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ widget: widgetPayload() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('PUT /order 非 ADMIN/ANALYST 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).put('/api/dashboard-widgets/order').set('Authorization', `Bearer ${VIEWER_TOKEN}`).send({ ids: ['w-1'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/dashboard-widgets：看板图表列表', () => {
  it('成功 → 200 且 widget_data 展开为 widget 对象', async () => {
    querySpy.mockImplementation(analystStub({ match: 'FROM dashboard_widgets ORDER BY sort_order ASC', rows: [widgetRow()] }));
    const res = await request(app).get('/api/dashboard-widgets').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.widgets).toHaveLength(1);
    expect(res.body.widgets[0]).toMatchObject({ widgetId: 'w-1', userId: 5, username: 'u5' });
    expect(res.body.widgets[0].widget.title).toBe('总览');
  });

  it('widget_data 非法 JSON → widget 归一为 null（不抛错）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'FROM dashboard_widgets ORDER BY sort_order ASC', rows: [widgetRow({ widget_data: '{bad' })] }));
    const res = await request(app).get('/api/dashboard-widgets').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.widgets[0].widget).toBeNull();
  });

  it('DB 异常 → 500 统一错误码', async () => {
    const res = await request(app).get('/api/dashboard-widgets').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('看板图表列表获取失败');
  });
});

describe('POST /api/dashboard-widgets：固化图表', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/dashboard-widgets').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/dashboard-widgets').send({ widget: widgetPayload() });
    expect(res.status).toBe(401);
  });

  it('载荷非对象 → 400 INVALID_INPUT', async () => {
    const res = await post({ widget: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('图表数据格式不正确');
  });

  it('缺少图表标识 → 400', async () => {
    const res = await post({ widget: { title: '总览', chartConfig: {}, data: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少图表标识');
  });

  it('标题为空 → 400', async () => {
    const res = await post({ widget: widgetPayload({ title: '   ' }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('图表标题不能为空');
  });

  it('缺少图表配置 → 400', async () => {
    const res = await post({ widget: { id: 'w-1', title: '总览', data: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少图表配置');
  });

  it('data 非数组 → 400', async () => {
    const res = await post({ widget: { id: 'w-1', title: '总览', chartConfig: {}, data: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('图表数据必须为数组');
  });

  it('固化成功 → 201 返回 widgetId', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: 'INSERT INTO dashboard_widgets', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post({ widget: widgetPayload() });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, widgetId: 'w-1' });
  });

  it('widget_id 唯一冲突 → 409 CONFLICT（迁移幂等语义）', async () => {
    querySpy.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO dashboard_widgets')) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      return analystStub()(sql, params);
    });
    const res = await post({ widget: widgetPayload() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.error).toBe('图表已存在');
  });
});

describe('PUT /api/dashboard-widgets/order：批量排序', () => {
  const order = (body: Record<string, unknown>) =>
    request(app).put('/api/dashboard-widgets/order').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).put('/api/dashboard-widgets/order').send({ ids: ['w-1'] });
    expect(res.status).toBe(401);
  });

  it('ids 非数组 → 400', async () => {
    const res = await order({ ids: 'w-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('排序参数格式不正确');
  });

  it('ids 含非字符串/空串 → 400', async () => {
    const res1 = await order({ ids: ['w-1', ''] });
    expect(res1.status).toBe(400);
    const res2 = await order({ ids: ['w-1', 5] });
    expect(res2.status).toBe(400);
  });

  it('排序成功 → 200', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: 'UPDATE dashboard_widgets SET sort_order', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await order({ ids: ['w-2', 'w-1'] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DB 异常 → 500', async () => {
    const res = await order({ ids: ['w-1'] });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('看板图表排序失败');
  });
});

describe('PUT /api/dashboard-widgets/:widgetId：整体替换', () => {
  const put = (id: string, body: Record<string, unknown>) =>
    request(app).put(`/api/dashboard-widgets/${id}`).set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).put('/api/dashboard-widgets/w-1').send({ widget: widgetPayload() });
    expect(res.status).toBe(401);
  });

  it('非 ADMIN/ANALYST 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .put('/api/dashboard-widgets/w-1')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ widget: widgetPayload() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('载荷非法 → 400', async () => {
    const res = await put('w-1', { widget: { id: 'w-1', title: '' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('路径与图表标识不一致 → 400', async () => {
    const res = await put('w-9', { widget: widgetPayload({ id: 'w-1' }) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('路径与图表标识不一致');
  });

  it('图表不存在（affectedRows=0）→ 404 NOT_FOUND', async () => {
    querySpy.mockImplementation(analystStub({ match: 'UPDATE dashboard_widgets SET widget_data', rows: Object.assign([] as unknown[], { affectedRows: 0 }) }));
    const res = await put('w-1', { widget: widgetPayload() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('图表不存在');
  });

  it('更新成功 → 200', async () => {
    querySpy.mockImplementation(analystStub({ match: 'UPDATE dashboard_widgets SET widget_data', rows: Object.assign([] as unknown[], { affectedRows: 1 }) }));
    const res = await put('w-1', { widget: widgetPayload() });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DB 异常 → 500 兜底文案（UPDATE 未配桩即抛错）', async () => {
    const res = await put('w-1', { widget: widgetPayload() });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('看板图表更新失败');
  });
});

describe('DELETE /api/dashboard-widgets/:widgetId：删除图表', () => {
  const del = (id: string, token = ANALYST_TOKEN) =>
    request(app).delete(`/api/dashboard-widgets/${id}`).set('Authorization', `Bearer ${token}`);

  it('无 token → 401', async () => {
    const res = await request(app).delete('/api/dashboard-widgets/w-1');
    expect(res.status).toBe(401);
  });

  it('记录不存在 → 404 NOT_FOUND', async () => {
    querySpy.mockImplementation(analystStub({ match: SELECT_BY_WIDGET_ID, rows: [] }));
    const res = await del('w-404');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('图表不存在');
  });

  it('非本人且非 ADMIN → 404 且落 DENIED_AUTH 审计', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_WIDGET_ID, rows: [widgetRow({ user_id: 9 })] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await del('w-1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO query_audit_log'), expect.anything());
  });

  it('本人删除 → 200', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_WIDGET_ID, rows: [widgetRow({ user_id: 5 })] },
        { match: 'DELETE FROM dashboard_widgets WHERE widget_id = ?', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await del('w-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('ADMIN 删除出厂内置图表（user_id=0）→ 200', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: SELECT_BY_WIDGET_ID, rows: [widgetRow({ user_id: 0, username: 'system' })] },
        { match: 'DELETE FROM dashboard_widgets WHERE widget_id = ?', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ]),
    );
    const res = await del('w-1', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DB 异常 → 500 兜底文案（DELETE 未配桩即抛错）', async () => {
    querySpy.mockImplementation(analystStub({ match: SELECT_BY_WIDGET_ID, rows: [widgetRow({ user_id: 5 })] }));
    const res = await del('w-1');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('看板图表删除失败');
  });
});
