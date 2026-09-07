/**
 * M4 报告计划批准单测：计划存储的一次性消费、过期、越权、数据源/模板不匹配拒绝。
 * v0.5.1 报表文案中文化：英文表名/列名 → 中文名映射构建与兜底替换。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeReportPlan,
  consumeReportPlan,
  clearReportPlanStoreForTest,
  buildIdentifierNameMap,
  replaceIdentifiersWithChinese,
  sanitizeReportNarrative,
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
    const first = await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', undefined, now + 1000);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.plan.reportTitle).toBe('测试简报');
    expect(await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', undefined, now + 2000)).toEqual({
      ok: false,
      reason: '报告计划不存在或已使用，请重新制定',
    });
  });

  it('过期拒绝（10 分钟 TTL）', async () => {
    const now = Date.now();
    const id = await storeReportPlan(PLAN, META, now);
    const res = await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', undefined, now + 10 * 60 * 1000 + 1);
    expect(res).toEqual({ ok: false, reason: '报告计划已过期，请重新制定' });
  });

  it('越权 / 数据源不匹配 / 模板不匹配均拒绝', async () => {
    const now = Date.now();
    const mk = () => storeReportPlan(PLAN, META, now);
    expect((await consumeReportPlan(await mk(), 2, 'ds_a', '综合经营分析')).ok).toBe(false);
    expect((await consumeReportPlan(await mk(), 1, 'ds_b', '综合经营分析')).ok).toBe(false);
    expect((await consumeReportPlan(await mk(), 1, 'ds_a', '营销ROI评估')).ok).toBe(false);
  });

  it('伪造 planId 拒绝', async () => {
    expect((await consumeReportPlan('rplan_fake', 1, 'ds_a', '综合经营分析')).ok).toBe(false);
  });

  it('v0.5.2 金额单位口径一致性：批准时单位与制定时不一致拒绝', async () => {
    const now = Date.now();
    // 制定时单位=万元
    const id = await storeReportPlan(PLAN, { ...META, amountUnit: '万元' }, now);
    // 批准时换成亿元 → 拒绝
    expect(await consumeReportPlan(id, 1, 'ds_a', '综合经营分析', '亿元', now + 1000)).toEqual({
      ok: false,
      reason: '金额单位与计划制定时不一致，请重新制定',
    });
    // 制定=万元、批准=万元 → 通过
    const id2 = await storeReportPlan(PLAN, { ...META, amountUnit: '万元' }, now);
    expect((await consumeReportPlan(id2, 1, 'ds_a', '综合经营分析', '万元', now + 1000)).ok).toBe(true);
    // 制定时未选单位、批准时也未选 → 通过
    const id3 = await storeReportPlan(PLAN, META, now);
    expect((await consumeReportPlan(id3, 1, 'ds_a', '综合经营分析', undefined, now + 1000)).ok).toBe(true);
    // 制定时未选单位、批准时选了单位 → 拒绝（口径互串防护）
    const id4 = await storeReportPlan(PLAN, META, now);
    expect((await consumeReportPlan(id4, 1, 'ds_a', '综合经营分析', '亿元', now + 1000)).ok).toBe(false);
  });
});

const TEST_SCHEMA = [
  {
    name: 'dn_tzsy',
    displayName: '当年投资收益',
    columns: [
      { name: 'BNTFJE', description: '本年投放金额' },
      { name: 'org_name', description: '机构名称' },
      { name: 'no_cn_col', description: '' },
    ],
  },
  {
    name: 'fct_main',
    displayName: '',
    columns: [{ name: 'amt', description: '金额' }],
  },
];

describe('v0.5.1 buildIdentifierNameMap', () => {
  it('表名映射到 displayName，列名映射到 description', () => {
    const map = buildIdentifierNameMap(TEST_SCHEMA);
    expect(map['dn_tzsy']).toBe('当年投资收益');
    expect(map['BNTFJE']).toBe('本年投放金额');
    expect(map['org_name']).toBe('机构名称');
    expect(map['amt']).toBe('金额');
  });

  it('无中文名的表/列不生成映射', () => {
    const map = buildIdentifierNameMap(TEST_SCHEMA);
    expect(map['fct_main']).toBeUndefined();
    expect(map['no_cn_col']).toBeUndefined();
  });
});

describe('v0.5.1 replaceIdentifiersWithChinese', () => {
  const map = buildIdentifierNameMap(TEST_SCHEMA);

  it('【dn_tzsy】连同书名号一起替换为中文名', () => {
    expect(replaceIdentifiersWithChinese('基于【dn_tzsy】表的分析', map)).toBe('基于当年投资收益表的分析');
  });

  it('裸标识符带边界替换，不误伤包含关系', () => {
    expect(replaceIdentifiersWithChinese('dn_tzsy 的数据', map)).toBe('当年投资收益 的数据');
    // dn_tzsy2 / xdn_tzsy 不应被替换（边界保护）
    expect(replaceIdentifiersWithChinese('dn_tzsy2 与 xdn_tzsy', map)).toBe('dn_tzsy2 与 xdn_tzsy');
  });

  it('列名同样替换（如 BNTFJE → 本年投放金额）', () => {
    expect(replaceIdentifiersWithChinese('BNTFJE 合计为 7300 万', map)).toBe('本年投放金额 合计为 7300 万');
  });

  it('长标识符优先替换，避免短名残留', () => {
    const m = { dn: '短名', dn_tzsy: '当年投资收益' };
    expect(replaceIdentifiersWithChinese('查询 dn_tzsy', m)).toBe('查询 当年投资收益');
  });

  it('空文本 / 空映射原样返回', () => {
    expect(replaceIdentifiersWithChinese('', map)).toBe('');
    expect(replaceIdentifiersWithChinese('文本', {})).toBe('文本');
  });
});

describe('v0.5.1 sanitizeReportNarrative', () => {
  it('title/summary/insights/kpiList/charts 全字段中文化', () => {
    const raw = {
      title: 'dn_tzsy 经营分析',
      summary: '基于【dn_tzsy】表，BNTFJE 合计 7300 万。',
      insights: [{ title: 'dn_tzsy 洞察', type: 'info', content: 'org_name 分布均衡', actionItem: '关注 dn_tzsy' }],
      kpiList: [{ label: 'BNTFJE 总额', value: '7300万', change: '', status: 'neutral' }],
      charts: [{ title: 'dn_tzsy 趋势图', commentary: 'dn_tzsy 数据稳定' }],
    };
    const out = sanitizeReportNarrative(raw, TEST_SCHEMA);
    expect(out.title).toBe('当年投资收益 经营分析');
    expect(out.summary).toBe('基于当年投资收益表，本年投放金额 合计 7300 万。');
    expect(out.insights[0].title).toBe('当年投资收益 洞察');
    expect(out.insights[0].content).toBe('机构名称 分布均衡');
    expect(out.insights[0].actionItem).toBe('关注 当年投资收益');
    expect(out.kpiList[0].label).toBe('本年投放金额 总额');
    expect(out.charts[0].title).toBe('当年投资收益 趋势图');
    expect(out.charts[0].commentary).toBe('当年投资收益 数据稳定');
  });

  it('无映射时报告原样返回', () => {
    const raw = { title: 'dn_tzsy 报告', summary: '内容', charts: [] };
    expect(sanitizeReportNarrative(raw, [{ name: 't1', columns: [] }])).toEqual(raw);
  });
});
