/**
 * flexQueries 路由契约测试（质量优化 Stage 2）：固定报表 CRUD + 个人查询历史整组读写。
 * v0.9.77 P2-15 扩展：使用打点 / 版本历史与回滚 / 订阅 CRUD 与立即执行 / Excel 导出 + 导出纯函数构建。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404/409/422）+ 成功路径。
 * 注：本路由为端点级内联 authMiddleware（GET 全员可见；写操作限 ADMIN/ANALYST）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
// v0.9.77 P2-15：订阅执行与固定报表服务端重放依赖真实数据源链路，契约层仅验证编排与响应
vi.mock('../flexSubscriptions', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../flexSubscriptions')>();
  return { ...orig, executeSubscription: vi.fn() };
});
vi.mock('../flexQueryRunner', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../flexQueryRunner')>();
  return { ...orig, runSavedFlexQuery: vi.fn() };
});

import flexQueryRoutes, { buildFlexExportFilename, buildFlexQueryExcel } from './flexQueries';
import { executeSubscription } from '../flexSubscriptions';
import { runSavedFlexQuery } from '../flexQueryRunner';

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
const SELECT_BY_QUERY_ID = 'SELECT query_id, user_id, username, data_source_id, query_data, version, use_count, last_used_at, created_at FROM flex_queries WHERE query_id';

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

/** v0.9.77 P2-15：删除固定报表后的级联清理（运行历史 → 订阅 → 版本历史） */
const cascadeDeletes: DbStubRule[] = [
  { match: 'DELETE FROM flex_query_subscription_runs', rows: [] },
  { match: 'DELETE FROM flex_query_subscriptions', rows: [] },
  { match: 'DELETE FROM flex_query_versions', rows: [] },
];

/** flex_query_subscriptions 表行（列结构与 SELECT * 对齐） */
const subRow = (over: Record<string, unknown> = {}) => ({
  subscription_id: 'sub-1',
  query_id: 'flex-1',
  user_id: 5,
  username: 'u5',
  frequency_minutes: 60,
  alert_metric: 'total_sales',
  alert_op: '>',
  alert_threshold: 1000,
  status: 'ACTIVE',
  last_run_at: null,
  next_run_at: new Date('2026-01-02T00:00:00.000Z'),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

/** 订阅单条查询 SQL 唯一子串 */
const SELECT_SUB = 'SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1';

beforeEach(() => {
  querySpy.mockReset();
  vi.mocked(executeSubscription).mockReset();
  vi.mocked(runSavedFlexQuery).mockReset();
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
        ...cascadeDeletes,
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
        ...cascadeDeletes,
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

describe('PUT /api/flex-queries/:queryId：更新固定报表（v0.9.77 版本号自增）', () => {
  const put = (body: Record<string, unknown>) =>
    request(app).put('/api/flex-queries/flex-1').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).put('/api/flex-queries/flex-1').send({ query: { id: 'flex-1', name: 'n', config: {} } });
    expect(res.status).toBe(401);
  });

  it('名称为空 → 400', async () => {
    const res = await put({ query: { id: 'flex-1', name: '   ', config: {} } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('固定报表名称不能为空');
  });

  it('记录不存在 → 404', async () => {
    querySpy.mockImplementation(analystStub({ match: SELECT_BY_QUERY_ID, rows: [] }));
    const res = await put({ query: { id: 'flex-1', name: '月度报表', config: {} } });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('非本人且非 ADMIN → 404 且落 DENIED_AUTH 审计', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 9 })] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await put({ query: { id: 'flex-1', name: '月度报表', config: {} } });
    expect(res.status).toBe(404);
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO query_audit_log'), expect.anything());
  });

  it('更新成功 → 200 且 version 自增（v1 → v2，并写版本快照）', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 5, version: 1 })] },
        { match: 'UPDATE flex_queries SET query_data', rows: [] },
        { match: 'INSERT INTO flex_query_versions', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await put({ query: { id: 'flex-1', name: '月度报表 v2', config: { dimension: 'month' } } });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO flex_query_versions'), expect.anything());
  });
});

describe('POST /api/flex-queries/:queryId/touch：使用打点（v0.9.77 P2-15）', () => {
  it('无 token → 401', async () => {
    const res = await request(app).post('/api/flex-queries/flex-1/touch');
    expect(res.status).toBe(401);
  });

  it('打点成功 → 200（use_count+1）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'UPDATE flex_queries SET use_count = use_count + 1', rows: [] }));
    const res = await request(app).post('/api/flex-queries/flex-1/touch').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('DB 异常 → 500（调用方容忍失败）', async () => {
    const res = await request(app).post('/api/flex-queries/flex-1/touch').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('使用打点失败');
  });
});

describe('GET /api/flex-queries/:queryId/versions：版本历史（v0.9.77 P2-15）', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/flex-queries/flex-1/versions');
    expect(res.status).toBe(401);
  });

  it('成功 → 200 且快照解析、坏 JSON 降级 null', async () => {
    querySpy.mockImplementation(
      analystStub({
        match: 'SELECT version, snapshot_json, action, actor, remark, created_at FROM flex_query_versions',
        rows: () => [
          {
            version: 2,
            snapshot_json: JSON.stringify({ id: 'flex-1', name: 'v2' }),
            action: 'UPDATE',
            actor: 'u5',
            remark: '',
            created_at: new Date('2026-01-02T00:00:00.000Z'),
          },
          { version: 1, snapshot_json: '{bad', action: 'CREATE', actor: 'u5', remark: '初始版本', created_at: new Date('2026-01-01T00:00:00.000Z') },
        ],
      }),
    );
    const res = await request(app).get('/api/flex-queries/flex-1/versions').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(2);
    expect(res.body.versions[0]).toMatchObject({ version: 2, action: 'UPDATE', snapshot: { id: 'flex-1', name: 'v2' } });
    expect(res.body.versions[0].createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect(res.body.versions[1].snapshot).toBeNull();
  });

  it('DB 异常 → 500', async () => {
    const res = await request(app).get('/api/flex-queries/flex-1/versions').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('版本历史获取失败');
  });
});

describe('POST /api/flex-queries/:queryId/versions/:version/restore：版本回滚（v0.9.77 P2-15）', () => {
  const restore = (v: string) =>
    request(app).post(`/api/flex-queries/flex-1/versions/${v}/restore`).set('Authorization', `Bearer ${ANALYST_TOKEN}`);

  it('版本号非整数 → 400', async () => {
    const res = await restore('abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('版本号非法');
  });

  it('报表不存在 → 404', async () => {
    querySpy.mockImplementation(analystStub({ match: SELECT_BY_QUERY_ID, rows: [] }));
    const res = await restore('1');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('固定报表不存在');
  });

  it('非本人且非 ADMIN → 404 且落 DENIED_AUTH 审计', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 9 })] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await restore('1');
    expect(res.status).toBe(404);
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO query_audit_log'), expect.anything());
  });

  it('版本不存在 → 404', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 5 })] },
        { match: 'SELECT snapshot_json FROM flex_query_versions', rows: [] },
      ),
    );
    const res = await restore('99');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('版本不存在');
  });

  it('快照损坏 → 500（不落脏数据）', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 5 })] },
        { match: 'SELECT snapshot_json FROM flex_query_versions', rows: [{ snapshot_json: '{bad' }] },
      ),
    );
    const res = await restore('1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('版本快照损坏');
  });

  it('回滚成功 → 200（version+1 且记 RESTORE 快照）', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_BY_QUERY_ID, rows: [flexRow({ user_id: 5, version: 3 })] },
        {
          match: 'SELECT snapshot_json FROM flex_query_versions',
          rows: [{ snapshot_json: JSON.stringify({ id: 'flex-1', name: '旧版', dataSourceId: 'ds-1', config: { dimension: 'month' }, chartType: 'bar' }) }],
        },
        { match: 'UPDATE flex_queries SET query_data', rows: [] },
        { match: 'INSERT INTO flex_query_versions', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await restore('1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, queryId: 'flex-1', version: 4, restoredFrom: 1 });
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO flex_query_versions'), expect.anything());
  });
});

describe('订阅端点（v0.9.77 P2-15）：创建 / 列表 / 更新 / 删除 / 立即执行 / 运行历史', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/flex-queries/flex-1/subscriptions').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/flex-queries/flex-1/subscriptions').send({ frequencyMinutes: 60 });
    expect(res.status).toBe(401);
  });

  it('创建：非 ADMIN/ANALYST 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/flex-queries/flex-1/subscriptions')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ frequencyMinutes: 60 });
    expect(res.status).toBe(403);
  });

  it('创建：周期越界 → 400 INVALID_INPUT', async () => {
    const res = await post({ frequencyMinutes: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toContain('执行周期');
  });

  it('创建：报表不存在 → 404', async () => {
    querySpy.mockImplementation(analystStub({ match: 'SELECT query_id FROM flex_queries WHERE query_id = ? LIMIT 1', rows: [] }));
    const res = await post({ frequencyMinutes: 60 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('固定报表不存在');
  });

  it('创建成功 → 201 返回 subscriptionId', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: 'SELECT query_id FROM flex_queries WHERE query_id = ? LIMIT 1', rows: () => [flexRow()] },
        { match: 'INSERT INTO flex_query_subscriptions', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await post({ frequencyMinutes: 60, alertMetric: 'total_sales', alertOp: '>', alertThreshold: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.subscriptionId).toMatch(/^sub-/);
  });

  it('列表 → 200 且行记录映射为 camelCase', async () => {
    querySpy.mockImplementation(
      analystStub({ match: 'SELECT * FROM flex_query_subscriptions WHERE query_id = ? ORDER BY created_at DESC', rows: () => [subRow()] }),
    );
    const res = await request(app).get('/api/flex-queries/flex-1/subscriptions').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions[0]).toMatchObject({
      subscriptionId: 'sub-1',
      queryId: 'flex-1',
      username: 'u5',
      frequencyMinutes: 60,
      alertMetric: 'total_sales',
      alertOp: '>',
      alertThreshold: 1000,
      status: 'ACTIVE',
    });
    expect(res.body.subscriptions[0].nextRunAt).toBe('2026-01-02T00:00:00.000Z');
    expect(res.body.subscriptions[0].lastRunAt).toBeNull();
  });

  it('更新：比较符非法 → 400', async () => {
    const res = await request(app)
      .put('/api/flex-queries/subscriptions/sub-1')
      .set('Authorization', `Bearer ${ANALYST_TOKEN}`)
      .send({ frequencyMinutes: 60, alertOp: '!=', alertThreshold: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('不支持的告警比较符');
  });

  it('更新：非本人非 ADMIN → 404 且落审计', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_SUB, rows: () => [subRow({ user_id: 9 })] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await request(app)
      .put('/api/flex-queries/subscriptions/sub-1')
      .set('Authorization', `Bearer ${ANALYST_TOKEN}`)
      .send({ frequencyMinutes: 60 });
    expect(res.status).toBe(404);
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO query_audit_log'), expect.anything());
  });

  it('更新：暂停 → 200（status=PAUSED 落库）', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_SUB, rows: () => [subRow({ user_id: 5 })] },
        { match: 'UPDATE flex_query_subscriptions SET frequency_minutes', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await request(app)
      .put('/api/flex-queries/subscriptions/sub-1')
      .set('Authorization', `Bearer ${ANALYST_TOKEN}`)
      .send({ frequencyMinutes: 120, alertMetric: '', alertOp: '>', alertThreshold: 0, status: 'PAUSED' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const updateCall = querySpy.mock.calls.find((c) => String(c[0]).includes('UPDATE flex_query_subscriptions SET frequency_minutes'));
    expect(String(updateCall?.[1])).toContain('PAUSED');
  });

  it('删除：非本人非 ADMIN → 404', async () => {
    querySpy.mockImplementation(
      analystStub({ match: SELECT_SUB, rows: () => [subRow({ user_id: 9 })] }, { match: 'INSERT INTO query_audit_log', rows: [] }),
    );
    const res = await request(app).delete('/api/flex-queries/subscriptions/sub-1').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('订阅不存在');
  });

  it('删除成功 → 200（级联运行历史）', async () => {
    querySpy.mockImplementation(
      analystStub(
        { match: SELECT_SUB, rows: () => [subRow({ user_id: 5 })] },
        { match: 'DELETE FROM flex_query_subscription_runs WHERE subscription_id = ?', rows: [] },
        { match: 'DELETE FROM flex_query_subscriptions WHERE subscription_id = ?', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    const res = await request(app).delete('/api/flex-queries/subscriptions/sub-1').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('立即执行：非本人非 ADMIN → 404', async () => {
    querySpy.mockImplementation(
      analystStub({ match: SELECT_SUB, rows: () => [subRow({ user_id: 9 })] }, { match: 'INSERT INTO query_audit_log', rows: [] }),
    );
    const res = await request(app).post('/api/flex-queries/subscriptions/sub-1/run').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('立即执行成功 → 200 返回执行结果（含告警判定）', async () => {
    querySpy.mockImplementation(
      analystStub({ match: SELECT_SUB, rows: () => [subRow({ user_id: 5 })] }, { match: 'INSERT INTO query_audit_log', rows: [] }),
    );
    vi.mocked(executeSubscription).mockResolvedValue({ status: 'ALERT', rowCount: 1, alertValue: '1200', message: '告警命中', durationMs: 5 });
    const res = await request(app).post('/api/flex-queries/subscriptions/sub-1/run').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ status: 'ALERT', alertValue: '1200' });
    expect(executeSubscription).toHaveBeenCalledWith('sub-1');
  });

  it('运行历史 → 200 且映射 camelCase', async () => {
    querySpy.mockImplementation(
      analystStub({
        match: 'SELECT status, row_count, alert_value, message, duration_ms, run_at FROM flex_query_subscription_runs WHERE subscription_id = ?',
        rows: () => [{ status: 'ALERT', row_count: 1, alert_value: '1200', message: '告警命中', duration_ms: 5, run_at: new Date('2026-01-02T00:00:00.000Z') }],
      }),
    );
    const res = await request(app).get('/api/flex-queries/subscriptions/sub-1/runs').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.runs[0]).toEqual({
      status: 'ALERT',
      rowCount: 1,
      alertValue: '1200',
      message: '告警命中',
      durationMs: 5,
      runAt: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('POST /api/flex-queries/:queryId/export-excel：Excel 导出（v0.9.77 P2-15）', () => {
  const exportExcel = () =>
    request(app).post('/api/flex-queries/flex-1/export-excel').set('Authorization', `Bearer ${ANALYST_TOKEN}`);

  it('无 token → 401', async () => {
    const res = await request(app).post('/api/flex-queries/flex-1/export-excel');
    expect(res.status).toBe(401);
  });

  it('报表不存在 → 404 NOT_FOUND（落 DENIED_INPUT 审计）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'INSERT INTO query_audit_log', rows: [] }));
    vi.mocked(runSavedFlexQuery).mockResolvedValue({ ok: false, error: '固定报表不存在', notFound: true });
    const res = await exportExcel();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO query_audit_log'), expect.anything());
  });

  it('重放失败 → 422 INVALID_INPUT（如数据源停用）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'INSERT INTO query_audit_log', rows: [] }));
    vi.mocked(runSavedFlexQuery).mockResolvedValue({ ok: false, error: '该数据源已被管理员停用' });
    const res = await exportExcel();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('该数据源已被管理员停用');
  });

  it('导出成功 → 200（XLSX 响应头 + 非空 Buffer + 审计）', async () => {
    querySpy.mockImplementation(analystStub({ match: 'INSERT INTO query_audit_log', rows: [] }));
    vi.mocked(runSavedFlexQuery).mockResolvedValue({
      ok: true,
      data: {
        columns: ['month', 'total'],
        rows: [{ month: '1月', total: 120 }],
        rowCount: 1,
        truncated: false,
        name: '月度投放报表',
        dataSourceId: 'ds-1',
      },
    });
    const res = await exportExcel();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('月度投放报表'));
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(runSavedFlexQuery).toHaveBeenCalledWith('flex-1', { scenario: 'export' });
  });
});

describe('buildFlexExportFilename / buildFlexQueryExcel：导出构建（纯函数）', () => {
  it('文件名：报表名 + 时间戳，非法字符替换为下划线', () => {
    const d = new Date(2026, 0, 5, 8, 30);
    expect(buildFlexExportFilename('月度报表', d)).toBe('月度报表-20260105-0830.xlsx');
    expect(buildFlexExportFilename('季度/报表:测试*?', d)).toBe('季度_报表_测试__-20260105-0830.xlsx');
    expect(buildFlexExportFilename('', d)).toBe('灵活查询-20260105-0830.xlsx');
  });

  it('Excel：正常数据生成 XLSX（PK 魔数）', async () => {
    const buf = await buildFlexQueryExcel({ title: 't', columns: ['a', 'b'], rows: [{ a: 1, b: 'x' }], exportedBy: 'u5' });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('Excel：空结果集仍可生成（占位行）', async () => {
    const buf = await buildFlexQueryExcel({ title: 't', columns: [], rows: [] });
    expect(buf.length).toBeGreaterThan(0);
  });
});
