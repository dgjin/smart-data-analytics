/**
 * liveQuery 工具层单测：
 * - buildColumnNames 防英文占位盖中文底（v0.9.39 铁律「表头必须中文」服务端兜底）
 * - sanitizeQueryResultChinese 问数结果表头/轴名/解读文案标识符中文化兜底（v0.9.39）
 */
import { describe, it, expect } from 'vitest';
import { buildColumnNames, inferChineseHeader, sanitizeQueryResultChinese } from './liveQueryUtils';
import type { SchemaTable } from './schemaTypes';

const TEST_SCHEMA = [
  {
    name: 'dn_tzsy',
    displayName: '当年投资收益',
    columns: [
      { name: 'JGMC', description: '机构名称' },
      { name: 'BNTFJE', description: '本年投放金额' },
      { name: 'no_cn_col', description: '' },
    ],
  },
] as unknown as SchemaTable[];

describe('buildColumnNames 防英文占位盖中文底（v0.9.39）', () => {
  const rows = [{ JGMC: '济南分行', BNTFJE: 100, total_amt: 200 }];

  it('schema description 为底，无 override 时生效', () => {
    const out = buildColumnNames(rows, TEST_SCHEMA);
    expect(out['JGMC']).toBe('机构名称');
    expect(out['BNTFJE']).toBe('本年投放金额');
  });

  it('LLM 中文 override 正常覆盖（聚合别名只有 LLM 知道）', () => {
    const out = buildColumnNames(rows, TEST_SCHEMA, undefined, { BNTFJE: '投放金额合计', total_amt: '总金额' });
    expect(out['BNTFJE']).toBe('投放金额合计');
    expect(out['total_amt']).toBe('总金额');
  });

  it('LLM 英文占位值不盖掉 schema 中文底（铁律核心场景）', () => {
    // LLM 把列名原样当表头值返回
    expect(buildColumnNames(rows, TEST_SCHEMA, { JGMC: 'JGMC' })['JGMC']).toBe('机构名称');
    // LLM 返回英文短语
    expect(buildColumnNames(rows, TEST_SCHEMA, { JGMC: 'Organization' })['JGMC']).toBe('机构名称');
  });

  it('英文 override 在无中文底时按词根推断转换（v0.9.42，不再原样上屏）', () => {
    // total_amt 词根全命中：total→合计 + amt→金额
    const out = buildColumnNames(rows, TEST_SCHEMA, { total_amt: 'Total Amount' });
    expect(out['total_amt']).toBe('合计金额');
  });
});

describe('inferChineseHeader 英文派生列词根推断（v0.9.42）', () => {
  it('蛇形命名全词根命中转换，pct/yoy/mom 补（%）后缀', () => {
    expect(inferChineseHeader('recovery_ratio_pct')).toBe('回收比率（%）');
    expect(inferChineseHeader('amount_yoy')).toBe('金额同比（%）');
    expect(inferChineseHeader('total_amt')).toBe('合计金额');
    expect(inferChineseHeader('avg_bal')).toBe('平均余额');
  });

  it('任一词根未识别返回 undefined（不编造中文名）', () => {
    expect(inferChineseHeader('abc_xyz')).toBeUndefined();
    expect(inferChineseHeader('recovery_unknown_col')).toBeUndefined();
  });

  it('非纯英文标识符（含中文/数字开头）不处理', () => {
    expect(inferChineseHeader('机构名称')).toBeUndefined();
    expect(inferChineseHeader('2024')).toBeUndefined();
  });

  it('buildColumnNames 集成：LLM 漏给表头的英文派生列自动推断，未识别保持原值', () => {
    const detailRows = [{ JGMC: '总部', BNTFJE: 28.1, recovery_ratio_pct: 1061.76, custom_xyz: 1 }];
    const out = buildColumnNames(detailRows, TEST_SCHEMA);
    expect(out['JGMC']).toBe('机构名称');
    expect(out['BNTFJE']).toBe('本年投放金额');
    expect(out['recovery_ratio_pct']).toBe('回收比率（%）');
    expect(out['custom_xyz']).toBeUndefined();
  });
});

describe('sanitizeQueryResultChinese（v0.9.39 铁律兜底）', () => {
  const makeResult = () => ({
    generatedSQL: 'SELECT JGMC, SUM(BNTFJE) FROM dn_tzsy GROUP BY JGMC',
    thoughtProcess: ['按 JGMC 分组', '对 BNTFJE 求和'],
    aiExplanation: 'dn_tzsy 表中 BNTFJE 合计为 7300 万',
    keyInsights: ['JGMC 维度下济南分行最高', 'BNTFJE 均值稳定'],
    chartConfig: {
      title: '各 JGMC 的 BNTFJE 对比',
      xAxisKey: 'JGMC',
      yAxisKeys: ['total'],
      yAxisNames: { total: 'BNTFJE 合计' },
      xAxisName: 'JGMC',
    },
    data: [{ JGMC: '济南分行', total: 7300 }],
    columnNames: { JGMC: 'JGMC', total: 'BNTFJE 合计' },
    kpiMetrics: [{ label: 'BNTFJE 总计', value: '7300万', subtext: '来自 dn_tzsy', change: 'BNTFJE +5%' }],
    suggestedQuestions: ['按 dn_tzsy 分年度看趋势？'],
    expertPersona: '金融分析师',
  });

  it('表头值/轴名/图表标题中的英文标识符替换为中文名', () => {
    const out = sanitizeQueryResultChinese(makeResult(), TEST_SCHEMA);
    expect(out.columnNames!['JGMC']).toBe('机构名称');
    expect(out.columnNames!['total']).toBe('本年投放金额 合计');
    expect(out.chartConfig.title).toBe('各 机构名称 的 本年投放金额 对比');
    expect(out.chartConfig.xAxisName).toBe('机构名称');
    expect(out.chartConfig.yAxisNames!['total']).toBe('本年投放金额 合计');
  });

  it('阶段二文案全字段中文化（解读/洞察/KPI/追问/推导过程）', () => {
    const out = sanitizeQueryResultChinese(makeResult(), TEST_SCHEMA);
    expect(out.aiExplanation).toBe('当年投资收益 表中 本年投放金额 合计为 7300 万');
    expect(out.keyInsights[0]).toBe('机构名称 维度下济南分行最高');
    expect(out.kpiMetrics[0].label).toBe('本年投放金额 总计');
    expect(out.kpiMetrics[0].subtext).toBe('来自 当年投资收益');
    expect(out.kpiMetrics[0].change).toBe('本年投放金额 +5%');
    expect(out.suggestedQuestions[0]).toBe('按 当年投资收益 分年度看趋势？');
    expect(out.thoughtProcess[0]).toBe('按 机构名称 分组');
    // KPI 数值字段不清洗（数值文本不含标识符，原样保留）
    expect(out.kpiMetrics[0].value).toBe('7300万');
  });

  it('schema 无任何中文映射时原样返回', () => {
    const r = makeResult();
    const out = sanitizeQueryResultChinese(r, [{ name: 't', displayName: '', columns: [] }] as unknown as SchemaTable[]);
    expect(out.aiExplanation).toBe(r.aiExplanation);
    expect(out.columnNames!['JGMC']).toBe('JGMC');
  });

  it('缺省字段安全（无 columnNames / kpiMetrics 非对象元素）', () => {
    const out = sanitizeQueryResultChinese(
      { aiExplanation: 'ok', kpiMetrics: [null, { label: 'JGMC' }] } as any,
      TEST_SCHEMA
    );
    expect(out.aiExplanation).toBe('ok');
    expect(out.kpiMetrics[0]).toBeNull();
    expect(out.kpiMetrics[1].label).toBe('机构名称');
  });
});
