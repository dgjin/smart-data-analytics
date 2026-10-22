/**
 * v0.9.114 /api/access-requests 路由契约测试（P0-2 zod 渐进示范）：
 * 覆盖 zod 输入校验（400）、鉴权、审批决策路径。DB 走 routeTestKit.dbStub。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
// 授权/审批涉及的 accessControl 与限流/状态存储打桩，聚焦输入契约
vi.mock('../auth/accessControl', () => ({
  checkDataSourceAccess: vi.fn(async () => false),
  grantUserAccess: vi.fn(async () => undefined),
}));
vi.mock('../infra/rateLimiter', () => ({ rateLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }));

import accessRequestsRoutes from './accessRequests';

applyTestEnv();
const app = buildApp('/api/access-requests', accessRequestsRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

beforeEach(() => {
  querySpy.mockReset();
});

describe('POST /api/access-requests zod 校验', () => {
  it('缺 reason 返回 400（zod 判空）', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/access-requests')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ dataSourceId: 'ds1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('reason 全空白返回 400', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/access-requests')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ dataSourceId: 'ds1', reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('请填写申请理由');
  });

  it('缺 dataSourceId 返回 400', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/access-requests')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ reason: '需要分析' });
    expect(res.status).toBe(400);
  });

  it('合法申请创建成功（reason 超长截断至 500）', async () => {
    querySpy.mockImplementation(dbStub([
      viewerAuth,
      { match: 'SELECT id FROM data_sources WHERE id', rows: () => [{ id: 'ds1' }] },
      { match: "FROM permission_requests WHERE user_id", rows: () => [] },
      { match: 'INSERT INTO permission_requests', rows: () => resultSet({ insertId: 42 }) },
    ]));
    const res = await request(app)
      .post('/api/access-requests')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ dataSourceId: 'ds1', reason: 'r'.repeat(600) });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    // 验证落库 reason 被截断至 500
    const insertCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO permission_requests'));
    expect(insertCall).toBeTruthy();
    const reasonParam = (insertCall![1] as unknown[])[4] as string;
    expect(reasonParam).toHaveLength(500);
  });

  it('未登录返回 401', async () => {
    const res = await request(app).post('/api/access-requests').send({ dataSourceId: 'ds1', reason: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('POST /:id/approve|reject zod 校验', () => {
  it('非法申请 ID 返回 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));
    const res = await request(app)
      .post('/api/access-requests/abc/approve')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('申请 ID 无效');
  });

  it('note 超长截断至 300（不拒绝）', async () => {
    querySpy.mockImplementation(dbStub([
      adminAuth,
      { match: 'SELECT * FROM permission_requests WHERE id', rows: () => [{ id: 5, user_id: 9, data_source_id: 'ds1', status: 'PENDING' }] },
      { match: 'UPDATE permission_requests SET status', rows: () => resultSet({ affectedRows: 1 }) },
    ]));
    const res = await request(app)
      .post('/api/access-requests/5/reject')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ note: 'n'.repeat(400) });
    expect(res.status).toBe(200);
    const updCall = querySpy.mock.calls.find((c) => String(c[0]).includes('UPDATE permission_requests'));
    const noteParam = (updCall![1] as unknown[])[2] as string;
    expect(noteParam).toHaveLength(300);
  });

  it('VIEWER 审批返回 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app)
      .post('/api/access-requests/5/approve')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({});
    expect(res.status).toBe(403);
  });
});
