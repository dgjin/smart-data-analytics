import { describe, expect, it } from 'vitest';
import { parseWhatIfPlan, compareOutcomes, summarizeComparison } from './whatIf';

const BASE_SQL = "SELECT region, SUM(amount) AS total FROM loans WHERE status = 'active' GROUP BY region";

describe('whatIf: 情景推演解析与校验', () => {
  it('合法输出：解析成功并规范化字段', () => {
    const plan = parseWhatIfPlan(
      JSON.stringify({
        scenarioSql: "SELECT region, SUM(amount) AS total FROM loans WHERE status = 'active' AND region != '华东' GROUP BY region",
        explanation: '模拟收紧华东区域投放',
        parameterChanges: [{ column: 'region', from: '全部区域', to: '排除华东', description: '剔除华东' }],
      }),
      BASE_SQL,
    );
    expect(plan).not.toBeNull();
    expect(plan!.explanation).toBe('模拟收紧华东区域投放');
    expect(plan!.parameterChanges).toHaveLength(1);
    expect(plan!.parameterChanges[0].column).toBe('region');
  });

  it('非 JSON / 缺字段输出返回 null', () => {
    expect(parseWhatIfPlan('不是 JSON', BASE_SQL)).toBeNull();
    expect(parseWhatIfPlan(JSON.stringify({ explanation: 'x' }), BASE_SQL)).toBeNull();
    expect(parseWhatIfPlan(JSON.stringify({ scenarioSql: 'SELECT 1', explanation: '' }), BASE_SQL)).toBeNull();
  });

  it('非 SELECT 语句与危险关键字均拒绝', () => {
    expect(parseWhatIfPlan(JSON.stringify({ scenarioSql: 'DELETE FROM loans', explanation: 'x' }), BASE_SQL)).toBeNull();
    expect(
      parseWhatIfPlan(
        JSON.stringify({ scenarioSql: "SELECT * FROM loans WHERE 1=1; DROP TABLE loans", explanation: 'x' }),
        BASE_SQL,
      ),
    ).toBeNull();
    expect(
      parseWhatIfPlan(
        JSON.stringify({ scenarioSql: "SELECT * FROM loans INTO OUTFILE '/tmp/x'", explanation: 'x' }),
        BASE_SQL,
      ),
    ).toBeNull();
  });

  it('与原 SQL 实质相同（仅空白差异）拒绝', () => {
    expect(
      parseWhatIfPlan(JSON.stringify({ scenarioSql: BASE_SQL.replace(/\s+/g, '  '), explanation: 'x' }), BASE_SQL),
    ).toBeNull();
  });

  it('parameterChanges 缺省或非法项被过滤', () => {
    const plan = parseWhatIfPlan(
      JSON.stringify({
        scenarioSql: "SELECT region FROM loans WHERE region = '华南'",
        explanation: 'x',
        parameterChanges: [null, 'bad', { column: 'region', from: 'a', to: 'b' }],
      }),
      BASE_SQL,
    );
    expect(plan).not.toBeNull();
    expect(plan!.parameterChanges).toHaveLength(1);
  });
});

describe('whatIf: 结果对比', () => {
  it('数值列 sum/avg 对比与变化率', () => {
    const rows = compareOutcomes(
      [{ region: '华东', total: 100 }, { region: '华南', total: 60 }],
      [{ region: '华东', total: 80 }, { region: '华南', total: 60 }],
    );
    const total = rows.find((r) => r.column === 'total')!;
    expect(total.before).toEqual({ sum: 160, avg: 80 });
    expect(total.after).toEqual({ sum: 140, avg: 70 });
    expect(total.delta).toEqual({ sum: -20, avg: -10 });
    expect(total.deltaPct.sum).toBeCloseTo(-12.5, 2);
    // region 为文本列：自动跳过
    expect(rows.some((r) => r.column === 'region')).toBe(false);
  });

  it('两组行数不同：sum 与 avg 口径分离', () => {
    const rows = compareOutcomes([{ v: 10 }, { v: 10 }], [{ v: 10 }, { v: 10 }, { v: 10 }]);
    const v = rows[0];
    expect(v.before.sum).toBe(20);
    expect(v.after.sum).toBe(30);
    expect(v.deltaPct.sum).toBe(50);
    expect(v.deltaPct.avg).toBe(0);
  });

  it('基准为 0 时变化率为 null；空组返回空数组', () => {
    const rows = compareOutcomes([{ v: 0 }], [{ v: 5 }]);
    expect(rows[0].deltaPct.sum).toBeNull();
    expect(compareOutcomes([], [{ v: 1 }])).toEqual([]);
  });

  it('数字字符串列可参与对比，纯文本列跳过', () => {
    const rows = compareOutcomes([{ v: '12', name: '甲' }], [{ v: '15', name: '乙' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].column).toBe('v');
    expect(rows[0].delta.sum).toBe(3);
  });

  it('摘要：无变化列与行数变化列的中文表达', () => {
    const noChange = summarizeComparison(compareOutcomes([{ v: 5 }], [{ v: 5 }]));
    expect(noChange[0]).toContain('无变化');
    const shifted = summarizeComparison(compareOutcomes([{ v: 10 }, { v: 10 }], [{ v: 10 }, { v: 10 }, { v: 10 }]));
    expect(shifted[0]).toContain('合计');
    expect(shifted[0]).toContain('均值');
    expect(summarizeComparison([])[0]).toContain('无可对比');
  });
});
