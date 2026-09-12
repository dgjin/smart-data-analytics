import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseAgentPlan,
  generateAgentPlan,
  runAgentPlan,
  storeAgentPlan,
  consumeAgentPlan,
  hasAgentPlan,
  clearAgentPlanStoreForTest,
  newAgentPlanId,
  type AgentPlan,
  type AgentRunContext,
} from './orchestrator';
import { runLiveQuery } from '../query/liveQuery';
import { callLLMJson } from '../llm/llmClient';

vi.mock('../llm/llmClient', () => ({
  callLLMJson: vi.fn(),
}));

vi.mock('../query/liveQuery', () => ({
  runLiveQuery: vi.fn(),
}));

const mockedLlm = vi.mocked(callLLMJson);
const mockedQuery = vi.mocked(runLiveQuery);

const SCHEMA = [
  { name: 'loans', columns: [['month', 'varchar'], ['region', 'varchar'], ['bad_rate', 'decimal'], ['amount', 'decimal']] },
];

function makePlan(steps: { capability: string; goal: string; params?: Record<string, unknown> }[], understanding = '分析不良率走势'): AgentPlan {
  return {
    planId: newAgentPlanId(),
    question: '分析不良率',
    understanding,
    steps: steps.map((s, i) => ({ id: i + 1, capability: s.capability as any, goal: s.goal, params: (s.params ?? {}) as any })),
  };
}

const CTX: AgentRunContext = {
  userId: 1,
  username: 'admin',
  dataSourceId: 'ds_1',
  schema: SCHEMA as any,
  guidance: '',
  dsType: 'mysql',
  dataSourceName: '业务库',
  sensitiveRemoved: [],
  rowFilters: {},
  traceId: 'trace-1',
};

beforeEach(async () => {
  mockedLlm.mockReset();
  mockedQuery.mockReset();
  await clearAgentPlanStoreForTest();
});

describe('agent: 计划解析与校验', () => {
  it('合法计划：解析成功并归一化参数', () => {
    const plan = parseAgentPlan(
      JSON.stringify({
        understanding: '先查历史不良率再预测',
        steps: [
          { capability: 'query', goal: '按月查询不良率', params: {} },
          { capability: 'forecast', goal: '预测未来3期不良率', params: { xKey: 'month', yKey: 'bad_rate', periods: 3 } },
        ],
      }),
      '预测不良率',
    );
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[0].capability).toBe('query');
    expect(plan!.steps[1].params.periods).toBe(3);
  });

  it('query 不在首位：截断到首个 query 步', () => {
    const plan = parseAgentPlan(
      JSON.stringify({
        understanding: 'x',
        steps: [
          { capability: 'forecast', goal: '先预测（无数据）' },
          { capability: 'query', goal: '查数据' },
          { capability: 'forecast', goal: '再预测' },
        ],
      }),
      'q',
    );
    expect(plan!.steps.map((s) => s.capability)).toEqual(['query', 'forecast']);
  });

  it('无 query 步 / 非法能力 / 缺 understanding 均返回 null', () => {
    expect(parseAgentPlan(JSON.stringify({ understanding: 'x', steps: [{ capability: 'forecast', goal: 'g' }] }), 'q')).toBeNull();
    expect(parseAgentPlan(JSON.stringify({ steps: [{ capability: 'query', goal: 'g' }] }), 'q')).toBeNull();
    expect(parseAgentPlan('not json', 'q')).toBeNull();
    expect(
      parseAgentPlan(JSON.stringify({ understanding: 'x', steps: [{ capability: 'delete-all', goal: 'g' }, { capability: 'query', goal: 'g2' }] }), 'q'),
    ).toEqual(expect.objectContaining({ steps: [expect.objectContaining({ capability: 'query' })] }));
  });

  it('periods 归一化：越界夹取、非法丢弃', () => {
    const plan = parseAgentPlan(
      JSON.stringify({
        understanding: 'x',
        steps: [
          { capability: 'query', goal: 'g' },
          { capability: 'forecast', goal: 'g2', params: { periods: 999 } },
        ],
      }),
      'q',
    );
    expect(plan!.steps[1].params.periods).toBe(24);
  });
});

describe('agent: 计划存储一次性消费', () => {
  it('存入 → 读取 → 消费后消失；越权与数据源不匹配拒绝', async () => {
    const plan = makePlan([{ capability: 'query', goal: 'g' }]);
    await storeAgentPlan(plan, 7, 'ds_1');
    expect(await hasAgentPlan(plan.planId)).toBe(true);

    expect((await consumeAgentPlan(plan.planId, 8, 'ds_1')).ok).toBe(false); // 越权
    expect((await consumeAgentPlan(plan.planId, 7, 'ds_2')).ok).toBe(false); // 数据源不匹配
    expect(await hasAgentPlan(plan.planId)).toBe(true);

    const ok = await consumeAgentPlan(plan.planId, 7, 'ds_1');
    expect(ok.ok).toBe(true);
    expect(await hasAgentPlan(plan.planId)).toBe(false); // 一次性
    expect((await consumeAgentPlan(plan.planId, 7, 'ds_1')).ok).toBe(false);
  });
});

describe('agent: Executor 顺序执行', () => {
  it('query → forecast：用上游数据预测', async () => {
    mockedQuery.mockResolvedValueOnce({
      ok: true,
      result: { data: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${i + 1}`, bad_rate: 3 + i * 0.1 })) },
      executedSql: 'SELECT month, bad_rate FROM loans',
      rowCount: 12,
      retries: 0,
    });
    const plan = makePlan([
      { capability: 'query', goal: '按月查不良率' },
      { capability: 'forecast', goal: '预测未来3期', params: { xKey: 'month', yKey: 'bad_rate', periods: 3 } },
    ]);
    const out = await runAgentPlan(plan, CTX);
    expect(out.ok).toBe(true);
    expect(out.steps[0].sql).toContain('SELECT');
    expect(out.steps[1].forecast?.points).toHaveLength(3);
    expect(out.steps[1].forecast?.yKey).toBe('bad_rate');
    expect(out.steps[1].forecast?.xValues).toHaveLength(12);
  });

  it('query → attribution：按维度做两期贡献拆解', async () => {
    mockedQuery.mockResolvedValueOnce({
      ok: true,
      result: {
        data: [
          { 月份: '2026-01', 区域: '华东', 金额: 100 },
          { 月份: '2026-02', 区域: '华东', 金额: 150 },
          { 月份: '2026-01', 区域: '华南', 金额: 80 },
          { 月份: '2026-02', 区域: '华南', 金额: 60 },
        ],
      },
      executedSql: 'SELECT ...',
      rowCount: 4,
      retries: 0,
    });
    const plan = makePlan([
      { capability: 'query', goal: '按月份区域查金额' },
      { capability: 'attribution', goal: '归因金额变化', params: { dimKey: '区域', periodKey: '月份', metricKey: '金额' } },
    ]);
    const out = await runAgentPlan(plan, CTX);
    expect(out.ok).toBe(true);
    const attr = out.steps[1].attribution!;
    expect(attr.periods).toEqual(['2026-01', '2026-02']);
    expect(attr.total.delta).toBe(30); // (150+60) - (100+80)
    const hd = attr.items.find((i) => i.dims[0] === '华东')!;
    expect(hd.delta).toBe(50);
  });

  it('query 失败：后续分析步骤终止但返回部分结果', async () => {
    mockedQuery.mockResolvedValueOnce({ ok: false, error: 'SQL 执行失败' });
    const plan = makePlan([
      { capability: 'query', goal: '查数据' },
      { capability: 'forecast', goal: '预测', params: {} },
    ]);
    const out = await runAgentPlan(plan, CTX);
    expect(out.ok).toBe(false);
    expect(out.steps[0].ok).toBe(false);
    expect(out.steps[1].ok).toBe(false);
    expect(out.steps[1].error).toContain('上游');
    expect(out.finalSummary).toContain('成功 0 步');
  });

  it('attribution 缺少时期列：明确报错', async () => {
    mockedQuery.mockResolvedValueOnce({
      ok: true,
      result: { data: [{ 区域: '华东', 金额: 100 }, { 区域: '华南', 金额: 80 }] },
      executedSql: 'SELECT ...',
      rowCount: 2,
      retries: 0,
    });
    const plan = makePlan([
      { capability: 'query', goal: '查金额' },
      { capability: 'attribution', goal: '归因', params: { dimKey: '区域', metricKey: '金额' } },
    ]);
    const out = await runAgentPlan(plan, CTX);
    expect(out.steps[1].ok).toBe(false);
    expect(out.steps[1].error).toContain('时期列');
  });
});

describe('agent: Planner LLM 生成', () => {
  it('首轮合法即返回；非法输出纠偏重试一次', async () => {
    mockedLlm.mockResolvedValueOnce(
      JSON.stringify({ understanding: 'x', steps: [{ capability: 'query', goal: '查数据' }] }),
    );
    const plan = await generateAgentPlan('查一下', SCHEMA);
    expect(plan.steps).toHaveLength(1);

    mockedLlm.mockResolvedValueOnce('垃圾输出');
    mockedLlm.mockResolvedValueOnce(
      JSON.stringify({ understanding: 'y', steps: [{ capability: 'query', goal: '查数据' }] }),
    );
    const retryPlan = await generateAgentPlan('查一下', SCHEMA);
    expect(retryPlan.understanding).toBe('y');
    expect(mockedLlm).toHaveBeenCalledTimes(3);
  });

  it('两次均非法抛错', async () => {
    mockedLlm.mockResolvedValue('bad');
    await expect(generateAgentPlan('q', SCHEMA)).rejects.toThrow('结构校验');
  });
});
