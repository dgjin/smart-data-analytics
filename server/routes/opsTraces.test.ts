/**
 * P2-1 链路追踪查询路由契约测试：
 * - 鉴权（401 无令牌 / 403 非 ADMIN）
 * - 列表：倒序、limit 与 minDurationMs 过滤
 * - 详情：traceId 格式非法 400、不存在 404、命中返回 span 瀑布（含 depth 层级）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import opsTracesRoutes from './opsTraces';
import { recordSpan, withSpan, clearTraces } from '../infra/trace';

applyTestEnv();

const app = buildApp('/api/ops', opsTracesRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

beforeEach(() => {
  clearTraces();
  delete process.env.TRACE_ENABLED;
  // 鉴权回查：按用例设置的 authRule 分派（默认 ADMIN）
  querySpy.mockReset();
  querySpy.mockImplementation(dbStub([adminAuth]));
});

describe('鉴权', () => {
  it('无令牌 → 401', async () => {
    const res = await request(app).get('/api/ops/traces');
    expect(res.status).toBe(401);
  });

  it('非 ADMIN（VIEWER）→ 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).get('/api/ops/traces').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/ops/traces', () => {
  it('空缓冲 → total=0', async () => {
    const res = await request(app).get('/api/ops/traces').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, traces: [] });
  });

  it('返回摘要并支持 limit', async () => {
    for (let i = 0; i < 3; i++) recordSpan(`span${i}`, 2, 'ok', {});
    const res = await request(app)
      .get('/api/ops/traces?limit=2')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.traces[0]).toMatchObject({ spanCount: 1, sampled: true });
    expect(res.body.traces[0]).not.toHaveProperty('spans');
  });

  it('minDurationMs 过滤掉快链路', async () => {
    recordSpan('fast', 1, 'ok', {});
    recordSpan('slow', 500, 'ok', {});
    const res = await request(app)
      .get('/api/ops/traces?minDurationMs=100')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.traces[0].durationMs).toBeGreaterThanOrEqual(100);
  });

  it('非法 limit 回落默认值（不报错）', async () => {
    const res = await request(app)
      .get('/api/ops/traces?limit=abc')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/ops/traces/:traceId', () => {
  it('格式非法 → 400', async () => {
    const res = await request(app)
      .get('/api/ops/traces/not-a-trace')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('traceId');
  });

  it('不存在 → 404', async () => {
    const res = await request(app)
      .get(`/api/ops/traces/${'a'.repeat(32)}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('命中 → 返回 span 瀑布（含 depth 与父子关系）', async () => {
    await withSpan('http.request', async () => {
      // 先让父 span 拉开起始时间，避免补录的 4ms 假耗时把子 span 起点推到父之前
      await new Promise((r) => setTimeout(r, 10));
      recordSpan('sql.execute', 4, 'ok', { 'sql.scenario': 'interactive' });
    });
    const list = await request(app).get('/api/ops/traces').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    const traceId = list.body.traces[0].traceId as string;

    const res = await request(app)
      .get(`/api/ops/traces/${traceId}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.traceId).toBe(traceId);
    expect(res.body.spanCount).toBe(2);
    const [root, child] = res.body.spans;
    expect(root).toMatchObject({ name: 'http.request', depth: 0 });
    expect(child).toMatchObject({ name: 'sql.execute', depth: 1 });
    expect(child.parentSpanId).toBe(root.spanId);
  });
});
