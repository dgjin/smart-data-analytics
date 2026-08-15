/**
 * M2 计划模式单测：计划解析校验、内存存储（TTL/越权/一次性消费/问题匹配由路由层负责）
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseQueryPlan,
  storePlan,
  consumePlan,
  hasPlan,
  pruneExpiredPlans,
  clearPlanStoreForTest,
  generateQueryPlan,
  QueryPlan,
} from './queryPlan';

vi.mock('./llmClient', () => ({
  callLLMJson: vi.fn(),
}));
import { callLLMJson } from './llmClient';

const TTL = 10 * 60 * 1000;

function samplePlan(id: string, now: number): QueryPlan {
  return {
    planId: id,
    question: '各部门销售额对比',
    understanding: '按部门聚合销售额',
    steps: [{ type: 'aggregate', title: '按部门聚合', description: 'SUM(amount) GROUP BY dept' }],
    relatedTables: ['sales'],
    complexity: 'simple',
  };
}

describe('parseQueryPlan', () => {
  it('解析合法计划并归一化字段', () => {
    const text = JSON.stringify({
      understanding: '统计各部门销售额',
      steps: [
        { type: 'filter', title: '过滤年份', description: '只取今年' },
        { type: 'aggregate', title: '聚合', description: '按部门求和', sql: 'SELECT dept, SUM(amount) FROM sales GROUP BY dept' },
      ],
      relatedTables: ['sales'],
      complexity: 'multi-step',
    });
    const plan = parseQueryPlan(text, 'q');
    expect(plan).not.toBeNull();
    expect(plan!.understanding).toBe('统计各部门销售额');
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[1].sql).toContain('SELECT');
    expect(plan!.complexity).toBe('multi-step');
    expect(plan!.planId).toMatch(/^plan_/);
  });

  it('非法 type 归一为 other，complexity 缺省为 simple', () => {
    const plan = parseQueryPlan(JSON.stringify({
      understanding: 'u',
      steps: [{ type: 'hacker', title: 't', description: 'd' }],
    }), 'q');
    expect(plan!.steps[0].type).toBe('other');
    expect(plan!.complexity).toBe('simple');
    expect(plan!.relatedTables).toEqual([]);
  });

  it('缺少 understanding 或 steps 时拒绝', () => {
    expect(parseQueryPlan(JSON.stringify({ steps: [{ title: 't' }] }), 'q')).toBeNull();
    expect(parseQueryPlan(JSON.stringify({ understanding: 'u', steps: [] }), 'q')).toBeNull();
    expect(parseQueryPlan('not json', 'q')).toBeNull();
  });

  it('步骤缺 title 时拒绝', () => {
    expect(parseQueryPlan(JSON.stringify({ understanding: 'u', steps: [{ type: 'filter' }] }), 'q')).toBeNull();
  });
});

describe('plan store', () => {
  const now = 1_000_000_000_000;

  it('存储后可被本人同数据源消费，且一次性删除', async () => {
    const plan = samplePlan('plan_case1_x', now);
    await storePlan(plan, 1, 'ds_a', now);
    expect(await hasPlan(plan.planId)).toBe(true);
    const res = await consumePlan(plan.planId, 1, 'ds_a', now);
    expect(res.ok).toBe(true);
    expect(await hasPlan(plan.planId)).toBe(false);
    // 重放被拒
    const replay = await consumePlan(plan.planId, 1, 'ds_a', now);
    expect(replay.ok).toBe(false);
  });

  it('过期计划被拒绝并清理', async () => {
    const plan = samplePlan('plan_case2_x', now);
    await storePlan(plan, 1, 'ds_a', now);
    const res = await consumePlan(plan.planId, 1, 'ds_a', now + TTL + 1);
    expect(res.ok).toBe(false);
    expect(String((res as any).reason)).toContain('过期');
    expect(await hasPlan(plan.planId)).toBe(false);
  });

  it('越权与数据源不匹配均拒绝（且计划不被消费）', async () => {
    const plan = samplePlan('plan_case3_x', now);
    await storePlan(plan, 1, 'ds_a', now);
    expect((await consumePlan(plan.planId, 2, 'ds_a', now)).ok).toBe(false);
    expect((await consumePlan(plan.planId, 1, 'ds_b', now)).ok).toBe(false);
    expect(await hasPlan(plan.planId)).toBe(true);
  });

  it('pruneExpiredPlans 清理过期条目', async () => {
    await clearPlanStoreForTest();
    const p1 = samplePlan('plan_case4_a', now);
    const p2 = samplePlan('plan_case4_b', now);
    await storePlan(p1, 1, 'ds_a', now);
    await storePlan(p2, 1, 'ds_a', now + TTL + 10);
    const removed = pruneExpiredPlans(now + TTL + 5);
    expect(removed).toBe(1);
    expect(await hasPlan(p1.planId)).toBe(false);
    expect(await hasPlan(p2.planId)).toBe(true);
  });
});

describe('generateQueryPlan', () => {
  it('LLM 输出合法时返回计划', async () => {
    (callLLMJson as any).mockResolvedValueOnce(JSON.stringify({
      understanding: 'u',
      steps: [{ type: 'aggregate', title: '聚合', description: 'd' }],
      relatedTables: ['t1'],
      complexity: 'simple',
    }));
    const plan = await generateQueryPlan('各部门销售额', []);
    expect(plan.steps).toHaveLength(1);
    expect(plan.question).toBe('各部门销售额');
  });

  it('LLM 输出非法时抛错', async () => {
    (callLLMJson as any).mockResolvedValueOnce('garbage');
    await expect(generateQueryPlan('q', [])).rejects.toThrow(/结构校验/);
  });
});
