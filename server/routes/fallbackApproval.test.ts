/**
 * fallbackApproval 路由契约测试（质量优化 Stage 2）：困难样本审核（列表 / 批量 / 单条）。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404/409）+ 成功路径。
 * 注：本路由为端点级内联 authMiddleware + requireRole('ADMIN')；
 *     真实依赖 prioritizePendingSamples（主动学习排序）与 injectFewShotSamples（Few-Shot 注入）一并走真实链路，
 *     仅 DB 出口被桩化，故每个被执行的 SQL 都必须配桩。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import fallbackApprovalRoutes from './fallbackApproval';

applyTestEnv();

const app = buildApp('/api/admin/fallback-approval', fallbackApprovalRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const ANALYST_TOKEN = tokenFor('ANALYST', 5);

/** authMiddleware 回查行（ADMIN） */
const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
/** authMiddleware 回查行（ANALYST，仅用于 403 用例） */
const analystAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 5)] };

/** 以 ADMIN 鉴权行开头拼装桩规则 */
const adminStub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/** INSERT/UPDATE 的 ResultSetHeader 语义返回（dbStub 仅按数组透传，用带属性的数组承载 affectedRows） */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** adversarial_samples PENDING 行（主动学习排序 SELECT 的列结构） */
const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  original_query: '上季度销售额',
  original_sql: 'SELECT SUM(amount) FROM sales WHERE quarter = 1',
  error_message: '',
  data_source_id: 'ds-1',
  user_id: 7,
  annotation_status: 'PENDING',
  expected_sql: null,
  resolved_strategy: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** 单条审核前状态查询行 */
const reviewRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  original_query: '上季度销售额',
  data_source_id: 'ds-1',
  annotation_status: 'PENDING',
  ...over,
});

/** 主动学习排序 SELECT（GET / 用） */
const pendingSelect: DbStubRule = { match: 'ORDER BY created_at DESC', rows: [] };
/** 批量采纳时的样本明细 SELECT */
const batchSelect: DbStubRule = { match: 'SELECT id, original_query, expected_sql', rows: [] };
/** 单条审核前状态 SELECT */
const reviewSelect = (rows: unknown[]): DbStubRule => ({ match: 'FROM adversarial_samples WHERE id = ?', rows });
/** 全部 UPDATE（批量终态 / 单条终态） */
const updateRule = (affectedRows: number): DbStubRule => ({ match: 'UPDATE adversarial_samples', rows: resultSet({ affectedRows }) });
/** Few-Shot 示例库写入 */
const fewShotInsert: DbStubRule = { match: 'INSERT INTO few_shot_examples', rows: [] };

beforeEach(() => {
  querySpy.mockReset();
  // 默认仅装配鉴权回查；需要业务 SQL 的用例再行覆盖（dbStub 未命中规则即抛错，避免假通过）
  querySpy.mockImplementation(adminStub());
});

describe('鉴权与角色守卫（内联 authMiddleware + requireRole(ADMIN)）', () => {
  it('GET / 缺少 token → 401', async () => {
    const res = await request(app).get('/api/admin/fallback-approval');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('GET / 非 ADMIN 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([analystAuth]));
    const res = await request(app).get('/api/admin/fallback-approval').set('Authorization', `Bearer ${ANALYST_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('POST /batch 缺少 token → 401', async () => {
    const res = await request(app).post('/api/admin/fallback-approval/batch').send({ ids: [1], action: 'approve' });
    expect(res.status).toBe(401);
  });

  it('PUT /:id/review 非 ADMIN 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([analystAuth]));
    const res = await request(app)
      .put('/api/admin/fallback-approval/1/review')
      .set('Authorization', `Bearer ${ANALYST_TOKEN}`)
      .send({ status: 'REJECTED' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/admin/fallback-approval：待审样本列表', () => {
  it('无待审样本 → 200 返回空列表与提示文案', async () => {
    querySpy.mockImplementation(adminStub(pendingSelect));
    const res = await request(app).get('/api/admin/fallback-approval').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, samples: [], message: '暂无待审核样本' });
  });

  it('有待审样本 → 200 返回全量字段 + 优先级信息（按分数排名）', async () => {
    querySpy.mockImplementation(
      adminStub({
        match: 'ORDER BY created_at DESC',
        rows: [
          pendingRow({ id: 1, original_sql: 'SELECT SUM(amount) FROM sales WHERE quarter = 1', user_id: 7 }),
          pendingRow({ id: 2, original_sql: 'SELECT 1', data_source_id: 'ds-2', user_id: 9 }),
        ],
      }),
    );
    const res = await request(app).get('/api/admin/fallback-approval').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.samples).toHaveLength(2);
    expect(res.body.samples[0]).toMatchObject({
      original_query: '上季度销售额',
      data_source_id: 'ds-1',
      user_id: 7,
      annotation_status: 'PENDING',
      expected_sql: null,
      rank: 1,
    });
    expect(typeof res.body.samples[0].total_score).toBe('number');
    expect(res.body.priorityInfo).toMatchObject({ totalCount: 2, sortingMethod: 'active_learning_multi_factor' });
    expect(typeof res.body.priorityInfo.topScore).toBe('number');
  });

  it('排序查询异常 → fail-safe 降级为空列表（200，不冒泡 500）', async () => {
    querySpy.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('ORDER BY created_at DESC')) throw new Error('db down');
      return adminStub()(sql, params);
    });
    const res = await request(app).get('/api/admin/fallback-approval').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.samples).toEqual([]);
  });
});

describe('POST /api/admin/fallback-approval/batch：批量审核', () => {
  const batch = (body: Record<string, unknown>) =>
    request(app).post('/api/admin/fallback-approval/batch').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('ids 缺失 → 400', async () => {
    const res = await batch({ action: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无效的参数');
  });

  it('ids 非数组 → 400', async () => {
    const res = await batch({ ids: '1,2', action: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无效的参数');
  });

  it('ids 空数组 → 400', async () => {
    const res = await batch({ ids: [], action: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无效的参数');
  });

  it('批量采纳 → 200 且带修正 SQL 的样本被注入 Few-Shot（空 expected_sql 跳过）', async () => {
    querySpy.mockImplementation(
      adminStub(
        updateRule(2),
        { ...batchSelect, rows: [
          { id: 1, original_query: 'q1', expected_sql: 'SELECT 1', data_source_id: 'ds-1' },
          { id: 2, original_query: 'q2', expected_sql: null, data_source_id: 'ds-1' },
        ] },
        fewShotInsert,
      ),
    );
    const res = await batch({ ids: [1, 2], action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: '2 个样本已采纳' });
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO few_shot_examples'), expect.anything());
  });

  it('批量拒绝 → 200 且不触发 Few-Shot 注入', async () => {
    querySpy.mockImplementation(adminStub(updateRule(1)));
    const res = await batch({ ids: [3], action: 'reject' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: '1 个样本已拒绝' });
    expect(querySpy).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO few_shot_examples'), expect.anything());
  });

  it('DB 异常 → 500（UPDATE 未配桩即抛错）', async () => {
    const res = await batch({ ids: [1], action: 'approve' });
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('批量操作失败');
  });
});

describe('PUT /api/admin/fallback-approval/:id/review：单条审核', () => {
  const review = (id: string, body: Record<string, unknown>) =>
    request(app).put(`/api/admin/fallback-approval/${id}/review`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('缺少 token → 401', async () => {
    const res = await request(app).put('/api/admin/fallback-approval/1/review').send({ status: 'REJECTED' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('样本不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub(reviewSelect([])));
    const res = await review('404', { status: 'APPROVED' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('样本不存在');
  });

  it('样本已被处理 → 400', async () => {
    querySpy.mockImplementation(adminStub(reviewSelect([reviewRow({ annotation_status: 'APPROVED' })])));
    const res = await review('1', { status: 'APPROVED' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('该样本已被处理，无法修改');
  });

  it('审核通过（带修正 SQL）→ 200 且修正 SQL 注入 Few-Shot 示例库', async () => {
    querySpy.mockImplementation(adminStub(reviewSelect([reviewRow()]), updateRule(1), fewShotInsert));
    const res = await review('1', { expected_sql: 'SELECT 1', status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: '审核成功' });
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO few_shot_examples'), expect.anything());
  });

  it('审核拒绝（无 expected_sql）→ 200 且不注入 Few-Shot', async () => {
    querySpy.mockImplementation(adminStub(reviewSelect([reviewRow()]), updateRule(1)));
    const res = await review('1', { status: 'REJECTED' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: '审核成功' });
    expect(querySpy).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO few_shot_examples'), expect.anything());
  });

  it('并发重复处理（affectedRows=0）→ 409', async () => {
    querySpy.mockImplementation(adminStub(reviewSelect([reviewRow()]), updateRule(0)));
    const res = await review('1', { expected_sql: 'SELECT 1', status: 'APPROVED' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('该样本已被其他管理员处理');
  });

  it('DB 异常 → 500（状态查询未配桩即抛错）', async () => {
    const res = await review('1', { status: 'REJECTED' });
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('审核失败');
  });
});
