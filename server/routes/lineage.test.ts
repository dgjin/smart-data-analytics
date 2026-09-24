/**
 * lineage 路由契约测试（血缘管理优化 P0）：鉴权 + 角色 + 成功聚合 + 空库 + DB 失败降级。
 * GET /api/lineage/graph 为只读端点：authMiddleware + requireRole('ADMIN')。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import lineageRoutes from './lineage';
import { invalidateLineageCache } from '../lineage/service';

applyTestEnv();

const app = buildApp('/api/lineage', lineageRoutes);
const ADMIN_TOKEN = tokenFor('ADMIN', 1);

/** authMiddleware 回查行（ADMIN，id=1） */
const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };

/** 以鉴权行开头拼装桩规则 */
const stubFor = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/** data_sources 行（含一条 fct_jc_ 宽表） */
const dsRow = () => ({
  id: 'ds-1',
  name: '数据资源',
  type: 'greenplum',
  schema_json: JSON.stringify([{ name: 'fct_jc_asset', tableType: 'TABLE' }]),
  updated_at: '2026-09-20T00:00:00.000Z',
});

beforeEach(() => {
  querySpy.mockReset();
  // 服务层 30s TTL 缓存跨用例复用会串数据，逐例清空
  invalidateLineageCache();
});

describe('鉴权', () => {
  it('GET /graph 缺少 token → 401', async () => {
    const res = await request(app).get('/api/lineage/graph');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('非 ADMIN 角色 → 403（血缘视图仅 ADMIN 可见）', async () => {
    querySpy.mockImplementation(
      dbStub([{ match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 2)] }]),
    );
    const res = await request(app)
      .get('/api/lineage/graph')
      .set('Authorization', `Bearer ${tokenFor('ANALYST', 2)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/lineage/graph：全量血缘图', () => {
  it('聚合数据源/报表/图表/指标返回节点、边与统计', async () => {
    querySpy.mockImplementation(
      stubFor(
        { match: 'FROM data_sources', rows: () => [dsRow()] },
        {
          match: 'FROM saved_reports',
          rows: () => [
            {
              report_id: 'r1',
              data_source_id: 'ds-1',
              created_at: '2026-09-21T00:00:00.000Z',
              report_data: JSON.stringify({
                title: '不良资产经营简报',
                executedSqls: ['SELECT SUM(tfje) FROM fct_jc_asset'],
              }),
            },
          ],
        },
        {
          match: 'FROM dashboard_widgets',
          rows: () => [
            {
              widget_id: 'widget-1',
              created_at: '2026-09-21T00:00:00.000Z',
              widget_data: JSON.stringify({ id: 'widget-1', title: '逐月投放走势', chartConfig: { type: 'area' }, data: [] }),
            },
          ],
        },
        {
          match: 'FROM metric_definitions',
          rows: () => [
            { id: 11, name: '投放金额', data_source_id: 'ds-1', table_name: 'fct_jc_asset', expr: 'SUM(tfje)', status: 'ACTIVE' },
          ],
        },
      ),
    );

    const res = await request(app)
      .get('/api/lineage/graph')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // 报表 consumes(parsed) + 指标 derives(parsed)；内置图表无 SQL → declared 推演边
    expect(res.body.stats.parsedEdges).toBe(2);
    expect(res.body.stats.declaredEdges).toBe(1);
    expect(res.body.stats.staleEdges).toBe(0);
    expect(res.body.nodes.some((n: { id: string }) => n.id === 'ds:ds-1')).toBe(true);
    expect(res.body.nodes.some((n: { id: string }) => n.id === 'tbl:ds-1:fct_jc_asset')).toBe(true);
    expect(res.body.nodes.some((n: { id: string }) => n.id === 'metric:11')).toBe(true);
    // 内置图表按数据资源库推演归属
    const widgetEdge = res.body.edges.find(
      (e: { to: string; sourceType: string }) => e.to === 'widget:widget-1' && e.sourceType === 'declared',
    );
    expect(widgetEdge).toBeTruthy();
  });

  it('空库返回空图且不报错', async () => {
    querySpy.mockImplementation(
      stubFor(
        { match: 'FROM data_sources', rows: () => [] },
        { match: 'FROM saved_reports', rows: () => [] },
        { match: 'FROM dashboard_widgets', rows: () => [] },
        { match: 'FROM metric_definitions', rows: () => [] },
      ),
    );
    const res = await request(app)
      .get('/api/lineage/graph')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect(res.body.edges).toEqual([]);
    expect(res.body.stats.parseCoverage).toBe(1);
  });

  it('DB 查询失败 → 500 + INTERNAL_ERROR（前端据此降级本地估算）', async () => {
    querySpy.mockImplementation(async (sql: string) => {
      if (sql.includes('must_change_password FROM users WHERE id')) return [[activeUserRow('ADMIN', 1)]];
      throw new Error('db down');
    });
    const res = await request(app)
      .get('/api/lineage/graph')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});
