/**
 * setup 路由契约测试（v0.9.84 首启初始化向导）：鉴权守卫 + 参数校验 + 业务码（400/404/409/429）+ 成功路径。
 * 业务层（setupWizard）与任务队列（taskQueue）全量 mock，仅验证 HTTP 契约与编排参数透传；
 * POST 写端点挂 rateLimiter（applyTestEnv 已调高阈值），GET 读/轮询端点不挂限流。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('../infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

/** 业务层与任务队列桩（vi.hoisted 保证 mock 工厂执行时已完成初始化） */
const h = vi.hoisted(() => ({
  getWizardState: vi.fn(),
  collectEnvSummary: vi.fn(),
  buildSummary: vi.fn(),
  saveStepResult: vi.fn(),
  probeLlm: vi.fn(),
  probeEmbedding: vi.fn(),
  getPipelineSnapshot: vi.fn(),
  setPipelineTask: vi.fn(),
  buildChecklist: vi.fn(),
  skipWizardReminder: vi.fn(),
  completeWizard: vi.fn(),
  getTask: vi.fn(),
  submitTask: vi.fn(),
}));
vi.mock('../setupWizard', () => ({
  getWizardState: h.getWizardState,
  collectEnvSummary: h.collectEnvSummary,
  buildSummary: h.buildSummary,
  saveStepResult: h.saveStepResult,
  probeLlm: h.probeLlm,
  probeEmbedding: h.probeEmbedding,
  getPipelineSnapshot: h.getPipelineSnapshot,
  setPipelineTask: h.setPipelineTask,
  buildChecklist: h.buildChecklist,
  skipWizardReminder: h.skipWizardReminder,
  completeWizard: h.completeWizard,
}));
vi.mock('../infra/taskQueue', () => ({ getTask: h.getTask, submitTask: h.submitTask }));

import setupRoutes from './setup';

applyTestEnv();

const app = buildApp('/api/setup', setupRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

/** authMiddleware 回查行（ADMIN） */
const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };

/** 流水线用例通用桩：无在途任务 + 指定数据源查询结果 */
const pipelineStub = (dsRows: unknown[]) =>
  dbStub([adminAuth, { match: 'FROM async_tasks', rows: [] }, { match: 'FROM data_sources', rows: dsRows }]);

beforeEach(() => {
  querySpy.mockReset();
  for (const fn of Object.values(h)) (fn as ReturnType<typeof vi.fn>).mockReset();
  querySpy.mockImplementation(dbStub([adminAuth]));
});

describe('鉴权与角色守卫（authMiddleware + requireRole(ADMIN)）', () => {
  it('缺少 token → 401', async () => {
    const res = await request(app).get('/api/setup/state');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('非 ADMIN 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'must_change_password FROM users WHERE id', rows: [activeUserRow('VIEWER', 9)] }]));
    const res = await request(app).get('/api/setup/state').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/setup/state：向导状态 + 环境汇总', () => {
  it('成功 → 状态与 env、summary 合并返回', async () => {
    h.getWizardState.mockResolvedValue({ status: 'in_progress', currentStep: 2, stepResults: { '2': { dataSourceId: 'ds_1' } }, pipelineTaskId: 'task_x' });
    h.collectEnvSummary.mockResolvedValue({ llm: { ok: true, engine: 'ollama' } });
    h.buildSummary.mockResolvedValue({ datasources: 2, tables: 10, chunks: 120, examples: 8 });
    const res = await request(app).get('/api/setup/state').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'in_progress', currentStep: 2, pipelineTaskId: 'task_x' });
    expect(res.body.env).toEqual({ llm: { ok: true, engine: 'ollama' } });
    expect(res.body.summary).toEqual({ datasources: 2, tables: 10, chunks: 120, examples: 8 });
  });

  it('业务层异常 → 500 兜底文案', async () => {
    h.getWizardState.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/setup/state').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('向导状态获取失败');
  });
});

describe('POST /api/setup/step：步骤结果快照', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/setup/step').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('step 越界/非整数 → 400（不落库）', async () => {
    const res = await post({ step: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('step 必须为 0..4 的整数');
    const res2 = await post({ step: 'abc' });
    expect(res2.status).toBe(400);
    expect(h.saveStepResult).not.toHaveBeenCalled();
  });

  it('成功 → 200 且以登录名记录发起人', async () => {
    h.saveStepResult.mockResolvedValue(undefined);
    const res = await post({ step: 2, result: { dataSourceId: 'ds_1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.saveStepResult).toHaveBeenCalledWith(2, { dataSourceId: 'ds_1' }, 'u1');
  });
});

describe('POST /api/setup/probe：单项探测', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/setup/probe').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('kind 非法 → 400', async () => {
    const res = await post({ kind: 'db' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('kind 必须为 llm 或 embedding');
  });

  it('kind=llm → 透传业务层结果', async () => {
    h.probeLlm.mockResolvedValue({ ok: true, engine: 'ollama', sample: 'PONG' });
    const res = await post({ kind: 'llm' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, engine: 'ollama', sample: 'PONG' });
    expect(h.probeLlm).toHaveBeenCalledTimes(1);
    expect(h.probeEmbedding).not.toHaveBeenCalled();
  });

  it('kind=embedding → 透传业务层结果（失败态 ok:false 也按 200 返回）', async () => {
    h.probeEmbedding.mockResolvedValue({ ok: false, error: 'model not found' });
    const res = await post({ kind: 'embedding' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'model not found' });
    expect(h.probeEmbedding).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/setup/pipeline：流水线任务创建', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/setup/pipeline').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('缺 dataSourceId → 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('dataSourceId 必填');
    expect(h.submitTask).not.toHaveBeenCalled();
  });

  it('已有在途任务 → 409 并回传在途 taskId（防并发覆盖快照）', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'FROM async_tasks', rows: [{ id: 'task_running' }] }]));
    const res = await post({ dataSourceId: 'ds_1' });
    expect(res.status).toBe(409);
    expect(res.body.taskId).toBe('task_running');
    expect(h.submitTask).not.toHaveBeenCalled();
  });

  it('数据源不存在 → 404', async () => {
    querySpy.mockImplementation(pipelineStub([]));
    const res = await post({ dataSourceId: 'ds_missing' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('数据源不存在');
    expect(h.submitTask).not.toHaveBeenCalled();
  });

  it('在途任务配额已满（submitTask 返回 null）→ 429', async () => {
    querySpy.mockImplementation(pipelineStub([{ id: 'ds_1', name: '演示库' }]));
    h.submitTask.mockResolvedValue(null);
    const res = await post({ dataSourceId: 'ds_1' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('在途任务过多，请稍后再试');
    expect(h.setPipelineTask).not.toHaveBeenCalled();
  });

  it('成功 → 提交 setup_pipeline 任务（含 user 快照/subtask）并登记 taskId', async () => {
    querySpy.mockImplementation(pipelineStub([{ id: 'ds_1', name: '演示库' }]));
    h.submitTask.mockResolvedValue({ taskId: 'task_x' });
    h.setPipelineTask.mockResolvedValue(undefined);
    const res = await post({ dataSourceId: 'ds_1', subtask: 'schema_collect' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: 'task_x' });
    expect(h.submitTask).toHaveBeenCalledWith(
      'setup_pipeline',
      {
        dataSourceId: 'ds_1',
        subtask: 'schema_collect',
        user: { id: 1, username: 'u1', role: 'ADMIN', department: '测试部' },
      },
      { id: 1, username: 'u1' },
    );
    expect(h.setPipelineTask).toHaveBeenCalledWith('task_x');
  });
});

describe('POST /api/setup/demo-data：演示数据集一键加载（Phase 2）', () => {
  const post = () => request(app).post('/api/setup/demo-data').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({});

  it('已有在途加载任务 → 409 并回传在途 taskId（防重复 DROP 重建）', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'setup_demo_data', rows: [{ id: 'task_loading' }] }]));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.taskId).toBe('task_loading');
    expect(h.submitTask).not.toHaveBeenCalled();
  });

  it('在途任务配额已满（submitTask 返回 null）→ 429', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'setup_demo_data', rows: [] }]));
    h.submitTask.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('在途任务过多，请稍后再试');
  });

  it('成功 → 提交 setup_demo_data 任务（含 user 快照）→ {taskId}', async () => {
    querySpy.mockImplementation(dbStub([adminAuth, { match: 'setup_demo_data', rows: [] }]));
    h.submitTask.mockResolvedValue({ taskId: 'task_demo' });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: 'task_demo' });
    expect(h.submitTask).toHaveBeenCalledWith(
      'setup_demo_data',
      { user: { id: 1, username: 'u1', role: 'ADMIN', department: '测试部' } },
      { id: 1, username: 'u1' },
    );
    expect(h.setPipelineTask).not.toHaveBeenCalled();
  });
});

describe('GET /api/setup/pipeline/:taskId：进度查询（轮询不限流）', () => {
  const get = (taskId: string) =>
    request(app).get(`/api/setup/pipeline/${taskId}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);

  it('任务不存在或类型不符 → 404', async () => {
    h.getTask.mockResolvedValue(null);
    let res = await get('task_none');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('任务不存在');

    h.getTask.mockResolvedValue({ id: 't2', type: 'report_generate', status: 'RUNNING' });
    res = await get('t2');
    expect(res.status).toBe(404);
  });

  it('成功 → 合并子任务快照；SUCCESS 时附 result', async () => {
    h.getTask.mockResolvedValue({ id: 'task_x', type: 'setup_pipeline', status: 'RUNNING', progress: '向量化 3/6', error: null, result: null });
    h.getPipelineSnapshot.mockResolvedValue({ subtasks: [{ key: 'schema_collect', status: 'success' }] });
    let res = await get('task_x');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ taskId: 'task_x', type: 'setup_pipeline', status: 'RUNNING', progress: '向量化 3/6' });
    expect(res.body.subtasks).toHaveLength(1);
    expect(res.body.result).toBeUndefined();

    h.getTask.mockResolvedValue({ id: 'task_x', type: 'setup_pipeline', status: 'SUCCESS', progress: '完成 6/6', error: null, result: { totals: { success: 6 } } });
    res = await get('task_x');
    expect(res.body.result).toEqual({ totals: { success: 6 } });
  });

  it('setup_demo_data 任务 → 进度文本透传，subtasks 为空（不读流水线快照）', async () => {
    h.getTask.mockResolvedValue({ id: 'task_demo', type: 'setup_demo_data', status: 'RUNNING', progress: '步骤 2/3：注册演示数据源', error: null, result: null });
    h.getPipelineSnapshot.mockResolvedValue({ subtasks: [{ key: 'stale' }] });
    const res = await get('task_demo');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ taskId: 'task_demo', type: 'setup_demo_data', status: 'RUNNING', progress: '步骤 2/3：注册演示数据源' });
    expect(res.body.subtasks).toEqual([]);
    expect(h.getPipelineSnapshot).not.toHaveBeenCalled();
  });
});

describe('GET /api/setup/checklist：待办清单', () => {
  it('成功 → 返回清单数组', async () => {
    h.buildChecklist.mockResolvedValue([{ key: 'iron_rules', title: '无待确认铁律', status: 'done', link: 'admin:rules' }]);
    const res = await request(app).get('/api/setup/checklist').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ key: 'iron_rules', status: 'done' });
  });
});

describe('POST /api/setup/skip / complete：状态收尾', () => {
  it('skip：缺省 7 天，显式天数透传', async () => {
    h.skipWizardReminder.mockResolvedValue(undefined);
    let res = await request(app).post('/api/setup/skip').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.skipWizardReminder).toHaveBeenLastCalledWith(7);

    res = await request(app).post('/api/setup/skip').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({ days: 30 });
    expect(res.body).toEqual({ ok: true });
    expect(h.skipWizardReminder).toHaveBeenLastCalledWith(30);
  });

  it('complete：以登录名记录完成人', async () => {
    h.completeWizard.mockResolvedValue(undefined);
    const res = await request(app).post('/api/setup/complete').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.completeWizard).toHaveBeenCalledWith('u1');
  });
});
