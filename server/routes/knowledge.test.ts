/**
 * knowledge 路由契约测试（质量优化 Stage 2）：知识文档 CRUD + 种子条目 + 导出 / 导入。
 * 覆盖：成功路径 + 鉴权失败（401）+ 角色越权（403）+ 参数校验（400）+ 业务错误码（404/500）。
 * 桩说明：infra/db 按 SQL 分派（dbStub，未命中规则即抛错，避免桩缺配假通过）；
 * llmClient 的 embedding / LLM 调用在测试内直接失败——知识切块入库时 embedding 自动降级为
 * NULL（与生产「未装 embedding 模型」降级路径一致），不连真实模型、不引入网络抖动。
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
    callLLMJson: async () => '测试问题',
  };
});

import knowledgeRoutes from './knowledge';
import { DATA_RESOURCE_DS_ID } from '../seedDataResources';

applyTestEnv();

const app = buildApp('/api/knowledge', knowledgeRoutes);

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
 * dbStub 只把规则行集整体透传（[rows]），故用「带属性的数组」冒充 affectedRows。
 */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** 未命中该 SQL 即抛错（用于触发路由 500 兜底分支） */
const boom = () => {
  throw new Error('db down');
};

beforeEach(() => {
  querySpy.mockReset();
  // 默认仅装配鉴权回查；需要业务 SQL 的用例再行覆盖
  querySpy.mockImplementation(stub());
});

describe('鉴权与角色守卫（router.use(authMiddleware)）', () => {
  it('缺少 token → 401（列表 / 登记 / 删除均被拦截）', async () => {
    const list = await request(app).get('/api/knowledge?dataSourceId=ds1');
    expect(list.status).toBe(401);
    expect(list.body.error).toBe('未登录或登录已过期');

    const create = await request(app).post('/api/knowledge').send({ dataSourceId: 'ds1', title: 't', content: 'c' });
    expect(create.status).toBe(401);

    const del = await request(app).delete('/api/knowledge/kb_1');
    expect(del.status).toBe(401);
  });

  it('token 被篡改 → 401 登录状态无效', async () => {
    const res = await request(app).get('/api/knowledge?dataSourceId=ds1').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('登录状态无效，请重新登录');
  });

  it('token 有效但账号不存在 / 被禁用 → 401', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE id', rows: [] }]));
    const res = await request(app).get('/api/knowledge?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('账号不存在或已被禁用');
  });

  it('VIEWER 调用写接口 → 403 没有权限执行此操作', async () => {
    querySpy.mockImplementation(dbStub([auth('VIEWER', 2)]));
    const viewer = { Authorization: `Bearer ${VIEWER_TOKEN}` };
    const cases = [
      request(app).post('/api/knowledge').set(viewer).send({ dataSourceId: 'ds1', title: 't', content: 'c' }),
      request(app).put('/api/knowledge/kb_1').set(viewer).send({ title: 't', content: 'c' }),
      request(app).delete('/api/knowledge/kb_1').set(viewer),
      request(app).get('/api/knowledge/export?dataSourceId=ds1').set(viewer),
      request(app).post('/api/knowledge/import').set(viewer).send({ fileData: { type: 'knowledge-docs', docs: [] } }),
    ];
    for (const pending of cases) {
      const res = await pending;
      expect(res.status, 'VIEWER 应被角色守卫拒绝').toBe(403);
      expect(res.body.error).toBe('没有权限执行此操作');
    }
  });

  it('VIEWER 读接口开放 → 列表与种子条目 200', async () => {
    querySpy.mockImplementation(dbStub([auth('VIEWER', 2), { match: 'COUNT(*) AS chunk_count', rows: [] }]));
    const list = await request(app).get('/api/knowledge?dataSourceId=ds1').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(list.status).toBe(200);
    const seed = await request(app).get('/api/knowledge/seed-entries').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(seed.status).toBe(200);
  });
});

describe('GET /api/knowledge：知识文档列表（按 doc 聚合）', () => {
  it('缺少 dataSourceId → 400', async () => {
    const res = await request(app).get('/api/knowledge').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('成功 → 200 返回文档元信息（chunkCount 数值归一）', async () => {
    querySpy.mockImplementation(
      stub({
        match: 'COUNT(*) AS chunk_count',
        rows: [{ doc_id: 'kb_1', title: '指标口径', chunk_count: 3, created_by: 'admin', created_at: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    const res = await request(app).get('/api/knowledge?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.docs).toHaveLength(1);
    expect(res.body.docs[0]).toMatchObject({ docId: 'kb_1', title: '指标口径', chunkCount: 3, createdBy: 'admin' });
  });

  it('查询异常 → 500 查询知识库失败', async () => {
    querySpy.mockImplementation(stub({ match: 'COUNT(*) AS chunk_count', rows: boom }));
    const res = await request(app).get('/api/knowledge?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^查询知识库失败：/);
  });
});

describe('POST /api/knowledge：登记知识文档（ADMIN）', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/knowledge').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('缺少 dataSourceId → 400', async () => {
    const res = await post({ title: '指标口径', content: '不良率口径' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('标题为空 → 400 标题必填', async () => {
    const res = await post({ dataSourceId: 'ds1', title: '   ', content: '不良率口径' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('标题必填');
  });

  it('内容为空 → 400 内容必填', async () => {
    const res = await post({ dataSourceId: 'ds1', title: '指标口径', content: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('内容必填');
  });

  it('登记成功 → 200 返回新 docId 与切块数（embedding 降级不阻断）', async () => {
    querySpy.mockImplementation(stub({ match: 'INSERT INTO knowledge_base', rows: [] }));
    const res = await post({ dataSourceId: 'ds1', title: '指标口径', content: '不良率 = 不良余额 / 总余额' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.docId).toMatch(/^kb_/);
    expect(res.body.chunkCount).toBe(1);
    // 切块入库时 embedding 引擎不可用 → embedding_json 落 NULL，链路仍成功
    const insertParam = querySpy.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO knowledge_base'));
    expect(insertParam?.[1]).toEqual([
      expect.any(String),
      'ds1',
      '指标口径',
      '不良率 = 不良余额 / 总余额',
      null,
      'u1',
    ]);
  });

  it('切块入库异常 → 500 登记失败', async () => {
    querySpy.mockImplementation(stub({ match: 'INSERT INTO knowledge_base', rows: boom }));
    const res = await post({ dataSourceId: 'ds1', title: '指标口径', content: '不良率口径' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^登记失败：/);
  });
});

describe('GET /api/knowledge/seed-entries：预置知识条目', () => {
  it('成功 → 200 返回种子条目与数据源信息', async () => {
    const res = await request(app).get('/api/knowledge/seed-entries').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dataResourceInfo.dataSourceId).toBe(DATA_RESOURCE_DS_ID);
    expect(res.body.dataResourceInfo.knowledgeCount).toBe(res.body.knowledgeList.length);
    expect(res.body.knowledgeList.length).toBeGreaterThan(0);
    expect(res.body.knowledgeList[0]).toMatchObject({ fullContentAvailable: true });
  });
});

describe('GET /api/knowledge/export：导出备份（ADMIN）', () => {
  const exportRule = (rows: DbStubRule['rows']) => stub(
    { match: 'SELECT name FROM data_sources', rows: [{ name: '数据资源库' }] },
    { match: 'ORDER BY doc_id ASC', rows },
  );

  it('缺少 dataSourceId → 400', async () => {
    const res = await request(app).get('/api/knowledge/export').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 dataSourceId');
  });

  it('成功 → 200 JSON 附件，同一 doc 的切块聚合还原为完整原文', async () => {
    querySpy.mockImplementation(
      exportRule([
        { doc_id: 'kb_1', title: '指标口径', chunk_text: '不良率口径说明', created_by: 'admin', created_at: '2026-01-01T00:00:00.000Z' },
        { doc_id: 'kb_1', title: '指标口径', chunk_text: '补充说明', created_by: 'admin', created_at: '2026-01-01T00:00:00.000Z' },
      ]),
    );
    const res = await request(app).get('/api/knowledge/export?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toMatchObject({ version: '2.0', type: 'knowledge-docs', dataSourceId: 'ds1', dataSourceName: '数据资源库', docCount: 1 });
    expect(res.body.docs[0]).toMatchObject({ docId: 'kb_1', title: '指标口径', chunkCount: 2 });
    expect(res.body.docs[0].content).toContain('不良率口径说明');
  });

  it('导出异常 → 500 导出失败', async () => {
    querySpy.mockImplementation(exportRule(boom));
    const res = await request(app).get('/api/knowledge/export?dataSourceId=ds1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^导出失败：/);
  });
});

describe('POST /api/knowledge/import：导入备份（ADMIN）', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/knowledge/import').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  /** 目标数据源存在 + 库内无同名文档 */
  const dsRules: DbStubRule[] = [
    { match: 'SELECT id, name FROM data_sources', rows: [{ id: 'ds1', name: '数据资源库' }] },
    { match: 'SELECT DISTINCT title', rows: [] },
  ];
  const v2File = { type: 'knowledge-docs', dataSourceId: 'ds1', docs: [{ title: '指标口径', content: '不良率口径说明' }] };

  it('缺少 fileData → 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少 fileData（备份文件的 JSON 内容）');
  });

  it('mergeStrategy 非法 → 400', async () => {
    const res = await post({ fileData: v2File, mergeStrategy: 'replace' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('mergeStrategy 必须是 skip / overwrite / append');
  });

  it('文件格式无法识别 → 400', async () => {
    const res = await post({ fileData: { foo: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('无法识别的文件格式：应为知识库导出文件（含 docs 或 knowledgeBase 字段）');
  });

  it('文件内无有效文档 → 400（提示无效条数）', async () => {
    const res = await post({ fileData: { type: 'knowledge-docs', dataSourceId: 'ds1', docs: [{ title: '', content: '' }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('文件中没有可导入的有效知识文档');
    expect(res.body.error).toContain('（1 条缺少标题或内容）');
  });

  it('缺少目标数据源 → 400', async () => {
    const res = await post({ fileData: { type: 'knowledge-docs', docs: [{ title: '口径', content: '内容' }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('缺少目标数据源 dataSourceId（文件中也没有来源信息）');
  });

  it('目标数据源不存在 → 404', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT id, name FROM data_sources', rows: [] }));
    const res = await post({ fileData: v2File });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('目标数据源不存在：ds1');
  });

  it('dryRun 预检 → 200 统计新文档且不写库', async () => {
    querySpy.mockImplementation(stub(...dsRules));
    const res = await post({ fileData: v2File, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, dryRun: true, importedCount: 1, skippedCount: 0, updatedCount: 0, dataSourceName: '数据资源库' });
    expect(res.body.summary.newDocs).toBe(1);
    expect(querySpy.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO knowledge_base'))).toBe(false);
  });

  it('skip 策略同 title 冲突 → 跳过且不写库', async () => {
    querySpy.mockImplementation(stub(dsRules[0], { match: 'SELECT DISTINCT title', rows: [{ title: '指标口径' }] }));
    const res = await post({ fileData: v2File, mergeStrategy: 'skip' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 0, skippedCount: 1, updatedCount: 0 });
    expect(res.body.summary.conflictDocs).toBe(1);
    expect(querySpy.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO knowledge_base'))).toBe(false);
  });

  it('overwrite 策略同 title 冲突 → 先删旧块再重建（updatedCount 递增）', async () => {
    querySpy.mockImplementation(
      stub(
        dsRules[0],
        { match: 'SELECT DISTINCT title', rows: [{ title: '指标口径' }] },
        { match: 'DELETE FROM knowledge_base WHERE data_source_id', rows: [] },
        { match: 'INSERT INTO knowledge_base', rows: [] },
      ),
    );
    const res = await post({ fileData: v2File, mergeStrategy: 'overwrite' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 0, skippedCount: 0, updatedCount: 1 });
    const deleted = querySpy.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM knowledge_base WHERE data_source_id'));
    expect(deleted?.[1]).toEqual(['ds1', '指标口径']);
  });

  it('v1 旧格式（knowledgeBase 数组）兼容导入 → 200', async () => {
    querySpy.mockImplementation(stub(...dsRules, { match: 'INSERT INTO knowledge_base', rows: [] }));
    const res = await post({
      fileData: { dataResourceInfo: { dataSourceId: 'ds1' }, knowledgeBase: [{ title: '口径', content: '内容说明' }] },
      dryRun: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 1, dryRun: false, dataSourceId: 'ds1' });
  });

  it('导入过程异常 → 500 导入失败', async () => {
    querySpy.mockImplementation(stub(dsRules[0], { match: 'SELECT DISTINCT title', rows: boom }));
    const res = await post({ fileData: v2File });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^导入失败：/);
  });
});

describe('GET /api/knowledge/:docId：文档详情', () => {
  const detailRule = (rows: DbStubRule['rows']) => stub({ match: 'WHERE doc_id = ? ORDER BY id ASC', rows });

  it('文档不存在 → 404 知识文档不存在', async () => {
    querySpy.mockImplementation(detailRule([]));
    const res = await request(app).get('/api/knowledge/kb_missing').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('知识文档不存在');
  });

  it('成功 → 200 返回元信息与切块明细（按入库顺序编号）', async () => {
    querySpy.mockImplementation(
      detailRule([
        { doc_id: 'kb_1', data_source_id: 'ds1', title: '指标口径', chunk_text: '第一块', created_by: 'admin', created_at: '2026-01-01T00:00:00.000Z' },
        { doc_id: 'kb_1', data_source_id: 'ds1', title: '指标口径', chunk_text: '第二块', created_by: 'admin', created_at: '2026-01-01T00:00:00.000Z' },
      ]),
    );
    const res = await request(app).get('/api/knowledge/kb_1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.doc).toMatchObject({ docId: 'kb_1', dataSourceId: 'ds1', title: '指标口径', chunkCount: 2 });
    expect(res.body.doc.chunks).toEqual([
      { index: 1, text: '第一块' },
      { index: 2, text: '第二块' },
    ]);
  });

  it('查询异常 → 500 查询详情失败', async () => {
    querySpy.mockImplementation(detailRule(boom));
    const res = await request(app).get('/api/knowledge/kb_1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^查询详情失败：/);
  });
});

describe('PUT /api/knowledge/:docId：编辑文档（ADMIN）', () => {
  const put = (body: Record<string, unknown>) =>
    request(app).put('/api/knowledge/kb_1').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('标题为空 → 400 标题必填', async () => {
    const res = await put({ title: '', content: '内容' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('标题必填');
  });

  it('内容为空 → 400 内容必填', async () => {
    const res = await put({ title: '指标口径', content: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('内容必填');
  });

  it('文档不存在 → 404 知识文档不存在', async () => {
    querySpy.mockImplementation(stub({ match: 'SELECT data_source_id FROM knowledge_base WHERE doc_id', rows: [] }));
    const res = await put({ title: '指标口径', content: '更新后的口径' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('知识文档不存在');
  });

  it('编辑成功 → 200 复用原 docId 重新切块', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT data_source_id FROM knowledge_base WHERE doc_id', rows: [{ data_source_id: 'ds1' }] },
        { match: 'DELETE FROM knowledge_base WHERE doc_id = ?', rows: [] },
        { match: 'INSERT INTO knowledge_base', rows: [] },
      ),
    );
    const res = await put({ title: '指标口径v2', content: '更新后的口径说明' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, docId: 'kb_1', chunkCount: 1 });
    expect(querySpy.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM knowledge_base WHERE doc_id = ?'))).toBe(true);
  });

  it('保存异常 → 500 保存失败', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'SELECT data_source_id FROM knowledge_base WHERE doc_id', rows: [{ data_source_id: 'ds1' }] },
        { match: 'DELETE FROM knowledge_base WHERE doc_id = ?', rows: boom },
      ),
    );
    const res = await put({ title: '指标口径', content: '更新后的口径' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^保存失败：/);
  });
});

describe('DELETE /api/knowledge/:docId：删除文档（ADMIN）', () => {
  const del = () => request(app).delete('/api/knowledge/kb_1').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  const deleteRule = (rows: DbStubRule['rows']) => stub({ match: 'DELETE FROM knowledge_base WHERE doc_id = ?', rows });

  it('文档不存在（affectedRows=0）→ 404', async () => {
    querySpy.mockImplementation(deleteRule(resultSet({ affectedRows: 0 })));
    const res = await del();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('知识文档不存在');
  });

  it('删除成功 → 200 ok', async () => {
    querySpy.mockImplementation(deleteRule(resultSet({ affectedRows: 1 })));
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('删除异常 → 500 删除失败', async () => {
    querySpy.mockImplementation(deleteRule(boom));
    const res = await del();
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^删除失败：/);
  });
});
