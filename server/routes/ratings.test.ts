/**
 * v0.9.107 评价路由契约测试：
 * 问数评分角色放行（VIEWER 403 / ANALYST 成功）+ 参数强校验（评分越界/标签超限/文字超长）+
 * dedupe_key 幂等（二次提交走 ON DUPLICATE KEY UPDATE）+ 全站满意度 24h 内更新 +
 * 概览聚合（好评率/NPS/趋势/标签）+ 明细分页筛选 + CSV 导出（BOM + 表头 + 审计）+ 管理端点仅 ADMIN。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import ratingsRoutes from './ratings';
import ratingsAdminRoutes from './ratingsAdmin';

applyTestEnv();

const app = buildApp('/api/ratings', ratingsRoutes);
const adminApp = buildApp('/api/admin/ratings', ratingsAdminRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const ANALYST_TOKEN = tokenFor('ANALYST', 2);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const analystAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 2)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };
const auditInsert: DbStubRule = { match: 'INSERT INTO query_audit_log', rows: [] };

const sqls = () => querySpy.mock.calls.map((call) => String(call[0]));

/** 今日日期（与 ratings.ts 的 recentDates 同口径） */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const queryItemRow = (over: Record<string, unknown> = {}) => ({
  source: 'query',
  id: 12,
  username: 'u1',
  rating: 5,
  tags: '准确,快速',
  comment: '口径正确',
  question: '本月销售额',
  created_at: '2026-10-08 10:00:00',
  ...over,
});

const appItemRow = (over: Record<string, unknown> = {}) => ({
  source: 'app',
  id: 8,
  username: 'u2',
  rating: 4,
  tags: '稳定',
  comment: '整体不错',
  question: '',
  created_at: '2026-10-09 11:00:00',
  ...over,
});

/** 概览 6 条聚合查询的桩（顺序无关，靠 SQL 特征分派） */
const overviewRules: DbStubRule[] = [
  { match: /FROM query_ratings[\s\S]*GROUP BY d/, rows: () => [{ d: today(), cnt: 2, avg_rating: 4.5 }] },
  { match: /FROM app_satisfaction[\s\S]*GROUP BY d/, rows: () => [] },
  { match: 'SELECT tags FROM query_ratings', rows: () => [{ tags: '准确,快速' }, { tags: '准确' }] },
  { match: 'SELECT tags FROM app_satisfaction', rows: () => [{ tags: '稳定' }] },
  {
    match: 'SUM(rating >= 4)',
    rows: () => [{ cnt: '4', avg_rating: '4.25', good: '3', low: '1', promoters: 0, detractors: 0 }],
  },
  {
    match: 'SUM(rating = 5)',
    rows: () => [{ cnt: '5', avg_rating: '4', good: 0, low: '1', promoters: '3', detractors: '1' }],
  },
];

beforeEach(() => {
  querySpy.mockReset();
});

describe('POST /api/ratings/query', () => {
  const body = {
    dataSourceId: 'ds-1',
    question: '本月销售额是多少',
    sql: 'SELECT 1',
    traceId: 'trace-1',
    rating: 5,
    tags: ['准确', '快速'],
    comment: '口径正确',
  };

  it('VIEWER 无权提交问数评价（403）', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));

    const res = await request(app).post('/api/ratings/query').set('Authorization', `Bearer ${VIEWER_TOKEN}`).send(body);

    expect(res.status).toBe(403);
    expect(sqls().some((sql) => sql.includes('INSERT INTO query_ratings'))).toBe(false);
  });

  it('ANALYST 提交成功并落库', async () => {
    querySpy.mockImplementation(dbStub([analystAuth, { match: 'INSERT INTO query_ratings', rows: [] }]));

    const res = await request(app).post('/api/ratings/query').set('Authorization', `Bearer ${ANALYST_TOKEN}`).send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const insert = querySpy.mock.calls.find((call) => String(call[0]).includes('INSERT INTO query_ratings'));
    expect(String(insert?.[0])).toContain('ON DUPLICATE KEY UPDATE');
    // dedupe_key + user_id + username + data_source_id + question + sql + traceId + rating
    expect((insert?.[1] as unknown[])[1]).toBe(2);
    expect((insert?.[1] as unknown[])[7]).toBe(5);
  });

  it('评分越界返回 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));

    const res = await request(app)
      .post('/api/ratings/query')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ...body, rating: 6 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('1-5');
  });

  it('标签超过 3 个返回 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));

    const res = await request(app)
      .post('/api/ratings/query')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ...body, tags: ['a', 'b', 'c', 'd'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('标签');
  });

  it('评价文字超过 200 字返回 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));

    const res = await request(app)
      .post('/api/ratings/query')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ...body, comment: '长'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('200');
  });

  it('缺少问题内容返回 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));

    const res = await request(app)
      .post('/api/ratings/query')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ...body, question: '  ' });

    expect(res.status).toBe(400);
  });

  it('同用户同数据源同问题二次提交为更新（同一 dedupe_key）', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'INSERT INTO query_ratings', rows: [] }]));

    await request(app).post('/api/ratings/query').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);
    await request(app)
      .post('/api/ratings/query')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ...body, rating: 3, comment: '改判' });

    const inserts = querySpy.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO query_ratings'));
    expect(inserts).toHaveLength(2);
    const keys = inserts.map((call) => (call[1] as unknown[])[0]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    // 二次提交的评分写入 UPDATE 段
    expect((inserts[1][1] as unknown[])[10]).toBe(3);
  });
});

describe('POST /api/ratings/app', () => {
  it('VIEWER 也可提交全站满意度', async () => {
    querySpy.mockImplementation(
      dbStub([viewerAuth, { match: 'SELECT id FROM app_satisfaction', rows: () => [] }, { match: 'INSERT INTO app_satisfaction', rows: [] }])
    );

    const res = await request(app)
      .post('/api/ratings/app')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ page: 'query', rating: 4, tags: ['稳定'], comment: '整体不错' });

    expect(res.status).toBe(200);
    expect(sqls().some((sql) => sql.includes('INSERT INTO app_satisfaction'))).toBe(true);
  });

  it('24 小时内已有记录则更新最近一条而非新增', async () => {
    querySpy.mockImplementation(
      dbStub([
        analystAuth,
        { match: 'SELECT id FROM app_satisfaction', rows: () => [{ id: 7 }] },
        { match: 'UPDATE app_satisfaction', rows: [] },
        { match: 'INSERT INTO app_satisfaction', rows: [] },
      ])
    );

    const res = await request(app)
      .post('/api/ratings/app')
      .set('Authorization', `Bearer ${ANALYST_TOKEN}`)
      .send({ rating: 2, tags: ['加载慢'] });

    expect(res.status).toBe(200);
    const executed = sqls();
    expect(executed.some((sql) => sql.includes('UPDATE app_satisfaction'))).toBe(true);
    expect(executed.some((sql) => sql.includes('INSERT INTO app_satisfaction'))).toBe(false);
    const updateCall = querySpy.mock.calls.find((call) => String(call[0]).includes('UPDATE app_satisfaction'));
    expect((updateCall?.[1] as unknown[])[4]).toBe(7);
  });

  it('未登录返回 401', async () => {
    const res = await request(app).post('/api/ratings/app').send({ rating: 5 });
    expect(res.status).toBe(401);
  });

  it('评分缺失返回 400', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));

    const res = await request(app).post('/api/ratings/app').set('Authorization', `Bearer ${VIEWER_TOKEN}`).send({});

    expect(res.status).toBe(400);
  });
});

describe('GET /api/ratings/mine', () => {
  it('返回当前用户最近一次全站满意度', async () => {
    querySpy.mockImplementation(dbStub([analystAuth, { match: "'app' AS source", rows: () => [appItemRow()] }]));

    const res = await request(app).get('/api/ratings/mine').set('Authorization', `Bearer ${ANALYST_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.rating).toEqual({ rating: 4, tags: ['稳定'], comment: '整体不错', createdAt: '2026-10-09 11:00:00' });
  });

  it('无评价时返回 null', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth, { match: "'app' AS source", rows: () => [] }]));

    const res = await request(app).get('/api/ratings/mine').set('Authorization', `Bearer ${VIEWER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.rating).toBeNull();
  });
});

describe('GET /api/admin/ratings/overview', () => {
  it('非 ADMIN 返回 403，未登录返回 401', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));

    const denied = await request(adminApp).get('/api/admin/ratings/overview').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    const anonymous = await request(adminApp).get('/api/admin/ratings/overview');

    expect(denied.status).toBe(403);
    expect(anonymous.status).toBe(401);
  });

  it('返回两套指标 + 趋势补全 + 标签计数', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, ...overviewRules]));

    const res = await request(adminApp)
      .get('/api/admin/ratings/overview?days=7')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ count: 4, avg: 4.25, goodRate: 0.75, lowCount: 1 });
    // NPS = (promoters 3 - detractors 1) / 5 * 100
    expect(res.body.app).toEqual({ count: 5, avg: 4, nps: 40, lowCount: 1 });
    expect(res.body.trend).toHaveLength(7);
    expect(res.body.trend[6]).toEqual({ date: today(), queryAvg: 4.5, queryCount: 2, appAvg: null, appCount: 0 });
    expect(res.body.tags.query).toEqual([
      { tag: '准确', count: 2 },
      { tag: '快速', count: 1 },
    ]);
    expect(res.body.tags.app).toEqual([{ tag: '稳定', count: 1 }]);
  });
});

describe('GET /api/admin/ratings/items', () => {
  it('按来源筛选并分页（问数单来源不并入全站）', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: "SELECT 'query' AS source", rows: () => [queryItemRow()] },
        { match: 'SELECT COUNT(*) AS cnt FROM (', rows: () => [{ cnt: '21' }] },
      ])
    );

    const res = await request(adminApp)
      .get('/api/admin/ratings/items?source=query&minRating=4&days=30&page=2&pageSize=5')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(21);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(5);
    expect(res.body.items[0]).toMatchObject({ source: 'query', rating: 5, tags: ['准确', '快速'], question: '本月销售额' });

    const unionCall = querySpy.mock.calls.find((call) => String(call[0]).includes("SELECT 'query' AS source"));
    expect(String(unionCall?.[0])).not.toContain('app_satisfaction');
    // days + minRating + LIMIT/OFFSET
    expect(unionCall?.[1]).toEqual([30, 4, 5, 5]);
  });

  it('默认时间范围 30 天、每页 20 条', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: "SELECT 'query' AS source", rows: () => [queryItemRow(), appItemRow()] },
        { match: 'SELECT COUNT(*) AS cnt FROM (', rows: () => [{ cnt: '2' }] },
      ])
    );

    const res = await request(adminApp).get('/api/admin/ratings/items').set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.items).toHaveLength(2);
    const unionCall = querySpy.mock.calls.find((call) => String(call[0]).includes("SELECT 'query' AS source"));
    expect(String(unionCall?.[0])).toContain('UNION ALL');
  });
});

describe('GET /api/admin/ratings/export', () => {
  it('导出 CSV：UTF-8 BOM + 表头 + 审计留痕', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: "SELECT 'query' AS source", rows: () => [queryItemRow(), appItemRow()] },
        { match: 'SELECT COUNT(*) AS cnt FROM (', rows: () => [{ cnt: '2' }] },
        auditInsert,
      ])
    );

    const res = await request(adminApp)
      .get('/api/admin/ratings/export?source=all&days=7')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('ratings-');
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    expect(res.text).toContain('"来源","用户","评分","标签","评价内容","关联问题","时间"');
    expect(res.text).toContain('"问数评价"');
    expect(res.text).toContain('"全站满意度"');
    expect(sqls().some((sql) => sql.includes('INSERT INTO query_audit_log'))).toBe(true);
  });
});
