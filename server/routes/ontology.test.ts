/**
 * v0.9.110 /api/ontology 路由契约测试：
 * 鉴权（401/403）、参数校验（400）、业务错误码（404/409）、列表/写入/版本/path/summary 成功路径。
 * DB 走 routeTestKit.dbStub（按 SQL 片段分派），不依赖真实 MySQL。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import ontologyRoutes from './ontology';

applyTestEnv();

const app = buildApp('/api/ontology', ontologyRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const ANALYST_TOKEN = tokenFor('ANALYST', 7);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const analystAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ANALYST', 7)] };

/** INSERT/UPDATE 的 ResultSetHeader 语义（dbStub 原样透传行集，用带属性的数组冒充） */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

const entityRow = (o: Record<string, unknown> = {}) => ({
  id: 1,
  data_source_id: 'ds_m1',
  name: '机构',
  entity_type: 'SUBJECT',
  aliases_json: '["JGMC"]',
  description: '机构主数据',
  status: 'ACTIVE',
  version: 1,
  created_by: 'admin',
  ...o,
});

const bindingRow = (o: Record<string, unknown> = {}) => ({
  id: 10,
  entity_id: 1,
  data_source_id: 'ds_m1',
  table_name: 'JGXX',
  column_name: 'JGMC',
  role: 'IDENTITY',
  ...o,
});

const relationRow = (o: Record<string, unknown> = {}) => ({
  id: 3,
  data_source_id: 'ds_m1',
  from_table: 'A',
  from_columns: 'ID',
  to_table: 'B',
  to_columns: 'A_ID',
  join_type: 'LEFT',
  cardinality: '1:N',
  purpose: '关联',
  status: 'ACTIVE',
  version: 1,
  created_by: 'admin',
  ...o,
});

const get = (url: string, token = ADMIN_TOKEN) => request(app).get(url).set('Authorization', `Bearer ${token}`);
const post = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).post(url).set('Authorization', `Bearer ${token}`).send(body as object);
const put = (url: string, body: unknown, token = ADMIN_TOKEN) =>
  request(app).put(url).set('Authorization', `Bearer ${token}`).send(body as object);
const del = (url: string, token = ADMIN_TOKEN) => request(app).delete(url).set('Authorization', `Bearer ${token}`);

const validEntity = { dataSourceId: 'ds_m1', name: '机构', entityType: 'SUBJECT', aliases: ['JGMC'], description: '' };

beforeEach(() => {
  querySpy.mockReset();
});

describe('鉴权与角色守卫', () => {
  it('GET /entities 无 token → 401；ANALYST 可读 → 200', async () => {
    const anon = await request(app).get('/api/ontology/entities?dataSourceId=ds_m1');
    expect(anon.status).toBe(401);

    querySpy.mockImplementation(dbStub([analystAuth, { match: 'FROM ontology_entities', rows: () => [entityRow()] }, { match: 'FROM ontology_bindings', rows: () => [] }]));
    const ok = await get('/api/ontology/entities?dataSourceId=ds_m1', ANALYST_TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body.entities).toHaveLength(1);
  });

  it('写接口 ANALYST → 403（创建实体/值域/关系/层级、版本、回滚）', async () => {
    querySpy.mockImplementation(dbStub([analystAuth]));
    expect((await post('/api/ontology/entities', validEntity, ANALYST_TOKEN)).status).toBe(403);
    expect((await post('/api/ontology/value-notes', {}, ANALYST_TOKEN)).status).toBe(403);
    expect((await post('/api/ontology/value-notes/bulk', {}, ANALYST_TOKEN)).status).toBe(403);
    expect((await post('/api/ontology/relations', {}, ANALYST_TOKEN)).status).toBe(403);
    expect((await post('/api/ontology/hierarchies', {}, ANALYST_TOKEN)).status).toBe(403);
    expect((await get('/api/ontology/entities/1/versions', ANALYST_TOKEN)).status).toBe(403);
    expect((await post('/api/ontology/entities/1/restore', { version: 1 }, ANALYST_TOKEN)).status).toBe(403);
  });
});

describe('参数校验与错误码', () => {
  it('缺少 dataSourceId → 400；非法 ID → 400；缺少版本号 → 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));
    expect((await get('/api/ontology/entities')).status).toBe(400);
    expect((await get('/api/ontology/value-notes')).status).toBe(400);
    expect((await get('/api/ontology/relations')).status).toBe(400);
    expect((await get('/api/ontology/hierarchies')).status).toBe(400);
    expect((await get('/api/ontology/summary')).status).toBe(400);
    expect((await put('/api/ontology/entities/abc', validEntity)).status).toBe(400);
    expect((await post('/api/ontology/entities/1/restore', {})).status).toBe(400);
    expect((await get('/api/ontology/path?dataSourceId=ds_m1&from=A')).status).toBe(400);
  });

  it('创建实体缺名称 → 400；重名 → 409', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));
    expect((await post('/api/ontology/entities', { dataSourceId: 'ds_m1' })).status).toBe(400);

    querySpy.mockImplementation(dbStub([adminAuth, { match: 'SELECT id FROM ontology_entities', rows: () => [{ id: 1 }] }]));
    expect((await post('/api/ontology/entities', validEntity)).status).toBe(409);
  });
});

describe('实体与绑定', () => {
  it('GET /entities 返回实体并聚合绑定（别名已解析）', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'FROM ontology_entities', rows: () => [entityRow()] },
        { match: 'FROM ontology_bindings', rows: () => [bindingRow()] },
      ])
    );
    const res = await get('/api/ontology/entities?dataSourceId=ds_m1');
    expect(res.status).toBe(200);
    expect(res.body.entities[0].aliases).toEqual(['JGMC']);
    expect(res.body.entities[0].bindings[0].role).toBe('IDENTITY');
  });

  it('POST /entities 成功 → 200 并返回 id；写 version 快照', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'SELECT id FROM ontology_entities', rows: () => [] },
        { match: 'INSERT INTO ontology_entities', rows: () => resultSet({ insertId: 11 }) },
        { match: 'INSERT INTO ontology_versions', rows: () => resultSet({}) },
      ])
    );
    const res = await post('/api/ontology/entities', validEntity);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 11 });
  });

  it('PUT /entities/:id/bindings 整组替换 → 200 count；bindings 非数组 → 400', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'FROM ontology_entities WHERE id', rows: () => [entityRow()] },
        { match: 'DELETE FROM ontology_bindings', rows: () => resultSet({ affectedRows: 1 }) },
        { match: 'INSERT INTO ontology_bindings', rows: () => resultSet({ insertId: 1 }) },
      ])
    );
    const res = await put('/api/ontology/entities/1/bindings', {
      dataSourceId: 'ds_m1',
      bindings: [{ tableName: 'JGXX', columnName: 'JGMC', role: 'IDENTITY' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });

    expect((await put('/api/ontology/entities/1/bindings', { dataSourceId: 'ds_m1', bindings: 'x' })).status).toBe(400);
  });

  it('GET /entities/:id/versions 返回版本列表', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'FROM ontology_versions', rows: () => [{ version: 2, action: 'UPDATE', actor: 'admin', created_at: 't', snapshot_json: '{}' }] },
      ])
    );
    const res = await get('/api/ontology/entities/1/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions[0]).toMatchObject({ version: 2, action: 'UPDATE' });
  });

  it('DELETE /entities/:id 不存在 → 404', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'FROM ontology_entities WHERE id', rows: () => [] }]));
    expect((await del('/api/ontology/entities/9')).status).toBe(404);
  });
});

describe('值域释义', () => {
  it('GET 列表 / POST upsert / PUT 行内编辑 / DELETE 不存在 404', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'FROM ontology_value_notes WHERE data_source_id = ? AND table_name', rows: () => [] },
        { match: 'FROM ontology_value_notes', rows: () => [{ id: 5, data_source_id: 'ds_m1', table_name: 'JGXX', column_name: 'BB', value_code: '1', meaning: '本期', status: 'ACTIVE' }] },
        { match: 'SELECT id FROM ontology_value_notes', rows: () => [] },
        { match: 'INSERT INTO ontology_value_notes', rows: () => resultSet({ insertId: 20 }) },
        { match: 'UPDATE ontology_value_notes', rows: () => resultSet({ affectedRows: 1 }) },
        { match: 'DELETE FROM ontology_value_notes', rows: () => resultSet({ affectedRows: 0 }) },
      ])
    );
    const list = await get('/api/ontology/value-notes?dataSourceId=ds_m1');
    expect(list.status).toBe(200);
    expect(list.body.valueNotes[0].meaning).toBe('本期');

    const created = await post('/api/ontology/value-notes', {
      dataSourceId: 'ds_m1',
      tableName: 'JGXX',
      columnName: 'BB',
      valueCode: '1',
      meaning: '本期',
    });
    expect(created.status).toBe(200);
    expect(created.body.id).toBe(20);

    expect((await put('/api/ontology/value-notes/5', { meaning: '本期（修正）' })).status).toBe(200);
    expect((await del('/api/ontology/value-notes/5')).status).toBe(404);
  });

  it('POST 值域释义缺含义 → 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));
    const res = await post('/api/ontology/value-notes', { dataSourceId: 'ds_m1', tableName: 'JGXX', columnName: 'BB', valueCode: '1' });
    expect(res.status).toBe(400);
  });

  it('POST /value-notes/bulk 空 items → 400；超过 200 条 → 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));
    expect((await post('/api/ontology/value-notes/bulk', { dataSourceId: 'ds_m1', tableName: 'JGXX', columnName: 'BB', items: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ valueCode: String(i), meaning: `含义${i}` }));
    expect(
      (await post('/api/ontology/value-notes/bulk', { dataSourceId: 'ds_m1', tableName: 'JGXX', columnName: 'BB', items: tooMany })).status
    ).toBe(400);
  });

  it('POST /value-notes/bulk 部分失败仍 200，返回 saved/failed/failures', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'SELECT id FROM ontology_value_notes', rows: () => [] },
        { match: 'INSERT INTO ontology_value_notes', rows: () => resultSet({ insertId: 21 }) },
      ])
    );
    const res = await post('/api/ontology/value-notes/bulk', {
      dataSourceId: 'ds_m1',
      tableName: 'JGXX',
      columnName: 'BB',
      items: [
        { valueCode: '1', meaning: '本期' },
        { valueCode: '', meaning: '缺值编码' },
        { valueCode: '2', meaning: '上期' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.failures[0]).toMatchObject({ index: 1, error: expect.stringContaining('值编码') });
  });
});

describe('关联路径与层级', () => {
  it('GET /relations 列表；POST 成功；PUT 不存在 → 404', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'FROM ontology_relations WHERE id', rows: () => [] },
        { match: 'SELECT id FROM ontology_relations', rows: () => [] },
        { match: 'FROM ontology_relations', rows: () => [relationRow()] },
        { match: 'INSERT INTO ontology_relations', rows: () => resultSet({ insertId: 30 }) },
        { match: 'INSERT INTO ontology_versions', rows: () => resultSet({}) },
      ])
    );
    const list = await get('/api/ontology/relations?dataSourceId=ds_m1');
    expect(list.status).toBe(200);
    expect(list.body.relations[0].fromColumns).toEqual(['ID']);

    const created = await post('/api/ontology/relations', {
      dataSourceId: 'ds_m1',
      fromTable: 'A',
      fromColumns: ['ID'],
      toTable: 'B',
      toColumns: ['A_ID'],
    });
    expect(created.status).toBe(200);
    expect(created.body.id).toBe(30);

    const missing = await put('/api/ontology/relations/99', { fromTable: 'A', fromColumns: ['ID'], toTable: 'B', toColumns: ['A_ID'] });
    expect(missing.status).toBe(404);
  });

  it('POST /hierarchies 成功；层级不足 2 级 → 400', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'SELECT id FROM ontology_hierarchies', rows: () => [] },
        { match: 'INSERT INTO ontology_hierarchies', rows: () => resultSet({ insertId: 40 }) },
        { match: 'INSERT INTO ontology_versions', rows: () => resultSet({}) },
      ])
    );
    const ok = await post('/api/ontology/hierarchies', { dataSourceId: 'ds_m1', name: '机构层级', levels: ['JT', 'FGS'] });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(40);

    const bad = await post('/api/ontology/hierarchies', { dataSourceId: 'ds_m1', name: 'x', levels: ['JT'] });
    expect(bad.status).toBe(400);
  });

  it('GET /path 返回 BFS 最短路', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'FROM ontology_entities', rows: () => [] },
        { match: 'FROM ontology_bindings', rows: () => [] },
        { match: 'FROM ontology_value_notes', rows: () => [] },
        { match: 'FROM ontology_relations', rows: () => [relationRow()] },
        { match: 'FROM ontology_hierarchies', rows: () => [] },
      ])
    );
    const res = await get('/api/ontology/path?dataSourceId=ds_m1&from=A&to=B');
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveLength(1);
    expect(res.body.paths[0].hops).toBe(1);
  });
});

describe('概览计数', () => {
  it('GET /summary 返回五类计数', async () => {
    querySpy.mockImplementation(
      dbStub([
        adminAuth,
        { match: 'cnt FROM ontology_entities', rows: () => [{ cnt: 3 }] },
        { match: 'cnt FROM ontology_value_notes', rows: () => [{ cnt: 5 }] },
        { match: 'cnt FROM ontology_relations', rows: () => [{ cnt: 2 }] },
        { match: 'cnt FROM ontology_hierarchies', rows: () => [{ cnt: 1 }] },
        { match: 'cnt FROM ontology_bindings', rows: () => [{ cnt: 6 }] },
      ])
    );
    const res = await get('/api/ontology/summary?dataSourceId=ds_m1');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ entities: 3, valueNotes: 5, relations: 2, hierarchies: 1, bindings: 6 });
  });
});

describe('自动搭建（auto-build）', () => {
  const autoSchema = JSON.stringify([
    {
      name: 'fct_fin',
      displayName: '财务宽表',
      rowCount: 1000,
      columns: [
        { name: 'JGBH', description: '机构' },
        { name: 'JGMC', description: '机构名称' },
        { name: 'BB', description: '版本（1=核算版；2=分成版）' },
      ],
    },
    {
      name: 'fct_biz',
      displayName: '主营业务-业务粒度宽表',
      rowCount: 100,
      columns: [
        { name: 'JGBH', description: '机构编号' },
        { name: 'JGMC', description: '机构名称' },
        { name: 'SFYQ', description: '是否逾期（取值：是/否）' },
      ],
    },
  ]);

  const dsRule = (schema = autoSchema) => ({
    match: 'FROM data_sources WHERE id',
    rows: () => [{ name: '数据资源', schema_json: schema }],
  });

  /** apply 场景的完整 stub：查重/列表一律返回空，写入返回自增 ID */
  const applyRules = () => [
    adminAuth,
    dsRule(),
    { match: 'SELECT id FROM ontology_entities', rows: () => [] },
    { match: 'FROM ontology_entities WHERE data_source_id', rows: () => [] },
    { match: 'FROM ontology_entities WHERE id', rows: () => [entityRow({ id: 101 })] },
    { match: 'DELETE FROM ontology_bindings', rows: () => resultSet({ affectedRows: 0 }) },
    { match: 'FROM ontology_bindings', rows: () => [] },
    { match: 'INSERT INTO ontology_entities', rows: () => resultSet({ insertId: 101 }) },
    { match: 'INSERT INTO ontology_versions', rows: () => resultSet({}) },
    { match: 'INSERT INTO ontology_bindings', rows: () => resultSet({}) },
    { match: 'SELECT id FROM ontology_value_notes', rows: () => [] },
    { match: 'FROM ontology_value_notes', rows: () => [] },
    { match: 'INSERT INTO ontology_value_notes', rows: () => resultSet({ insertId: 201 }) },
    { match: 'SELECT id FROM ontology_relations', rows: () => [] },
    { match: 'FROM ontology_relations', rows: () => [] },
    { match: 'INSERT INTO ontology_relations', rows: () => resultSet({ insertId: 301 }) },
    { match: 'SELECT id FROM ontology_hierarchies', rows: () => [] },
    { match: 'FROM ontology_hierarchies', rows: () => [] },
    { match: 'INSERT INTO ontology_hierarchies', rows: () => resultSet({ insertId: 401 }) },
  ];

  it('ANALYST → 403；缺少 dataSourceId → 400', async () => {
    querySpy.mockImplementation(dbStub([analystAuth]));
    expect((await post('/api/ontology/auto-build', { dataSourceId: 'ds_m1' }, ANALYST_TOKEN)).status).toBe(403);

    querySpy.mockImplementation(dbStub([adminAuth]));
    expect((await post('/api/ontology/auto-build', {})).status).toBe(400);
  });

  it('数据源不存在 → 404；Schema 为空 → 400', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'FROM data_sources WHERE id', rows: () => [] }]));
    expect((await post('/api/ontology/auto-build', { dataSourceId: 'missing' })).status).toBe(404);

    querySpy.mockImplementation(dbStub([adminAuth, dsRule('[]')]));
    const empty = await post('/api/ontology/auto-build', { dataSourceId: 'ds_m1' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain('Schema');
  });

  it('dryRun 返回草案且不写库', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, dsRule()]));
    const res = await post('/api/ontology/auto-build', { dataSourceId: 'ds_m1' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('preview');
    expect(res.body.draft.stats).toMatchObject({ entities: 3, valueNotes: 2, relations: 1 });
    expect(res.body.draft.entities.map((e: { name: string }) => e.name)).toEqual(
      expect.arrayContaining(['财务', '主营业务', '机构'])
    );
    const writes = querySpy.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/i.test(String(sql)));
    expect(writes).toHaveLength(0);
  });

  it('apply 落库实体/绑定/值域/关联，并返回写入统计', async () => {
    querySpy.mockImplementation(dbStub(applyRules()));
    const res = await post('/api/ontology/auto-build', { dataSourceId: 'ds_m1', apply: true });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('apply');
    expect(res.body.applied).toMatchObject({
      entitiesCreated: 3,
      entitiesUpdated: 0,
      valueNotesWritten: 2,
      relationsCreated: 1,
      hierarchiesCreated: 0,
      skippedExisting: 0,
    });
    expect(res.body.applied.bindingsWritten).toBeGreaterThan(0);
    expect(res.body.ok).toBe(true);
  });

  it('重复 apply 默认跳过已存在实体（幂等保护人工维护）', async () => {
    const rules = applyRules();
    // index 3 为实体列表查询；保留 index 2 的「按名称查重」规则命中空集
    rules[3] = { match: 'FROM ontology_entities WHERE data_source_id', rows: () => [entityRow({ name: '机构' })] };
    querySpy.mockImplementation(dbStub(rules));
    const res = await post('/api/ontology/auto-build', { dataSourceId: 'ds_m1', apply: true });
    expect(res.status).toBe(200);
    expect(res.body.applied.entitiesCreated).toBe(2);
    expect(res.body.applied.skippedExisting).toBeGreaterThanOrEqual(1);
  });
});

describe('全局开关（v0.9.113）', () => {
  const original = process.env.ONTOLOGY_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.ONTOLOGY_ENABLED;
    else process.env.ONTOLOGY_ENABLED = original;
  });

  it('GET /settings 缺省启用并返回预算；PUT 关闭写 env_config 并热更 process.env', async () => {
    delete process.env.ONTOLOGY_ENABLED;
    querySpy.mockImplementation(
      dbStub([adminAuth, { match: 'INSERT INTO env_config', rows: () => resultSet({ affectedRows: 1 }) }])
    );

    const before = await get('/api/ontology/settings');
    expect(before.status).toBe(200);
    expect(before.body.enabled).toBe(true);
    expect(before.body.budgetTokens).toBeGreaterThanOrEqual(200);

    const off = await put('/api/ontology/settings', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(process.env.ONTOLOGY_ENABLED).toBe('0');
    const insert = querySpy.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO env_config'));
    expect(insert).toBeTruthy();
    const params = (insert?.[1] || []) as unknown[];
    expect(params[0]).toBe('ONTOLOGY_ENABLED');
    expect(params[1]).toBe('0');

    const on = await put('/api/ontology/settings', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(process.env.ONTOLOGY_ENABLED).toBe('1');
  });

  it('enabled 非布尔 → 400；ANALYST → 403', async () => {
    querySpy.mockImplementation(dbStub([adminAuth]));
    const bad = await put('/api/ontology/settings', { enabled: 'yes' });
    expect(bad.status).toBe(400);

    querySpy.mockImplementation(dbStub([analystAuth]));
    const forbidden = await put('/api/ontology/settings', { enabled: false }, ANALYST_TOKEN);
    expect(forbidden.status).toBe(403);
  });
});

