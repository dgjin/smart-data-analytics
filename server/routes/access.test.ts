/**
 * v0.9.107 访问计数路由契约测试：
 * 新会话计 1 次访问 / 同会话重复 visit 不重复计 + 模块 hits 累加 + 匿名可调 +
 * 非法 sessionId 400（不落库）+ ping 补建会话（不重复计访问）+ public-stats 三指标 +
 * 管理端 /stats 仅 ADMIN（无 token 401 / VIEWER 403 / ADMIN 含模块热度与占比）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import accessRoutes from './access';
import accessAdminRoutes from './accessAdmin';

applyTestEnv();

const app = buildApp('/api/access', accessRoutes);
const adminApp = buildApp('/api/admin/access', accessAdminRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);
/** 32 位、符合 [A-Za-z0-9_-]{16,64} */
const SESSION_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

/** INSERT/UPDATE/DELETE 的 ResultSetHeader 语义返回（dbStub 原样透传行集，用「带属性的数组」冒充） */
const affected = (rows: number) => Object.assign([] as unknown[], { affectedRows: rows });

/** access_sessions 首次出现（新会话）或已存在（重复访问） */
const sessionInsert = (rows: number): DbStubRule => ({ match: 'INSERT IGNORE INTO access_sessions', rows: () => affected(rows) });
const sessionTouch = (rows: number): DbStubRule => ({ match: 'UPDATE access_sessions', rows: () => affected(rows) });
const dailyIncrement: DbStubRule = { match: 'INSERT INTO access_daily', rows: [] };
const moduleIncrement: DbStubRule = { match: 'INSERT INTO access_module_daily', rows: [] };
const publicStatsRow: DbStubRule = {
  match: 'total_visits',
  rows: () => [{ total_visits: '128', today_visits: 6, online: '3' }],
};
const moduleStatsRows: DbStubRule = {
  match: 'FROM access_module_daily',
  rows: () => [
    { module: 'query', hits: '30' },
    { module: 'reports', hits: '10' },
  ],
};

const sqls = () => querySpy.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  querySpy.mockReset();
});

describe('POST /api/access/visit', () => {
  it('新会话计 1 次访问并累加模块热度', async () => {
    querySpy.mockImplementation(dbStub([sessionInsert(1), dailyIncrement, moduleIncrement]));

    const res = await request(app).post('/api/access/visit').send({ sessionId: SESSION_ID, module: 'query' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const executed = sqls();
    expect(executed.some((sql) => sql.includes('INSERT INTO access_daily'))).toBe(true);
    expect(executed.some((sql) => sql.includes('INSERT INTO access_module_daily'))).toBe(true);
    // 模块 key 归一化后入库
    const moduleCall = querySpy.mock.calls.find((call) => String(call[0]).includes('access_module_daily'));
    expect(moduleCall?.[1]).toEqual(['query']);
  });

  it('同会话重复访问不重复计累计，仅刷新活跃时间与模块热度', async () => {
    querySpy.mockImplementation(dbStub([sessionInsert(0), sessionTouch(0), moduleIncrement]));

    const res = await request(app).post('/api/access/visit').send({ sessionId: SESSION_ID, module: 'dashboard' });

    expect(res.status).toBe(200);
    const executed = sqls();
    expect(executed.some((sql) => sql.includes('INSERT INTO access_daily'))).toBe(false);
    expect(executed.some((sql) => sql.includes('UPDATE access_sessions'))).toBe(true);
    expect(executed.some((sql) => sql.includes('INSERT INTO access_module_daily'))).toBe(true);
  });

  it('登录用户上报时标记已登录会话', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, sessionInsert(1), dailyIncrement]));

    const res = await request(app)
      .post('/api/access/visit')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    const dailyCall = querySpy.mock.calls.find((call) => String(call[0]).includes('INSERT INTO access_daily'));
    expect(dailyCall?.[1]).toEqual([1, 1]);
  });

  it('非法 sessionId 返回 400 且不落库', async () => {
    querySpy.mockImplementation(dbStub([sessionInsert(1)]));

    const res = await request(app).post('/api/access/visit').send({ sessionId: 'bad id!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sessionId');
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/access/ping', () => {
  it('已存在会话只刷新 last_seen，不重复计访问', async () => {
    querySpy.mockImplementation(dbStub([sessionTouch(1)]));

    const res = await request(app).post('/api/access/ping').send({ sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    const executed = sqls();
    expect(executed.some((sql) => sql.includes('INSERT IGNORE INTO access_sessions'))).toBe(false);
    expect(executed.some((sql) => sql.includes('INSERT INTO access_daily'))).toBe(false);
  });

  it('会话不存在时静默补建，仍不写日聚合', async () => {
    querySpy.mockImplementation(
      dbStub([
        sessionTouch(0),
        { match: 'INSERT IGNORE INTO access_sessions', rows: () => affected(1) },
      ])
    );

    const res = await request(app).post('/api/access/ping').send({ sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(sqls().some((sql) => sql.includes('INSERT IGNORE INTO access_sessions'))).toBe(true);
    expect(sqls().some((sql) => sql.includes('INSERT INTO access_daily'))).toBe(false);
  });

  it('非法 sessionId 返回 400', async () => {
    const res = await request(app).post('/api/access/ping').send({ sessionId: 'short' });
    expect(res.status).toBe(400);
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/access/public-stats', () => {
  it('公开可访问并返回累计/今日/在线三指标', async () => {
    querySpy.mockImplementation(dbStub([publicStatsRow]));

    const res = await request(app).get('/api/access/public-stats');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalVisits).toBe(128);
    expect(res.body.todayVisits).toBe(6);
    expect(res.body.online).toBe(3);
    expect(typeof res.body.updatedAt).toBe('string');
  });

  it('查询失败返回 500', async () => {
    querySpy.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/access/public-stats');

    expect(res.status).toBe(500);
  });
});

describe('GET /api/admin/access/stats', () => {
  it('无 token 返回 401', async () => {
    const res = await request(adminApp).get('/api/admin/access/stats');
    expect(res.status).toBe(401);
  });

  it('非 ADMIN 返回 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));

    const res = await request(adminApp).get('/api/admin/access/stats').set('Authorization', `Bearer ${VIEWER_TOKEN}`);

    expect(res.status).toBe(403);
  });

  it('ADMIN 返回计数器与模块热度排行（含占比）', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, publicStatsRow, moduleStatsRows]));

    const res = await request(adminApp)
      .get('/api/admin/access/stats?days=7')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.totalVisits).toBe(128);
    expect(res.body.modules).toEqual([
      { module: 'query', hits: 30, share: 75 },
      { module: 'reports', hits: 10, share: 25 },
    ]);
  });
});
