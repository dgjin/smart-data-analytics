/**
 * v0.9.98 需求收集与意见反馈路由契约测试：
 * 提交校验（kind/title/content）与角色放行 + 管理列表/摘要（ADMIN）+
 * 评估动作（BASELINE 必填评估意见 / REJECT / PENDING 退回）+ 删除留痕 +
 * 标准导出接口（OPS_API_TOKEN 双通道、默认仅基线、since 增量、limit 限幅）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import requirementsRoutes from './requirements';

applyTestEnv();

const app = buildApp('/api/requirements', requirementsRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };
const auditInsert: DbStubRule = { match: 'INSERT INTO query_audit_log', rows: [] };

/** INSERT/UPDATE/DELETE 的 ResultSetHeader 语义返回（dbStub 原样透传行集，用「带属性的数组」冒充） */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

const stub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/** feedback_entries 行（列名与路由 SELECT 对齐） */
const entryRow = (over: Record<string, unknown> = {}) => ({
  id: 3,
  kind: 'REQUIREMENT',
  title: '支持导出 Excel 图表',
  content: '希望报告图表可以直接导出为 Excel。',
  status: 'PENDING',
  priority: '',
  baseline_version: '',
  assessment: null,
  user_id: 9,
  username: 'u9',
  department: '测试部',
  reviewer: '',
  reviewed_at: null,
  created_at: new Date('2026-10-07T02:00:00Z'),
  updated_at: new Date('2026-10-07T02:00:00Z'),
  ...over,
});

beforeEach(() => {
  querySpy.mockReset();
  delete process.env.OPS_API_TOKEN;
  querySpy.mockImplementation(stub());
});

afterEach(() => {
  delete process.env.OPS_API_TOKEN;
});

describe('POST /：提交与校验', () => {
  it('无 token → 401', async () => {
    const res = await request(app).post('/api/requirements').send({ title: 't', content: 'c' });
    expect(res.status).toBe(401);
  });

  it('VIEWER 可提交 → 201（INSERT 落库）', async () => {
    querySpy.mockImplementation(
      dbStub([viewerAuth, { match: 'INSERT INTO feedback_entries', rows: resultSet({ insertId: 11 }) }])
    );
    const res = await request(app)
      .post('/api/requirements')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ kind: 'BUG', title: '导出按钮无响应', content: '点击导出无任何反馈' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, id: 11 });
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO feedback_entries'));
    expect(call).toBeTruthy();
    expect((call![1] as unknown[])[0]).toBe('BUG');
  });

  it('kind 非法 → 400', async () => {
    const res = await request(app)
      .post('/api/requirements')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ kind: 'HACK', title: 't', content: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('类型无效');
  });

  it('title/content 为空 → 400', async () => {
    const missTitle = await request(app)
      .post('/api/requirements')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ content: 'c' });
    expect(missTitle.status).toBe(400);
    const missContent = await request(app)
      .post('/api/requirements')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ title: 't' });
    expect(missContent.status).toBe(400);
  });
});

describe('GET /mine 与管理列表', () => {
  it('mine 返回本人条目', async () => {
    querySpy.mockImplementation(
      dbStub([viewerAuth, { match: 'FROM feedback_entries WHERE user_id', rows: () => [entryRow()] }])
    );
    const res = await request(app).get('/api/requirements/mine').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ id: 3, submitter: 'u9', status: 'PENDING' });
  });

  it('管理列表：VIEWER → 403；ADMIN 过滤条件进 SQL', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const denied = await request(app).get('/api/requirements').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(denied.status).toBe(403);

    querySpy.mockImplementation(stub({ match: 'FROM feedback_entries', rows: () => [entryRow()] }));
    const res = await request(app)
      .get('/api/requirements?status=baselined&kind=requirement')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM feedback_entries'));
    expect(String(call![0])).toContain('status = ?');
    expect(String(call![0])).toContain('kind = ?');
  });

  it('摘要：按状态/类型/优先级分组计数', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'GROUP BY status', rows: () => [{ status: 'PENDING', cnt: 2 }] },
        { match: 'GROUP BY kind', rows: () => [{ kind: 'REQUIREMENT', cnt: 2 }] },
        { match: 'GROUP BY priority', rows: () => [{ priority: 'P1', cnt: 1 }] }
      )
    );
    const res = await request(app).get('/api/requirements/summary').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual([{ status: 'PENDING', cnt: 2 }]);
    expect(res.body.byPriority[0].priority).toBe('P1');
  });
});

describe('POST /:id/review：评估动作', () => {
  it('VIEWER → 403；action 非法 → 400', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const denied = await request(app)
      .post('/api/requirements/3/review')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`)
      .send({ action: 'BASELINE' });
    expect(denied.status).toBe(403);

    querySpy.mockImplementation(stub());
    const bad = await request(app)
      .post('/api/requirements/3/review')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'MAYBE' });
    expect(bad.status).toBe(400);
  });

  it('BASELINE 缺评估意见 → 400', async () => {
    const res = await request(app)
      .post('/api/requirements/3/review')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'BASELINE', priority: 'P1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('评估分析意见');
  });

  it('BASELINE 成功 → 200 + UPDATE 基线字段 + 审计留痕', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT id, title, status FROM feedback_entries', rows: () => [entryRow()] },
        { match: 'UPDATE feedback_entries', rows: resultSet({ affectedRows: 1 }) },
        auditInsert
      )
    );
    const res = await request(app)
      .post('/api/requirements/3/review')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'BASELINE', priority: 'P1', baselineVersion: 'v0.9.99', assessment: '价值高、成本低，排入下版' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, id: 3, status: 'BASELINED' });
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('UPDATE feedback_entries'));
    expect(String(call![0])).toContain("status = 'BASELINED'");
    expect((call![1] as unknown[])[0]).toBe('P1');
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('INSERT INTO query_audit_log'))).toBe(true);
  });

  it('PENDING 退回清空决策字段', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT id, title, status FROM feedback_entries', rows: () => [entryRow({ status: 'BASELINED' })] },
        { match: 'UPDATE feedback_entries', rows: resultSet({ affectedRows: 1 }) },
        auditInsert
      )
    );
    const res = await request(app)
      .post('/api/requirements/3/review')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'PENDING' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('UPDATE feedback_entries'));
    expect(String(call![0])).toContain("reviewer = ''");
  });

  it('条目不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT id, title, status FROM feedback_entries', rows: () => [] }));
    const res = await request(app)
      .post('/api/requirements/999/review')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'REJECT' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /:id', () => {
  it('删除成功并写审计', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT title FROM feedback_entries', rows: () => [{ title: '支持导出 Excel 图表' }] },
        { match: 'DELETE FROM feedback_entries', rows: resultSet({ affectedRows: 1 }) },
        auditInsert
      )
    );
    const res = await request(app).delete('/api/requirements/3').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('INSERT INTO query_audit_log'))).toBe(true);
  });
});

describe('GET /export：标准导出接口（AIOps 拉取）', () => {
  it('无凭据 → 401', async () => {
    const res = await request(app).get('/api/requirements/export');
    expect(res.status).toBe(401);
  });

  it('OPS_API_TOKEN → 200：默认仅基线且不触碰 users 表', async () => {
    process.env.OPS_API_TOKEN = 'req-secret';
    querySpy.mockImplementation(
      dbStub([
        {
          match: 'FROM feedback_entries',
          rows: () => [entryRow({ status: 'BASELINED', priority: 'P1', baseline_version: 'v0.9.98' })],
        },
      ])
    );
    const res = await request(app).get('/api/requirements/export').set('Authorization', 'Bearer req-secret');
    expect(res.status).toBe(200);
    expect(res.body.spec_version).toBe('1.0');
    expect(res.body.returned).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ status: 'BASELINED', priority: 'P1', baselineVersion: 'v0.9.98' });
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM feedback_entries'));
    expect(String(call![0])).toContain('status = ?');
    expect((call![1] as unknown[])[0]).toBe('BASELINED');
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('FROM users'))).toBe(false);
  });

  it('status=ALL 不带状态条件；limit 限幅到 500；since 进 SQL', async () => {
    process.env.OPS_API_TOKEN = 'req-secret';
    querySpy.mockImplementation(dbStub([{ match: 'FROM feedback_entries', rows: () => [] }]));
    const res = await request(app)
      .get('/api/requirements/export?status=ALL&since=2026-10-07&limit=9999')
      .set('Authorization', 'Bearer req-secret');
    expect(res.status).toBe(200);
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM feedback_entries'));
    const sql = String(call![0]);
    expect(sql).not.toContain('status = ?');
    expect(sql).toContain('updated_at >= ?');
    const params = call![1] as unknown[];
    expect(params[params.length - 1]).toBe(500);
  });

  it('since 非法 → 400（不触库）', async () => {
    process.env.OPS_API_TOKEN = 'req-secret';
    const res = await request(app)
      .get('/api/requirements/export?since=not-a-date')
      .set('Authorization', 'Bearer req-secret');
    expect(res.status).toBe(400);
    expect(querySpy.mock.calls.length).toBe(0);
  });

  it('VIEWER JWT → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).get('/api/requirements/export').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});
