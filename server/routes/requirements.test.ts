/**
 * v0.9.98 需求收集与意见反馈路由契约测试：
 * 提交校验（kind/title/content）与角色放行 + 管理列表/摘要（ADMIN）+
 * 评估动作（BASELINE 必填评估意见 / REJECT / PENDING 退回 / 继续评估追加历史）+ 删除留痕 +
 * 标准导出接口（OPS_API_TOKEN 双通道、默认仅基线、since 增量、limit 限幅、条目附 revisions）。
 * v0.9.105 智能运维处理进度代理：配置开关/归属过滤/拉取归集/成功缓存/上游失败降级。
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

/** feedback_entry_revisions 行（列名与路由 SELECT 对齐；v0.9.102 评估历史） */
const revRow = (over: Record<string, unknown> = {}) => ({
  id: 21,
  entry_id: 3,
  action: 'BASELINE',
  priority: 'P1',
  baseline_version: 'v0.9.99',
  assessment: '价值高、成本低，排入下版',
  reviewer: 'admin',
  created_at: new Date('2026-10-08T03:00:00Z'),
  ...over,
});

beforeEach(() => {
  querySpy.mockReset();
  delete process.env.OPS_API_TOKEN;
  delete process.env.AIOPS_TRACK_URL;
  delete process.env.AIOPS_TRACK_TOKEN;
  querySpy.mockImplementation(stub());
});

afterEach(() => {
  delete process.env.OPS_API_TOKEN;
  delete process.env.AIOPS_TRACK_URL;
  delete process.env.AIOPS_TRACK_TOKEN;
  vi.unstubAllGlobals();
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

    querySpy.mockImplementation(
      stub(
        { match: 'FROM feedback_entries', rows: () => [entryRow({ status: 'BASELINED' })] },
        { match: 'FROM feedback_entry_revisions', rows: () => [revRow()] }
      )
    );
    const res = await request(app)
      .get('/api/requirements?status=baselined&kind=requirement')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM feedback_entries'));
    expect(String(call![0])).toContain('status = ?');
    expect(String(call![0])).toContain('kind = ?');
    // v0.9.102 管理列表附带评估历史（展开行时间线）
    expect(res.body.entries[0].revisions).toHaveLength(1);
    expect(res.body.entries[0].revisions[0]).toMatchObject({ action: 'BASELINE', reviewer: 'admin' });
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

  it('BASELINE 成功 → 200 + UPDATE 基线字段 + 评估历史 + 审计留痕', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT id, title, status FROM feedback_entries', rows: () => [entryRow()] },
        { match: 'UPDATE feedback_entries', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO feedback_entry_revisions', rows: resultSet({ insertId: 1 }) },
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
    // v0.9.102 评估历史落库（继续评估的新内容供 AIOps 获取）
    const revCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO feedback_entry_revisions'));
    expect(revCall).toBeTruthy();
    expect(revCall![1]).toEqual([3, 'BASELINE', 'P1', 'v0.9.99', '价值高、成本低，排入下版', 'u1']);
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('INSERT INTO query_audit_log'))).toBe(true);
  });

  it('已纳入基线条目可继续评估（二次 BASELINE）→ 追加评估历史且状态保持', async () => {
    querySpy.mockImplementation(
      stub(
        {
          match: 'SELECT id, title, status FROM feedback_entries',
          rows: () => [entryRow({ status: 'BASELINED', reviewer: 'admin', reviewed_at: new Date('2026-10-08T02:00:00Z') })],
        },
        { match: 'UPDATE feedback_entries', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO feedback_entry_revisions', rows: resultSet({ insertId: 2 }) },
        auditInsert
      )
    );
    const res = await request(app)
      .post('/api/requirements/3/review')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'BASELINE', priority: 'P2', assessment: '补充：验收口径已确认' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'BASELINED' });
    const revCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO feedback_entry_revisions'));
    expect(revCall![1]).toEqual([3, 'BASELINE', 'P2', '', '补充：验收口径已确认', 'u1']);
  });

  it('PENDING 退回清空决策字段（仍记评估历史）', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT id, title, status FROM feedback_entries', rows: () => [entryRow({ status: 'BASELINED' })] },
        { match: 'UPDATE feedback_entries', rows: resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO feedback_entry_revisions', rows: resultSet({ insertId: 3 }) },
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
    const revCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO feedback_entry_revisions'));
    expect(revCall![1]).toEqual([3, 'PENDING', '', '', '', 'u1']);
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

  it('OPS_API_TOKEN → 200：默认仅基线且不触碰 users 表，条目附评估历史', async () => {
    process.env.OPS_API_TOKEN = 'req-secret';
    querySpy.mockImplementation(
      dbStub([
        {
          match: 'FROM feedback_entries',
          rows: () => [entryRow({ status: 'BASELINED', priority: 'P1', baseline_version: 'v0.9.98' })],
        },
        {
          match: 'FROM feedback_entry_revisions',
          rows: () => [
            revRow(),
            revRow({ id: 22, assessment: '二次评估：补充验收口径', created_at: new Date('2026-10-09T03:00:00Z') }),
          ],
        },
      ])
    );
    const res = await request(app).get('/api/requirements/export').set('Authorization', 'Bearer req-secret');
    expect(res.status).toBe(200);
    expect(res.body.spec_version).toBe('1.0');
    expect(res.body.returned).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ status: 'BASELINED', priority: 'P1', baselineVersion: 'v0.9.98' });
    // v0.9.102 继续评估产生的新内容经 revisions 提供给 AIOps
    expect(res.body.entries[0].revisions).toHaveLength(2);
    expect(res.body.entries[0].revisions[1]).toMatchObject({
      action: 'BASELINE',
      assessment: '二次评估：补充验收口径',
    });
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

describe('GET /ops-progress：智能运维处理进度代理（v0.9.105）', () => {
  /** AIOps track 端点条目样例（字段与 requirement_analyses.track_view 对齐） */
  const trackItem = (over: Record<string, unknown> = {}) => ({
    entry_id: '5',
    tracked: true,
    stage: 'ANALYZING',
    stage_label: '智能分析中',
    current_version: 1,
    started_at: '2026-10-12T03:00:00+00:00',
    analysis_done_at: '',
    approved_at: '',
    release_status: null,
    release_at: '',
    updated_at: '2026-10-12T03:00:00+00:00',
    timeline: [{ stage: 'ANALYSIS_STARTED', at: '2026-10-12T03:00:00+00:00', version: 1, detail: '首次分析' }],
    ...over,
  });

  /** mock AIOps 响应（vi.stubGlobal 替换全局 fetch，afterEach 恢复） */
  const stubFetchOk = (entries: unknown[]) => {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, apps: [], app: null, entries }),
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  /** VIEWER 归属过滤桩：回查本人提交的条目（rows 即过滤后的可查条目） */
  const mineRule = (ids: number[]): DbStubRule => ({
    match: 'FROM feedback_entries WHERE user_id = ? AND id IN',
    rows: () => ids.map((id) => ({ id })),
  });

  const setTrackEnv = () => {
    process.env.AIOPS_TRACK_URL = 'http://127.0.0.1:8600';
    process.env.AIOPS_TRACK_TOKEN = 'track-secret';
  };

  it('缺 ids → 400；超过 100 个 → 400（不触 feedback_entries 也不发 fetch）', async () => {
    const fetchFn = stubFetchOk([]);
    const missing = await request(app)
      .get('/api/requirements/ops-progress')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('ids');
    const many = await request(app)
      .get(`/api/requirements/ops-progress?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(many.status).toBe(400);
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('feedback_entries'))).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('未配置 AIOPS_TRACK_URL/TOKEN → configured=false（不发 fetch）', async () => {
    const fetchFn = stubFetchOk([]);
    const res = await request(app)
      .get('/api/requirements/ops-progress?ids=3')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, configured: false, ops: {} });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('VIEWER 越权 ID 被静默剔除（无本人条目 → 不发 fetch）', async () => {
    setTrackEnv();
    const fetchFn = stubFetchOk([trackItem()]);
    querySpy.mockImplementation(dbStub([viewerAuth, mineRule([])]));
    const res = await request(app)
      .get('/api/requirements/ops-progress?ids=4')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, ok: true, ops: {} });
    expect(fetchFn).not.toHaveBeenCalled();
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM feedback_entries'));
    expect((call![1] as unknown[])[0]).toBe(9); // 归属回查绑定 token 用户（VIEWER id=9）
  });

  it('VIEWER 查本人条目 → 服务令牌拉取并归集（URL/Bearer 断言）', async () => {
    setTrackEnv();
    const fetchFn = stubFetchOk([trackItem({ entry_id: '5' })]);
    querySpy.mockImplementation(dbStub([viewerAuth, mineRule([5])]));
    const res = await request(app)
      .get('/api/requirements/ops-progress?ids=5')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.ops['5']).toMatchObject({ stage: 'ANALYZING', stage_label: '智能分析中' });
    expect(res.body.ops['5'].timeline).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:8600/api/requirements/track?entry_ids=5');
    expect(init.headers.Authorization).toBe('Bearer track-secret');
  });

  it('ADMIN 不触发归属过滤（直接拉取；URL 末尾斜杠自动裁剪）', async () => {
    process.env.AIOPS_TRACK_URL = 'http://127.0.0.1:8600/';
    process.env.AIOPS_TRACK_TOKEN = 'track-secret';
    const fetchFn = stubFetchOk([trackItem({ entry_id: '10', stage: 'RELEASED', stage_label: '已发布上线' })]);
    querySpy.mockImplementation(stub());
    const res = await request(app)
      .get('/api/requirements/ops-progress?ids=10')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.ops['10']).toMatchObject({ stage: 'RELEASED' });
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('FROM feedback_entries'))).toBe(false);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://127.0.0.1:8600/api/requirements/track?entry_ids=10');
  });

  it('上游非 2xx → ok=false + 中文错误且不缓存（重试仍发 fetch）', async () => {
    setTrackEnv();
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchFn);
    querySpy.mockImplementation(dbStub([viewerAuth, mineRule([6])]));
    const res = await request(app)
      .get('/api/requirements/ops-progress?ids=6')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, ok: false, ops: {} });
    expect(res.body.error).toContain('HTTP 503');
    await request(app)
      .get('/api/requirements/ops-progress?ids=6')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('上游不可达/超时 → ok=false + 中文错误', async () => {
    setTrackEnv();
    const unreachable = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', unreachable);
    querySpy.mockImplementation(dbStub([viewerAuth, mineRule([7])]));
    const res = await request(app)
      .get('/api/requirements/ops-progress?ids=7')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.body).toMatchObject({ ok: false, ops: {} });
    expect(res.body.error).toContain('无法连接');

    const timeout = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    vi.stubGlobal('fetch', timeout);
    querySpy.mockImplementation(dbStub([viewerAuth, mineRule([8])]));
    const t = await request(app)
      .get('/api/requirements/ops-progress?ids=8')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(t.body.error).toContain('超时');
  });

  it('成功响应缓存 20s：同 ids 二次请求不再发 fetch（cached=true）', async () => {
    setTrackEnv();
    const fetchFn = stubFetchOk([trackItem({ entry_id: '9' })]);
    querySpy.mockImplementation(dbStub([viewerAuth, mineRule([9])]));
    const first = await request(app)
      .get('/api/requirements/ops-progress?ids=9')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(first.body.cached).toBeUndefined();
    const second = await request(app)
      .get('/api/requirements/ops-progress?ids=9')
      .set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(second.body.cached).toBe(true);
    expect(second.body.ops['9']).toMatchObject({ stage: 'ANALYZING' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
