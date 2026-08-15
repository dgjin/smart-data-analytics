/**
 * M4 报告计划批准单测：计划存储的一次性消费、过期、越权、数据源/模板不匹配拒绝。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeReportPlan,
  consumeReportPlan,
  clearReportPlanStoreForTest,
} from './liveReport';

const PLAN = {
  reportTitle: '测试简报',
  plans: [{ title: '图1', sql: 'SELECT 1', chartType: 'bar', xAxisKey: 'a', yAxisKeys: ['b'], purpose: '测试' }],
};
const META = { templateType: '综合经营分析', userId: 1, dataSourceId: 'ds_a' };

beforeEach(async () => {
  await clearReportPlanStoreForTest();
});

describe('storeReportPlan / consumeReportPlan', () => {
  it('合法消费成功且一次性（重放拒绝）', async () => {
    const now = Date.now();
    const id = await storeReportPlan(PLAN, META, now);
    const first = await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', now + 1000);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.plan.reportTitle).toBe('测试简报');
    expect(await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', now + 2000)).toEqual({
      ok: false,
      reason: '报告计划不存在或已使用，请重新制定',
    });
  });

  it('过期拒绝（10 分钟 TTL）', async () => {
    const now = Date.now();
    const id = await storeReportPlan(PLAN, META, now);
    const res = await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', now + 10 * 60 * 1000 + 1);
    expect(res).toEqual({ ok: false, reason: '报告计划已过期，请重新制定' });
  });

  it('越权 / 数据源不匹配 / 模板不匹配均拒绝', async () => {
    const now = Date.now();
    const mk = () => storeReportPlan(PLAN, META, now);
    expect((await consumeReportPlan(await mk(), 2, 'ds_a', '综合经营分析', now)).ok).toBe(false);
    expect((await consumeReportPlan(await mk(), 1, 'ds_b', '综合经营分析', now)).ok).toBe(false);
    expect((await consumeReportPlan(await mk(), 1, 'ds_a', '营销ROI评估', now)).ok).toBe(false);
  });

  it('伪造 planId 拒绝', async () => {
    expect((await consumeReportPlan('rplan_fake', 1, 'ds_a', '综合经营分析', Date.now())).ok).toBe(false);
  });
});
