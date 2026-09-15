/**
 * analytics 路由契约测试（质量优化 Stage 2）：P1 高级分析（时序预测 / 多维归因 / 情景推演）。
 * 覆盖：鉴权（401/403）+ 参数校验（400，断言具体文案与 ERROR_CODES）+ 业务错误码（404/422）+ 成功路径。
 * 注：本路由为 router.use(authMiddleware)，三个端点均叠加 rateLimiter + requireRole('ADMIN','ANALYST')。
 * 说明：执行层（executeSafeSql）与 LLM 通道（callLLMJson）以模块级 spy 替换，
 *      其余导出经 importActual 原样保留（sqlExecutor 的 stripCommentsAndStrings/FORBIDDEN_KEYWORD_RE
 *      与 llmClient 的 setLlmUserContext/sqlStageRoute 等仍为真实实现）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

/** 安全执行层桩：保留其余导出（whatIf 依赖 stripCommentsAndStrings / FORBIDDEN_KEYWORD_RE） */
const execSpy = vi.fn();
vi.mock('../query/sqlExecutor', async () => {
  const actual: Record<string, unknown> = await vi.importActual('../query/sqlExecutor');
  return { ...actual, executeSafeSql: (...args: unknown[]) => execSpy(...args) };
});

/** LLM 通道桩：保留其余导出（authMiddleware 依赖 setLlmUserContext；链路依赖 StageRoute） */
const llmSpy = vi.fn();
vi.mock('../llm/llmClient', async () => {
  const actual: Record<string, unknown> = await vi.importActual('../llm/llmClient');
  return { ...actual, callLLMJson: (...args: unknown[]) => llmSpy(...args) };
});

import analyticsRoutes from './analytics';

applyTestEnv();

const app = buildApp('/api/analytics', analyticsRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const ANALYST_TOKEN = tokenFor('ANALYST', 7);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const analystAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 7)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

const adminStub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);
const analystStub = (...rules: DbStubRule[]) => dbStub([analystAuth, ...rules]);

/** data_sources 上下文加载行（loadSchemaContext SELECT 列对齐） */
const dsSchemaRow = (over: Record<string, unknown> = {}) => ({
  name: '数据源一',
  schema_json: '[]',
  scope_json: null,
  status: 'connected',
  type: 'mysql',
  allow_introspection: 0,
  config_json: null,
  ...over,
});

/** executeSafeSql 成功返回（ExecOutcome 语义） */
const execOk = (rows: Record<string, unknown>[]) => ({
  ok: true,
  result: { rows, rowCount: rows.length, truncated: false, finalSql: 'SELECT 1' },
});

const auditRule: DbStubRule = { match: 'INSERT INTO query_audit_log', rows: [] };

const post = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).post(url).set('Authorization', `Bearer ${token}`).send(body as object);

beforeEach(() => {
  querySpy.mockReset();
  execSpy.mockReset();
  llmSpy.mockReset();
});

describe('鉴权与角色守卫（rateLimiter + requireRole(ADMIN,ANALYST)）', () => {
  it('缺少 token → 401', async () => {
    const res = await request(app).post('/api/analytics/forecast').send({ yValues: [1, 2, 3] });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('角色 VIEWER → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await post('/api/analytics/forecast', { yValues: [1, 2, 3] }, VIEWER_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('POST /api/analytics/forecast：时序预测', () => {
  it('yValues 非数组或长度越界 → 400 INVALID_INPUT', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/forecast', { yValues: [1, 2] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('yValues 需为 3~240 个数值的数组');
  });

  it('xValues 与 yValues 长度不一致 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/forecast', { yValues: [1, 2, 3], xValues: ['a', 'b'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('xValues 与 yValues 长度不一致');
  });

  it('预测期数越界 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/forecast', { yValues: [1, 2, 3], periods: 30 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('预测期数需为 1~24 的整数');
  });

  it('历史序列含非数值项 → 400（统计引擎抛错转译）', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/forecast', { yValues: [1, 2, 'abc'], interpret: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('历史序列包含非数值项');
  });

  it('成功（interpret=false 不调 LLM）→ 200 仅返回统计结果', async () => {
    querySpy.mockImplementation(adminStub(auditRule));
    const res = await post('/api/analytics/forecast', { yValues: [10, 12, 11, 15, 16], interpret: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.interpretation).toBeNull();
    expect(res.body.forecast.model).toBe('ma');
    expect(res.body.forecast.points).toHaveLength(3); // 默认预测 3 期
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('成功（interpret=true）→ 200 附带 LLM 业务解读', async () => {
    llmSpy.mockResolvedValue(JSON.stringify({ summary: '总体温和上升', trendNote: '斜率转正', riskNote: '样本偏少' }));
    querySpy.mockImplementation(adminStub(auditRule));
    const res = await post('/api/analytics/forecast', { yValues: [10, 12, 11, 15, 16], metricLabel: '投放金额' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.interpretation).toMatchObject({ summary: '总体温和上升' });
    expect(llmSpy).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/analytics/attribution：多维自动归因', () => {
  it('rows 非数组或行数越界 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/attribution', { rows: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('rows 需为 1~200 行的数组');
  });

  it('aggregate 缺 periodKey/metricKey → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/attribution', { rows: [{ x: 1 }], aggregate: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('aggregate 需提供 periodKey 与 metricKey');
  });

  it('聚合失败（仅一期）→ 400 归因聚合失败', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/attribution', {
      rows: [{ p: '2024', m: 1 }],
      aggregate: { periodKey: 'p', metricKey: 'm' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('归因聚合失败：时期列仅有 1 期取值（需至少两期）');
  });

  it('模式一：行非对象 → 400 行格式不正确', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/attribution', { rows: [1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('rows 行格式不正确');
  });

  it('模式一：dims 缺失 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/attribution', { rows: [{ dims: [], current: 1, previous: 2 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('每行需提供 dims（1~3 个维度值）');
  });

  it('模式一：current/previous 非数值 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/attribution', { rows: [{ dims: ['华东'], current: 'x', previous: 2 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('每行需提供数值型 current 与 previous');
  });

  it('成功（直传归因行，interpret=false）→ 200', async () => {
    querySpy.mockImplementation(adminStub(auditRule));
    const res = await post('/api/analytics/attribution', {
      rows: [
        { dims: ['华东'], current: 10, previous: 5 },
        { dims: ['华南'], current: 3, previous: 8 },
      ],
      interpret: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.attribution.total.current).toBe(13);
    expect(res.body.attribution.items).toHaveLength(2);
    expect(res.body.periods).toBeNull();
    expect(res.body.interpretation).toBeNull();
  });

  it('成功（aggregate 自动聚合最新两期）→ 200 返回识别期次', async () => {
    querySpy.mockImplementation(adminStub(auditRule));
    const res = await post('/api/analytics/attribution', {
      rows: [
        { p: '2024-01', region: 'A', m: 10 },
        { p: '2024-02', region: 'A', m: 15 },
      ],
      aggregate: { periodKey: 'p', metricKey: 'm', dimKey: 'region' },
      interpret: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual(['2024-01', '2024-02']);
    expect(res.body.attribution.total).toMatchObject({ previous: 10, current: 15 });
  });
});

describe('POST /api/analytics/whatif：情景推演', () => {
  it('缺少数据源或原始 SQL → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/whatif', {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('缺少数据源或原始 SQL');
  });

  it('原始 SQL 过长 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/whatif', { dataSourceId: 'ds_w', sql: `SELECT ${'a'.repeat(4000)}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('原始 SQL 过长');
  });

  it('情景描述缺失 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/whatif', { dataSourceId: 'ds_w', sql: 'SELECT * FROM t' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请描述要模拟的情景（如"收紧华东区域投放 20% 后不良率如何变化"）');
  });

  it('情景描述过长 → 400', async () => {
    querySpy.mockImplementation(adminStub());
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_w',
      sql: 'SELECT * FROM t',
      scenario: 'x'.repeat(501),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('情景描述过长（≤500 字）');
  });

  it('无数据源访问权限 → 404（防探测）', async () => {
    querySpy.mockImplementation(
      analystStub({ match: 'SELECT acl_json FROM data_sources WHERE id = ?', rows: [{ acl_json: '{"departments":["其他部门"],"userIds":[]}' }] }),
    );
    const res = await post(
      '/api/analytics/whatif',
      { dataSourceId: 'ds_acl', sql: 'SELECT * FROM t', scenario: '收紧投放' },
      ANALYST_TOKEN,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('数据源不存在或无权访问');
  });

  it('数据源类型不支持情景推演 → 400', async () => {
    querySpy.mockImplementation(adminStub({ match: 'schema_json, scope_json', rows: () => [dsSchemaRow({ type: 'csv', config_json: null })] }));
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_unsup',
      sql: 'SELECT * FROM t',
      scenario: '收紧投放',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('当前数据源不支持情景推演（需数据库型或已落库文件数据源）');
  });

  it('原始 SQL 执行失败 → 400', async () => {
    execSpy.mockResolvedValue({ ok: false, reason: '权限不足' });
    querySpy.mockImplementation(adminStub({ match: 'schema_json, scope_json', rows: () => [dsSchemaRow()] }));
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_w23',
      sql: 'SELECT * FROM t',
      scenario: '收紧投放',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('原始 SQL 执行失败：权限不足');
  });

  it('情景改写失败（LLM 输出不合法）→ 422', async () => {
    execSpy.mockResolvedValue(execOk([{ value: 1 }]));
    llmSpy.mockResolvedValue('not-a-json');
    querySpy.mockImplementation(adminStub({ match: 'schema_json, scope_json', rows: () => [dsSchemaRow()] }));
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_w24',
      sql: 'SELECT SUM(value) AS value FROM t WHERE flag = 0',
      scenario: '启用 flag',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toBe('情景改写失败：情景改写结果未通过结构校验');
  });

  it('情景 SQL 执行失败 → 422', async () => {
    llmSpy.mockResolvedValue(
      JSON.stringify({
        scenarioSql: 'SELECT SUM(value) AS value FROM t WHERE flag = 1',
        explanation: '将 flag 由 0 改为 1',
        parameterChanges: [{ column: 'flag', from: '0', to: '1', description: '启用' }],
      }),
    );
    execSpy.mockResolvedValueOnce(execOk([{ value: 100 }])).mockResolvedValueOnce({ ok: false, reason: '被拒绝' });
    querySpy.mockImplementation(adminStub({ match: 'schema_json, scope_json', rows: () => [dsSchemaRow()] }));
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_w25',
      sql: 'SELECT SUM(value) AS value FROM t WHERE flag = 0',
      scenario: '启用 flag',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('情景 SQL 未通过安全校验或执行失败：被拒绝');
  });

  it('成功 → 200 返回推演计划/前后对比/解读', async () => {
    llmSpy
      .mockResolvedValueOnce(
        JSON.stringify({
          scenarioSql: 'SELECT SUM(value) AS value FROM t WHERE flag = 1',
          explanation: '将 flag 由 0 改为 1',
          parameterChanges: [{ column: 'flag', from: '0', to: '1', description: '启用' }],
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ summary: '指标提升', verdict: '正向', caveats: ['口径仅供参考'] }));
    execSpy.mockResolvedValueOnce(execOk([{ value: 100 }])).mockResolvedValueOnce(execOk([{ value: 150 }]));
    querySpy.mockImplementation(adminStub({ match: 'schema_json, scope_json', rows: () => [dsSchemaRow()] }, auditRule));
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_w26',
      sql: 'SELECT SUM(value) AS value FROM t WHERE flag = 0',
      scenario: '启用 flag',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.plan.scenarioSql).toBe('SELECT SUM(value) AS value FROM t WHERE flag = 1');
    expect(res.body.before).toMatchObject({ rowCount: 1 });
    expect(res.body.after).toMatchObject({ rowCount: 1 });
    expect(res.body.comparisons).toHaveLength(1);
    expect(res.body.comparisons[0]).toMatchObject({ column: 'value' });
    expect(res.body.interpretation).toMatchObject({ summary: '指标提升' });
  });

  it('执行链路异常 → 500 兜底错误码', async () => {
    execSpy.mockRejectedValue(new Error('连接中断'));
    querySpy.mockImplementation(adminStub({ match: 'schema_json, scope_json', rows: () => [dsSchemaRow()] }));
    const res = await post('/api/analytics/whatif', {
      dataSourceId: 'ds_w27',
      sql: 'SELECT * FROM t',
      scenario: '收紧投放',
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toBe('情景推演执行失败');
  });
});
