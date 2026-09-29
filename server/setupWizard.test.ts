/**
 * v0.9.84 首启初始化向导业务层单测（server/setupWizard.ts）：
 * 状态读写（单行表/断点快照）/ 探测降级（LLM 与 Embedding 失败不抛错）/ 环境汇总 / 待办清单五项组装。
 * mock 约定与 autoKnowledgeSync.test.ts 一致（vi.mock infra 与 llm 模块，查询桩按 SQL 分派）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const querySpy = vi.fn();
vi.mock('./infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('./infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./infra/health', () => ({
  runReadiness: async () => ({ ok: true, status: 'ok', checks: { mysql: { ok: true, ms: 3 } }, timestamp: '2026-09-29T00:00:00.000Z' }),
  buildDefaultProbes: () => [],
}));
const callLLMTextMock = vi.fn();
vi.mock('./llm/llmClient', () => ({
  llmEngineInfo: () => ({ engine: 'ollama', model: 'qwen3:8b', label: 'Ollama qwen3:8b' }),
  callLLMText: (...args: unknown[]) => callLLMTextMock(...args),
}));
const callEmbeddingMock = vi.fn();
vi.mock('./llm/llmEmbedding', () => ({
  currentEmbedModelId: () => 'bge-m3',
  callEmbedding: (...args: unknown[]) => callEmbeddingMock(...args),
}));
const isDemoLoadedMock = vi.fn();
vi.mock('./setupDemoData', () => ({ isDemoDataSetLoaded: () => isDemoLoadedMock() }));

import {
  buildChecklist,
  buildSummary,
  collectEnvSummary,
  completeWizard,
  getWizardState,
  probeEmbedding,
  probeLlm,
  saveStepResult,
  skipWizardReminder,
} from './setupWizard';

/** 按 SQL 分派行集；未命中返回空行集 */
function mockPool(handler?: (sql: string, params?: unknown[]) => unknown) {
  querySpy.mockImplementation(async (sql: string, params?: unknown[]) => {
    const out = handler ? handler(sql, params) : undefined;
    if (out !== undefined) return out;
    return [[]];
  });
}

const stateRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  status: 'in_progress',
  current_step: 2,
  step_results: { '0': { passed: true }, '2': { dataSourceId: 'ds_1' } },
  pipeline_task_id: 'task_abc',
  skipped_until: null,
  started_by: 'admin',
  completed_at: null,
  updated_at: new Date('2026-09-29T08:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  querySpy.mockReset();
  callLLMTextMock.mockReset();
  callEmbeddingMock.mockReset();
  isDemoLoadedMock.mockReset();
});

describe('getWizardState：单行状态读取', () => {
  it('行存在 → 结构化输出（step_results 对象直读 + 时间转 ISO）', async () => {
    mockPool((sql) => (sql.includes('SELECT * FROM setup_wizard_state') ? [[stateRow()]] : undefined));
    const st = await getWizardState();
    expect(st).toMatchObject({ status: 'in_progress', currentStep: 2, pipelineTaskId: 'task_abc', startedBy: 'admin' });
    expect(st.stepResults).toEqual({ '0': { passed: true }, '2': { dataSourceId: 'ds_1' } });
    expect(st.updatedAt).toBe('2026-09-29T08:00:00.000Z');
  });

  it('step_results 为字符串 JSON → 解析；非法 JSON → 空对象不抛错', async () => {
    mockPool((sql) => (sql.includes('SELECT * FROM setup_wizard_state') ? [[stateRow({ step_results: '{"1":{"note":"x"}}' })]] : undefined));
    expect((await getWizardState()).stepResults).toEqual({ '1': { note: 'x' } });

    mockPool((sql) => (sql.includes('SELECT * FROM setup_wizard_state') ? [[stateRow({ step_results: '{bad json' })]] : undefined));
    expect((await getWizardState()).stepResults).toEqual({});
  });

  it('行为空 → 惰性补种并返回默认值', async () => {
    let inserted = false;
    mockPool((sql) => {
      if (sql.includes('SELECT * FROM setup_wizard_state')) return [[]];
      if (sql.includes('INSERT IGNORE INTO setup_wizard_state')) {
        inserted = true;
        return [{ affectedRows: 1 }];
      }
      return undefined;
    });
    const st = await getWizardState();
    expect(inserted).toBe(true);
    expect(st).toMatchObject({ status: 'pending', currentStep: 0, pipelineTaskId: null, stepResults: {} });
  });
});

describe('saveStepResult：步骤快照（JSON_SET 原子更新，断点续做基础）', () => {
  it('SQL 使用 JSON_SET/COALESCE/GREATEST，路径与参数正确', async () => {
    mockPool(() => [{ affectedRows: 1 }]);
    await saveStepResult(2, { dataSourceId: 'ds_1' }, 'admin');
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('JSON_SET(COALESCE(step_results, JSON_OBJECT())');
    expect(sql).toContain('CAST(? AS JSON)');
    expect(sql).toContain('GREATEST(current_step');
    expect(sql).toContain("status = IF(status = 'pending', 'in_progress', status)");
    expect(params).toEqual(['$."2"', JSON.stringify({ dataSourceId: 'ds_1' }), 2, 'admin']);
  });

  it('越界 step 收窄到 0..4', async () => {
    mockPool(() => [{ affectedRows: 1 }]);
    await saveStepResult(9, {}, 'admin');
    expect((querySpy.mock.calls[0] as [string, unknown[]])[1][0]).toBe('$."4"');
    await saveStepResult(-3, {}, 'admin');
    expect((querySpy.mock.calls[1] as [string, unknown[]])[1][0]).toBe('$."0"');
  });
});

describe('probeLlm / probeEmbedding：探测（失败降级为 ok:false，不抛错）', () => {
  it('LLM 成功 → ok + 引擎信息 + 样本', async () => {
    callLLMTextMock.mockResolvedValue('PONG');
    const r = await probeLlm();
    expect(r).toMatchObject({ ok: true, engine: 'ollama', model: 'qwen3:8b', label: 'Ollama qwen3:8b', sample: 'PONG' });
    expect(typeof r.latencyMs).toBe('number');
  });

  it('LLM 失败 → ok:false + 错误原因', async () => {
    callLLMTextMock.mockRejectedValue(new Error('Ollama 不可达'));
    const r = await probeLlm();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Ollama 不可达');
  });

  it('Embedding 成功 → dims 为向量长度', async () => {
    callEmbeddingMock.mockResolvedValue([0.1, 0.2, 0.3]);
    const r = await probeEmbedding();
    expect(r).toMatchObject({ ok: true, model: 'bge-m3', dims: 3 });
  });

  it('Embedding 失败 → ok:false（走既有词法降级链）', async () => {
    callEmbeddingMock.mockRejectedValue(new Error('model not found'));
    const r = await probeEmbedding();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('model not found');
  });
});

describe('collectEnvSummary：环境汇总（GET /state env 字段）', () => {
  it('聚合 LLM/Embedding/数据源统计/健康探测', async () => {
    mockPool((sql) => {
      if (sql.includes('AS total')) return [[{ total: 5, connected: 3 }]];
      return undefined;
    });
    isDemoLoadedMock.mockResolvedValue(true);
    const env = await collectEnvSummary();
    expect(env.llm).toMatchObject({ engine: 'ollama', model: 'qwen3:8b' });
    expect(env.embedding.model).toBe('bge-m3');
    expect(env.datasources).toEqual({ total: 5, connected: 3, demoLoaded: true });
    expect(env.health.ok).toBe(true);
  });

  it('演示数据集未加载 → demoLoaded=false（Step① 信息态引导）', async () => {
    mockPool((sql) => (sql.includes('AS total') ? [[{ total: 0, connected: 0 }]] : undefined));
    isDemoLoadedMock.mockResolvedValue(false);
    expect((await collectEnvSummary()).datasources.demoLoaded).toBe(false);
  });
});

describe('buildChecklist：待办清单五项组装', () => {
  const checklistPool = (over: { rules?: number; chunks?: number; entries?: number; examples?: number; cap?: unknown[] } = {}) =>
    mockPool((sql) => {
      if (sql.includes('FROM iron_rules')) return [[{ cnt: over.rules ?? 0 }]];
      if (sql.includes('FROM knowledge_base_entries')) return [[{ cnt: over.entries ?? 0 }]];
      if (sql.includes('FROM knowledge_base')) return [[{ cnt: over.chunks ?? 0 }]];
      if (sql.includes('FROM sql_examples')) return [[{ cnt: over.examples ?? 0 }]];
      if (sql.includes('anomaly_capabilities_json')) return [over.cap ?? []];
      return undefined;
    });

  it('空态：无待确认铁律=done，阈值/知识=todo，Embedding/样例=warn', async () => {
    callEmbeddingMock.mockRejectedValue(new Error('未安装 embedding 模型'));
    checklistPool();
    const items = await buildChecklist();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.status]));
    expect(byKey).toEqual({ iron_rules: 'done', thresholds: 'todo', embedding: 'warn', knowledge: 'todo', examples: 'warn' });
    expect(items.find((i) => i.key === 'embedding')?.detail).toContain('未安装 embedding 模型');
  });

  it('就绪态：阈值启用/有知识有样例/Embedding 可用 → 正确映射', async () => {
    callEmbeddingMock.mockResolvedValue([0.1, 0.2]);
    checklistPool({
      rules: 2,
      chunks: 12,
      entries: 4,
      examples: 6,
      cap: [{ anomaly_capabilities_json: JSON.stringify({ domainThresholds: { enabled: true } }) }],
    });
    const items = await buildChecklist();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.status]));
    expect(byKey).toEqual({ iron_rules: 'todo', thresholds: 'done', embedding: 'done', knowledge: 'done', examples: 'done' });
    expect(items.find((i) => i.key === 'iron_rules')?.title).toContain('2 条');
  });

  it('样例存在但向量切片为空 → examples 降级 warn', async () => {
    callEmbeddingMock.mockResolvedValue([0.1, 0.2]);
    checklistPool({ rules: 0, chunks: 0, entries: 1, examples: 3 });
    const items = await buildChecklist();
    expect(items.find((i) => i.key === 'examples')?.status).toBe('warn');
  });
});

describe('buildSummary：向导成果数字（Step⑤ 总结卡）', () => {
  it('数据源/表/切片/样例汇总（tables 非数值兜底 0）', async () => {
    mockPool((sql) => {
      if (sql.includes('FROM data_sources')) return [[{ cnt: 2, tables: 10 }]];
      if (sql.includes('FROM knowledge_base')) return [[{ cnt: 120 }]];
      if (sql.includes('FROM sql_examples')) return [[{ cnt: 8 }]];
      return undefined;
    });
    expect(await buildSummary()).toEqual({ datasources: 2, tables: 10, chunks: 120, examples: 8 });

    mockPool((sql) => {
      if (sql.includes('FROM data_sources')) return [[{ cnt: 1, tables: null }]];
      if (sql.includes('FROM knowledge_base')) return [[{ cnt: 0 }]];
      if (sql.includes('FROM sql_examples')) return [[{ cnt: 0 }]];
      return undefined;
    });
    expect((await buildSummary()).tables).toBe(0);
  });
});

describe('skipWizardReminder / completeWizard：状态收尾', () => {
  it('skip：天数收窄到 1..365（缺省 7）', async () => {
    mockPool(() => [{ affectedRows: 1 }]);
    await skipWizardReminder(30);
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DATE_ADD(NOW(), INTERVAL ? DAY)');
    expect(params).toEqual([30]);
    await skipWizardReminder(999);
    expect((querySpy.mock.calls[1] as [string, unknown[]])[1]).toEqual([365]);
    await skipWizardReminder(0);
    expect((querySpy.mock.calls[2] as [string, unknown[]])[1]).toEqual([7]);
  });

  it('complete：status 置 completed 并记录发起人', async () => {
    mockPool(() => [{ affectedRows: 1 }]);
    await completeWizard('admin');
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'completed'");
    expect(params).toEqual(['admin']);
  });
});
