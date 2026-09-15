/**
 * flexQueries 路由契约测试（质量优化 Stage 2）：固定报表 CRUD + 个人查询历史整组读写。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404/409）+ 成功路径。
 * 注：本路由为端点级内联 authMiddleware（GET 全员可见；写操作限 ADMIN/ANALYST）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import flexQueryRoutes from './flexQueries';

applyTestEnv();

const app = buildApp('/api/flex-queries', flexQueryRoutes);

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

/** 按 query_id 查单条的 SQL 唯一子串（不能只写 'FROM flex_queries WHERE query_id'，否则会抢占 DELETE 语句） */
const SELECT_BY_QUERY_ID = 'SELECT query_id, user_id, username, data_source_id, query_data, created_at FROM flex_queries WHERE query_id';

/** flex_queries 表行（列结构与路由 SELECT 对齐） */
const flexRow = (over: Record<string, unknown> = {}) => ({
  query_id: 'flex-1',
  user_id: 5,
  username: 'u5',
  data_source_id: 'ds-1',
  query_data: JSON.stringify({
    id: 'flex-1',
    name: '月度投放报表',
    dataSourceId: 'ds-1',
    config: { dimension: 'month' },
    chartType: 'bar',
    createdAt: '2026-01-01T00:00:00.000Z',
  }),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  querySpy.mockReset();
  // 默认仅装配鉴权回查；需要业务 SQL 的用例再行覆盖（dbStub 未命中规则即抛错，避免假通过）
  querySpy.mockImplementation(analystStub());
});

describe('鉴权与角色守卫（端点级内联 authMiddleware / requireRole）', () => {
  it('GET / 缺少 token → 401', async () => {
    const res = await request(app).get('/api/flex-queries');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('GET / token 非法 → 401（不进入 DB 回查）', async () => {
    const res = await request(app).get('/api/flex-queries').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('登录状态无效，请重新登录');
  });

  it('POST / 非 ADMIN/ANALYST 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/flex-queries')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ query: { id: 'flex-1', name: '报表', config: {} } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('DELETE /:queryId 非 ADMIN/ANALYST 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).delete('/api/flex-queries/flex-1').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/flex-queries：固定报表列表', () => {
  it('成功（无过滤）→ 200 且 query_data 展开为 query 对象', async () => {
    querySpy.mockImplementation(analystStub({ match: 'FROM flex_queries ORDER BY created_at DESC', rows: [flexRow()] }));
    const res = await request(app).get('/api/flex-queries').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.queries).toHaveLength(1);
    expect(res.body.queries[0]).toMatchObject({ queryId: 'flex-1', userId: 5, username: 'u5', dataSourceId: 'ds-1' });
    expect(res.body.queries[0].query.name).toBe('月度投放报表');
    expect(res.body.queries[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('query_data 非法 JSON → query 归一为 null（不抛错）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'FROM flex_queries ORDER BY created_at DESC', rows: [flexRow({ query_data: 'not-json' })] }));
    const res = await request(app).get('/api/flex-queries').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.queries[0].query).toBeNull();
  });

  it('带 dataSourceId 过滤 → 200 走过滤 SQL', async () => {
    querySpy.mockImplementation(analystStub({ match: 'FROM flex_queries WHERE data_source_id = ?', rows: [flexRow()] }));
    const res = await request(app).get('/api/flex-queries?dataSourceId=ds-1').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.queries).toHaveLength(1);
  });

  it('DB 异常 → 500 统一错误码', async () => {
    const res = await request(app).get('/api/flex-queries').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('固定报表列表获取失败');
  });
});

describe('GET /api/flex-queries/history：个人查询历史读取', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/flex-queries/history');
    expect(res.status).toBe(401);
  });

  it('无记录 → 200 items 为空数组', async () => {
    querySpy.mockImplementation(analystStub({ match: 'SELECT history_data FROM flex_query_history', rows: [] }));
    const res = await request(app).get('/api/flex-queries/history').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, items: [] });
  });

  it('有记录 → 200 返回解析后的 items', async () => {
    querySpy.mockImplementation(
      analystStub({ match: 'SELECT history_data FROM flex_query_history', rows: [{ history_data: JSON.stringify([{ id: 'h1', config: {} }]) }] }),
    );
    const res = await request(app).get('/api/flex-queries/history').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: 'h1', config: {} }]);
  });

  it('history_data 非法 JSON → 200 items 降级为空数组', async () => {
    querySpy.mockImplementation(analystStub({ match: 'SELECT history_data FROM flex_query_history', rows: [{ history_data: '{bad' }] }));
    const res = await request(app).get('/api/flex-queries/history').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('DB 异常 → 500', async () => {
    const res = await request(app).get('/api/flex-queries/history').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

describe('PUT /api/flex-queries/history：个人历史整组替换', () => {
  const put = (body: Record<string, unknown>) =>
    request(app).put('/api/flex-queries/history').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).put('/api/flex-queries/history').send({ items: [] });
    expect(res.status).toBe(401);
  });

  it('items 非数组 → 200 且按空集落库（count=0）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'INSERT INTO flex_query_history', rows: [] }));
    const res = await put({ items: 'nope' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 0 });
  });

  it('成功 → 200 且非法条目被过滤、超上限被裁剪为 8 条', async () => {
    querySpy.mockImplementation(analystStub({ match: 'INSERT INTO flex_query_history', rows: [] }));
    const items = [
      ...Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, config: {} })),
      { id: 123, config: {} },
      { id: 'bad', config: null },
    ];
    const res = await put({ items });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(8);
  });

  it('DB 异常 → 500', async () => {
    const res = await put({ items: [{ id: 'h1', config: {} }] });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('查询历史保存失败');
  });
});

describe('POST /api/flex-queries：保存固定报表', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/flex-queries').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/flex-queries').send({ query: { id: 'flex-1', name: 'n', config: {} } });
    expect(res.status).toBe(401);
  });

  it('载荷非对象 → 400 INVALID_INPUT', async () => {
    const res = await post({ query: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('固定报表数据格式不正确');
  });

  it('缺少固定报表标识 → 400', async () => {
    const res = await post({ query: { name: '月度报表', config: {} } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少固定报表标识');
  });

  it('名称为空 → 400', async () => {
    const res = await post({ query: { id: 'flex-1', name: '   ', config: {} } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('固定报表名称不能为空');
  });

  it('缺少查询配置 → 400', async () => {
    const res = await post({ query: { id: 'flex-1', name: '月度报表' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少查询配置');
  });

  it('保存成功 → 201 返回 queryId', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: 'INSERT INTO flex_queries', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post({ query: { id: 'flex-1', name: '月度报表', dataSourceId: 'ds-1', config: {}, chartType: 'bar' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, queryId: 'flex-1' });
  });

  it('query_id 唯一冲突 → 409 CONFLICT（迁移幂等语义）', async () => {
    querySpy.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO flex_queries')) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      return analystStub()(sql, params);
    });
    const res = await post({ query: { id: 'flex-1', name: '月度报表', config: {} } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.error).toBe('固定报表已存在');
  });
});

describe('DELETE /api/flex-queries/:queryId：删除固定报表', () => {
  const del = (id: string, token = ANALYST_TOKEN) =>
    request(app).delete(`/api/flex-queries/${id}`).set('Authorization', `Bearer ${token}`);

  it('无 token → 401', async () => {
    const res = await request(app).delete('/api/flex-queries/flex-1');
    expect(res.status).toBe(401);
  });

  it('记录不存在 → 404 NOT_FOUND', async () => {
    querySpy.mockImplementation(analystStub({ match: SELECT_BY_QUERY_ID, rows: [] }));
    const res = await del('flex-404');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('固定报表不存在');
  });

  it('非本人且非 ADMIN → 404 且落 DENIED_AUTH 审计', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 9 })] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await del('flex-1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO query_audit_log'), expect.anything());
  });

  it('本人删除 → 200', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 5 })] },
        { match: 'DELETE FROM flex_queries WHERE query_id = ?', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await del('flex-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('ADMIN 删除他人报表 → 200（越权豁免）', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 9 })] },
        { match: 'DELETE FROM flex_queries WHERE query_id = ?', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ]),
    );
    const res = await del('flex-1', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DB 异常 → 500', async () => {
    // 命中查询但 DELETE 未配桩 → 抛错
    querySpy.mockImplementation(analystStub({ match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 5 })] }));
    const res = await del('flex-1');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('固定报表删除失败');
  });
});
