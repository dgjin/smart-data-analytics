/**
 * sqlExamples 路由契约测试（质量优化 Stage 2）：SQL 样例库 CRUD + 问题反推 + 批量登记 + 导出 / 导入。
 * 覆盖：成功路径 + 鉴权失败（401）+ 角色越权（403）+ 参数校验（400）+ 业务错误码（404/500）。
 * 桩说明：infra/db 按 SQL 分派（dbStub，未命中规则即抛错，避免桩缺配假通过）；
 * llmClient 的 embedding 调用直接失败（样例向量落 NULL，与生产降级一致）、
 * callLLMJson 返回固定问题（覆盖 generate-questions 成功路径，不连真实模型）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';
import type { UserRole } from '../auth/auth';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('../llm/llmClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/llmClient')>();
  return {
    ...actual,
    callEmbedding: async () => {
      throw new Error('测试环境未配置 embedding 模型');
    },
    callEmbeddingBatch: async () => {
      throw new Error('测试环境未配置 embedding 模型');
    },
    callLLMJson: async () => '本年度投放金额趋势',
  };
});

import sqlExampleRoutes from './sqlExamples';

applyTestEnv();

const app = buildApp('/api/sql-examples', sqlExampleRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 2);

/** authMiddleware 回查行（带 token 的用例恒最先执行该 SQL） */
const auth = (role: UserRole = 'ADMIN', id = 1): DbStubRule => ({
  match: 'FROM users WHERE id',
  rows: [activeUserRow(role, id)],
});

/** 以鉴权行开头拼装桩规则（authMiddleware 的回查 SQL 恒最先执行） */
const stub = (...rules: DbStubRule[]) => dbStub([auth(), ...rules]);

/**
 * INSERT/UPDATE/DELETE 的 ResultSetHeader 语义返回。
 * dbStub 只把规则行集整体透传（[rows]），故用「带属性的数组」冒充 affectedRows / insertId。
 */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** 未命中该 SQL 即抛错（用于触发路由 500 兜底分支） */
const boom = () => {
  throw new Error('db down');
};

/** 样例行（列名与 SELECT * 的物理列对齐） */
const exampleRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  data_source_id: 'ds1',
  question: '本年投放金额',
  sql_text: 'select sum(amount) from fct',
  source: 'MANUAL',
  created_by: 'admin',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const LIST_SQL = 'SELECT * FROM sql_examples WHERE data_source_id';
const INSERT_SQL = 'INSERT INTO sql_examples';
const UPDATE_SQL = 'UPDATE sql_examples SET question';
const DELETE_SQL = 'DELETE FROM sql_examples WHERE id = ?';
const DS_REF_SQL = 'SELECT id, name FROM data_sources';
const EXISTING_SQL = 'SELECT id, question FROM sql_examples';

beforeEach(() => {
  querySpy.mockReset();
  // 默认仅装配鉴权回查；需要业务 SQL 的用例再行覆盖
  querySpy.mockImplementation(stub());
});

describe('鉴权与角色守卫（router.use(authMiddleware)）', () => {
  it('缺少 token → 401（列表 / 登记 / 删除均被拦截）', async () => {
    const list = await request(app).get('/api/sql-examples?dataSourceId=ds1');
    expect(list.status).toBe(401);
    expect(list.body.error).toBe('未登录或登录已过期');

    const create = await request(app).post('/api/sql-examples').send({ dataSourceId: 'ds1', question: 'q', sql: 'select 1' });
    expect(create.status).toBe(401);

    const del = await request(app).delete('/api/sql-examples/1');
    expect(del.status).toBe(401);
  });

  it('token 被篡改 → 401 登录状态无效', async () => {
    const res = await request(app).get('/api/sql-examples?dataSourceId=ds1').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('登录状态无效，请重新登录');
  });

  it('token 有效但账号不存在 / 被禁用 → 401', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE id', rows: [] }]));
    const res = await request(app).get('/api/sql-examples?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('账号不存在或已被禁用');
  });

  it('VIEWER 调用写接口 → 403 没有权限执行此操作', async () => {
    querySpy.mockImplementation(dbStub([auth('VIEWER', 2)]));
    const viewer = { Authorization: `Bearer ${VIEWER_TOKEN}` };
    const cases = [
      request(app).post('/api/sql-examples').set(viewer).send({ dataSourceId: 'ds1', question: 'q', sql: 'select 1' }),
      request(app).post('/api/sql-examples/generate-questions').set(viewer).send({ sqls: ['select 1'] }),
      request(app).post('/api/sql-examples/bulk').set(viewer).send({ dataSourceId: 'ds1', examples: [{ question: 'q', sql: 'select 1' }] }),
      request(app).get('/api/sql-examples/export?dataSourceId=ds1').set(viewer),
      request(app).post('/api/sql-examples/import').set(viewer).send({ fileData: { type: 'sql-examples', examples: [{ question: 'q', sql: 'select 1' }] } }),
      request(app).put('/api/sql-examples/1').set(viewer).send({ question: 'q', sql: 'select 1' }),
      request(app).delete('/api/sql-examples/1').set(viewer),
    ];
    for (const pending of cases) {
      const res = await pending;
      expect(res.status, 'VIEWER 应被角色守卫拒绝').toBe(403);
      expect(res.body.error).toBe('没有权限执行此操作');
    }
  });

  it('VIEWER 读接口开放 → 列表 200', async () => {
    querySpy.mockImplementation(dbStub([auth('VIEWER', 2), { match: LIST_SQL, rows: [] }]));
    const res = await request(app).get('/api/sql-examples?dataSourceId=ds1').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.examples).toEqual([]);
  });
});

describe('GET /api/sql-examples：样例列表', () => {
  it('缺少 dataSourceId → 400', async () => {
    const res = await request(app).get('/api/sql-examples').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('成功 → 200 返回样例列表（列名转驼峰）', async () => {
    querySpy.mockImplementation(stub({ match: LIST_SQL, rows: [exampleRow()] }));
    const res = await request(app).get('/api/sql-examples?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.examples).toHaveLength(1);
    expect(res.body.examples[0]).toMatchObject({
      id: 1,
      dataSourceId: 'ds1',
      question: '本年投放金额',
      sql: 'select sum(amount) from fct',
      source: 'MANUAL',
      createdBy: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('查询异常 → 500 查询样例库失败', async () => {
    querySpy.mockImplementation(stub({ match: LIST_SQL, rows: boom }));
    const res = await request(app).get('/api/sql-examples?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^查询样例库失败：/);
  });
});

describe('POST /api/sql-examples：手工登记样例（ADMIN）', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/sql-examples').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('缺少 dataSourceId → 400', async () => {
    const res = await post({ question: '本年投放金额', sql: 'select 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('问题为空 → 400 问题不能为空', async () => {
    const res = await post({ dataSourceId: 'ds1', question: '  ', sql: 'select 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('问题不能为空');
  });

  it('SQL 非 SELECT → 400 仅支持登记 SELECT 查询样例', async () => {
    const res = await post({ dataSourceId: 'ds1', question: '删除数据', sql: 'DELETE FROM fct' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('仅支持登记 SELECT 查询样例');
  });

  it('登记成功 → 200 返回新样例（embedding 降级为 NULL 不阻断）', async () => {
    querySpy.mockImplementation(
      stub(
        { match: INSERT_SQL, rows: resultSet({ insertId: 11, affectedRows: 1 }) },
        { match: 'SELECT * FROM sql_examples WHERE id = ?', rows: [exampleRow({ id: 11 })] },
      ),
    );
    const res = await post({ dataSourceId: 'ds1', question: '本年投放金额', sql: 'select sum(amount) from fct' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.example).toMatchObject({ id: 11, dataSourceId: 'ds1', sql: 'select sum(amount) from fct' });
    const insertCall = querySpy.mock.calls.find(([sql]) => String(sql).includes(INSERT_SQL));
    expect(insertCall?.[1]).toEqual(['ds1', '本年投放金额', 'select sum(amount) from fct', 'MANUAL', 'u1', null]);
  });

  it('写库异常 → 500 登记失败', async () => {
    querySpy.mockImplementation(stub({ match: INSERT_SQL, rows: boom }));
    const res = await post({ dataSourceId: 'ds1', question: '本年投放金额', sql: 'select 1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^登记失败：/);
  });
});

describe('POST /api/sql-examples/generate-questions：SQL 反推问题（ADMIN）', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/sql-examples/generate-questions').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('缺少 sqls 数组 → 400', async () => {
    const res = await post({ sqls: 'select 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 sqls 数组');
  });

  it('数组内无有效 SQL → 400 没有有效的 SQL', async () => {
    const res = await post({ sqls: ['   ', 123] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('没有有效的 SQL');
  });

  it('超过单次上限 10 条 → 400', async () => {
    const res = await post({ sqls: Array.from({ length: 11 }, () => 'select 1') });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('单次最多导入 10 条 SQL');
  });

  it('成功 → 200 返回 sql/question 对（不入库）', async () => {
    const res = await post({ sqls: ['select sum(amount) from t'] });
    expect(res.status).toBe(200);
    expect(res.body.pairs).toEqual([{ sql: 'select sum(amount) from t', question: '本年度投放金额趋势' }]);
    expect(querySpy.mock.calls.some(([sql]) => String(sql).includes(INSERT_SQL))).toBe(false);
  });
});

describe('POST /api/sql-examples/bulk：批量登记样例（ADMIN）', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/sql-examples/bulk').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('缺少 dataSourceId → 400', async () => {
    const res = await post({ examples: [{ question: 'q', sql: 'select 1' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('缺少 examples 数组 → 400', async () => {
    const res = await post({ dataSourceId: 'ds1', examples: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 examples 数组');
  });

  it('超过单次上限 10 条 → 400', async () => {
    const res = await post({ dataSourceId: 'ds1', examples: Array.from({ length: 11 }, () => ({ question: 'q', sql: 'select 1' })) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('单次最多保存 10 条样例');
  });

  it('全部条目非法 → 400 没有可保存的合法样例', async () => {
    const res = await post({ dataSourceId: 'ds1', examples: [{ question: '', sql: 'select 1' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('没有可保存的合法样例');
  });

  it('批量保存成功 → 200 返回 saved 数（source 记 IMPORT）', async () => {
    querySpy.mockImplementation(
      stub(
        { match: INSERT_SQL, rows: resultSet({ insertId: 21, affectedRows: 1 }) },
        { match: 'SELECT * FROM sql_examples WHERE id = ?', rows: [exampleRow({ id: 21, source: 'IMPORT' })] },
      ),
    );
    const res = await post({ dataSourceId: 'ds1', examples: [{ question: '本年投放金额', sql: 'select 1' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, saved: 1 });
    const insertCall = querySpy.mock.calls.find(([sql]) => String(sql).includes(INSERT_SQL));
    expect(insertCall?.[1]?.[3]).toBe('IMPORT');
  });

  it('批量保存异常 → 500 批量保存失败', async () => {
    querySpy.mockImplementation(stub({ match: INSERT_SQL, rows: boom }));
    const res = await post({ dataSourceId: 'ds1', examples: [{ question: '本年投放金额', sql: 'select 1' }] });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^批量保存失败：/);
  });
});

describe('GET /api/sql-examples/export：导出备份（ADMIN）', () => {
  const exportRules = (rows: DbStubRule['rows']): DbStubRule[] => [
    { match: 'SELECT name FROM data_sources', rows: [{ name: 'SQL样例源' }] },
    { match: LIST_SQL, rows },
  ];

  it('缺少 dataSourceId → 400', async () => {
    const res = await request(app).get('/api/sql-examples/export').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('数据源不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT name FROM data_sources', rows: [] }));
    const res = await request(app).get('/api/sql-examples/export?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('数据源不存在：ds1');
  });

  it('成功 → 200 JSON 附件（剥离库内 id，保留来源标记）', async () => {
    querySpy.mockImplementation(stub(...exportRules([exampleRow(), exampleRow({ id: 2, question: '客户数量', sql: 'select count(*) from c' })])));
    const res = await request(app).get('/api/sql-examples/export?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toMatchObject({ type: 'sql-examples', dataSourceId: 'ds1', dataSourceName: 'SQL样例源', exampleCount: 2, exportedBy: 'u1' });
    expect(res.body.examples[0]).not.toHaveProperty('id');
  });

  it('导出异常 → 500 导出失败', async () => {
    querySpy.mockImplementation(stub(...exportRules(boom)));
    const res = await request(app).get('/api/sql-examples/export?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^导出失败：/);
  });
});

describe('POST /api/sql-examples/import：导入备份（ADMIN）', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/sql-examples/import').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  const dsRule: DbStubRule = { match: DS_REF_SQL, rows: [{ id: 'ds1', name: 'SQL样例源' }] };
  const file = { type: 'sql-examples', dataSourceId: 'ds1', examples: [{ question: '本年投放金额', sql: 'select sum(amount) from t' }] };

  it('缺少 fileData → 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 fileData（备份文件的 JSON 内容）');
  });

  it('mergeStrategy 非法 → 400', async () => {
    const res = await post({ fileData: file, mergeStrategy: 'replace' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('mergeStrategy 必须是 skip / overwrite / append');
  });

  it('文件格式无法识别 → 400', async () => {
    const res = await post({ fileData: { type: 'knowledge-docs', docs: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无法识别的文件格式：应为 SQL 样例库导出文件（type=sql-examples）');
  });

  it('文件中没有可导入的样例 → 400', async () => {
    const res = await post({ fileData: { type: 'sql-examples', dataSourceId: 'ds1', examples: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('文件中没有可导入的样例');
  });

  it('缺少目标数据源 → 400', async () => {
    const res = await post({ fileData: { type: 'sql-examples', examples: [{ question: 'q', sql: 'select 1' }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少目标数据源 dataSourceId（文件中也没有来源信息）');
  });

  it('目标数据源不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: DS_REF_SQL, rows: [] }));
    const res = await post({ fileData: file });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('目标数据源不存在：ds1');
  });

  it('dryRun 预检 → 200 仅统计新样例且不写库', async () => {
    querySpy.mockImplementation(stub(dsRule, { match: EXISTING_SQL, rows: [] }));
    const res = await post({ fileData: file, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, dryRun: true, importedCount: 1, skippedCount: 0, updatedCount: 0, dataSourceId: 'ds1', dataSourceName: 'SQL样例源' });
    expect(querySpy.mock.calls.some(([sql]) => String(sql).includes(INSERT_SQL))).toBe(false);
  });

  it('skip 策略同问题冲突 → 跳过', async () => {
    querySpy.mockImplementation(stub(dsRule, { match: EXISTING_SQL, rows: [{ id: 7, question: '本年投放金额' }] }));
    const res = await post({ fileData: file, mergeStrategy: 'skip' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 0, skippedCount: 1, updatedCount: 0 });
    expect(res.body.summary.conflictItems).toBe(1);
  });

  it('overwrite 策略同问题冲突 → 覆盖更新', async () => {
    querySpy.mockImplementation(stub(dsRule, { match: EXISTING_SQL, rows: [{ id: 7, question: '本年投放金额' }] }, { match: UPDATE_SQL, rows: resultSet({ affectedRows: 1 }) }));
    const res = await post({ fileData: file, mergeStrategy: 'overwrite' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 0, skippedCount: 0, updatedCount: 1 });
  });

  it('新样例落库 → 200 importedCount 递增（source 记 IMPORT）', async () => {
    querySpy.mockImplementation(
      stub(
        dsRule,
        { match: EXISTING_SQL, rows: [] },
        { match: INSERT_SQL, rows: resultSet({ insertId: 31, affectedRows: 1 }) },
        { match: 'SELECT * FROM sql_examples WHERE id = ?', rows: [exampleRow({ id: 31, source: 'IMPORT' })] },
      ),
    );
    const res = await post({ fileData: file, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 1, dataSourceName: 'SQL样例源' });
  });

  it('导入过程异常 → 500 导入失败', async () => {
    querySpy.mockImplementation(stub(dsRule, { match: EXISTING_SQL, rows: boom }));
    const res = await post({ fileData: file });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^导入失败：/);
  });
});

describe('PUT /api/sql-examples/:id：编辑样例（ADMIN）', () => {
  const put = (id: string, body: Record<string, unknown>) =>
    request(app).put(`/api/sql-examples/${id}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('ID 非数字 → 400 无效的样例 ID', async () => {
    const res = await put('abc', { question: '本年投放金额', sql: 'select 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无效的样例 ID');
  });

  it('入参校验失败 → 400 问题不能为空', async () => {
    const res = await put('5', { question: '', sql: 'select 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('问题不能为空');
  });

  it('样例不存在（affectedRows=0）→ 404', async () => {
    querySpy.mockImplementation(stub({ match: UPDATE_SQL, rows: resultSet({ affectedRows: 0 }) }));
    const res = await put('5', { question: '本年投放金额', sql: 'select 1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('样例不存在');
  });

  it('编辑成功 → 200 ok', async () => {
    querySpy.mockImplementation(stub({ match: UPDATE_SQL, rows: resultSet({ affectedRows: 1 }) }));
    const res = await put('5', { question: '本年投放金额', sql: 'select sum(amount) from fct' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updateCall = querySpy.mock.calls.find(([sql]) => String(sql).includes(UPDATE_SQL));
    expect(updateCall?.[1]).toEqual(['本年投放金额', 'select sum(amount) from fct', null, 5]);
  });

  it('保存异常 → 500 保存失败', async () => {
    querySpy.mockImplementation(stub({ match: UPDATE_SQL, rows: boom }));
    const res = await put('5', { question: '本年投放金额', sql: 'select 1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^保存失败：/);
  });
});

describe('DELETE /api/sql-examples/:id：剔除样例（ADMIN）', () => {
  const del = (id: string) => request(app).delete(`/api/sql-examples/${id}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  const deleteRule = (rows: DbStubRule['rows']): DbStubRule[] => [{ match: DELETE_SQL, rows }];

  it('ID 非数字 → 400 无效的样例 ID', async () => {
    const res = await del('abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无效的样例 ID');
  });

  it('样例不存在（affectedRows=0）→ 404', async () => {
    querySpy.mockImplementation(stub(...deleteRule(resultSet({ affectedRows: 0 }))));
    const res = await del('5');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('样例不存在');
  });

  it('剔除成功 → 200 ok', async () => {
    querySpy.mockImplementation(stub(...deleteRule(resultSet({ affectedRows: 1 }))));
    const res = await del('5');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('删除异常 → 500 删除失败', async () => {
    querySpy.mockImplementation(stub(...deleteRule(boom)));
    const res = await del('5');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^删除失败：/);
  });
});
