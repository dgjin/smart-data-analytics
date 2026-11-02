/**
 * liveQuery 工具层单测：
 * - buildColumnNames 防英文占位盖中文底（v0.9.39 铁律「表头必须中文」服务端兜底）
 * - sanitizeQueryResultChinese 问数结果表头/轴名/解读文案标识符中文化兜底（v0.9.39）
 */
import { describe, it, expect } from 'vitest';
import {
  applyAmountUnitToRows,
  buildColumnNames,
  detectSqlDivisor,
  inferChineseHeader,
  isAmountResultColumn,
  sanitizeQueryResultChinese,
} from './liveQueryUtils';
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

describe('金额单位确定性换算（v0.9.120 服务端兜底）', () => {
  it('detectSqlDivisor 只认单位白名单档位', () => {
    expect(detectSqlDivisor('ROUND(SUM(LJTFJE)/10000, 2)')).toBe(10000);
    expect(detectSqlDivisor('SUM(x)/1e8')).toBe(100000000);
    expect(detectSqlDivisor('SUM(x)*0.0001')).toBe(10000);
    // 非单位常量不动（季度 /3、占比 *100）
    expect(detectSqlDivisor('SUM(x)/3')).toBeNull();
    expect(detectSqlDivisor('SUM(x)*100.0')).toBeNull();
    expect(detectSqlDivisor('SUM(x)')).toBeNull();
  });

  it('isAmountResultColumn 命中金额列，排除比率列', () => {
    expect(isAmountResultColumn('ljtfje')).toBe(false); // 拼音缩写靠 amountKeys 声明，不靠关键词
    expect(isAmountResultColumn('total_amt')).toBe(true);
    expect(isAmountResultColumn('金额合计', '金额合计')).toBe(true);
    expect(isAmountResultColumn('profit_rate', '收益率')).toBe(false);
    expect(isAmountResultColumn('cnt', '笔数')).toBe(false);
  });

  it('模型漏换算：按界面选定单位补做（此前实测的真实缺陷场景）', () => {
    const out = applyAmountUnitToRows(
      [{ jgmc: '济南分行', ljtfje: 54505360000 }],
      { unit: '亿元', amountKeys: ['ljtfje'], sql: 'SELECT jgmc, ROUND(SUM(LJTFJE), 2) AS ljtfje FROM t GROUP BY jgmc' },
    );
    expect(out.applied).toBe(true);
    expect(out.adjustedColumns).toEqual(['ljtfje']);
    expect(out.rows[0].ljtfje).toBe(545.05);
  });

  it('模型已按约定换算：同档不重复除', () => {
    const out = applyAmountUnitToRows(
      [{ ljtfje_wan: 545.05 }],
      { unit: '万元', amountKeys: ['ljtfje_wan'], sql: 'SELECT ROUND(SUM(LJTFJE)/10000, 2) AS ljtfje_wan FROM t' },
    );
    expect(out.applied).toBe(true);
    expect(out.adjustedColumns).toEqual([]);
    expect(out.rows[0].ljtfje_wan).toBe(545.05);
  });

  it('模型用了其他档位：按「值 × 已用除数 ÷ 选定除数」纠正', () => {
    const out = applyAmountUnitToRows(
      [{ amt: 54505.36 }],
      { unit: '亿元', amountKeys: ['amt'], sql: 'SELECT ROUND(SUM(AMT)/10000, 2) AS amt FROM t' },
    );
    expect(out.adjustedColumns).toEqual(['amt']);
    expect(out.rows[0].amt).toBe(5.45);
  });

  it('选「元」时把模型多除的换算还原为原值', () => {
    const out = applyAmountUnitToRows(
      [{ amt: 545.05 }],
      { unit: '元', amountKeys: ['amt'], sql: 'SELECT ROUND(SUM(AMT)/100000000, 2) AS amt FROM t' },
    );
    expect(out.rows[0].amt).toBe(54505000000);
  });

  it('前序列的除数不影响后一列（表达式切片到最近逗号）', () => {
    const out = applyAmountUnitToRows(
      [{ dim: 'A', a_wan: 1.5, b: 200000 }],
      {
        unit: '万元',
        amountKeys: ['a_wan', 'b'],
        sql: 'SELECT dim, ROUND(SUM(a)/10000, 2) AS a_wan, ROUND(SUM(b), 2) AS b FROM t GROUP BY dim',
      },
    );
    expect(out.rows[0].a_wan).toBe(1.5); // 已换算不重复除
    expect(out.rows[0].b).toBe(20); // 漏换算补除
    expect(out.adjustedColumns).toEqual(['b']);
  });

  it('声明 amountKeys 时不再走关键词启发式（防误伤计数/占比）', () => {
    const out = applyAmountUnitToRows(
      [{ cnt: 120, total_amt: 500000000 }],
      { unit: '亿元', amountKeys: ['total_amt'], sql: 'SELECT COUNT(*) AS cnt, ROUND(SUM(AMT), 2) AS total_amt FROM t' },
    );
    expect(out.amountColumns).toEqual(['total_amt']);
    expect(out.rows[0].cnt).toBe(120);
    expect(out.rows[0].total_amt).toBe(5);
  });

  it('未声明 amountKeys 时按列名启发式识别，比率列永不换算', () => {
    const sql = 'SELECT ROUND(SUM(total_amt), 2) AS total_amt, ROUND(SUM(x)*100.0/t.tot, 2) AS pct FROM t GROUP BY t.dim';
    const out = applyAmountUnitToRows(
      [{ total_amt: 54505360000, pct: 32.1 }],
      { unit: '亿元', sql },
    );
    expect(out.rows[0].total_amt).toBe(545.05);
    expect(out.rows[0].pct).toBe(32.1);
    expect(out.amountColumns).toEqual(['total_amt']);
  });

  it('amountKeys 大小写不一致时仍按声明匹配', () => {
    const out = applyAmountUnitToRows(
      [{ TotalAmt: 500000000, cnt: 3 }],
      { unit: '亿元', amountKeys: ['totalamt'], sql: 'SELECT ROUND(SUM(AMT), 2) AS TotalAmt, COUNT(*) AS cnt FROM t' },
    );
    expect(out.amountColumns).toEqual(['TotalAmt']);
    expect(out.rows[0].TotalAmt).toBe(5);
    expect(out.rows[0].cnt).toBe(3);
  });

  it('amountKeys 全部匹配不上时退回关键词启发式（避免声明失败导致不换算）', () => {
    const out = applyAmountUnitToRows(
      [{ total_amt: 500000000 }],
      { unit: '亿元', amountKeys: ['not_exist_alias'], sql: 'SELECT ROUND(SUM(AMT), 2) AS total_amt FROM t' },
    );
    expect(out.amountColumns).toEqual(['total_amt']);
    expect(out.rows[0].total_amt).toBe(5);
  });

  it('无单位 / 空行 / 无数值列时原样返回', () => {
    const rows = [{ dim: 'A', amt: 1 }];
    expect(applyAmountUnitToRows(rows, {}).rows).toBe(rows);
    expect(applyAmountUnitToRows([], { unit: '亿元' }).applied).toBe(false);
    expect(applyAmountUnitToRows([{ dim: 'A' }], { unit: '亿元' }).applied).toBe(false);
  });
});
