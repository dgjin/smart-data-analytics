import { describe, expect, it } from 'vitest';
import {
  normalizeQueryResult,
  normalizeReport,
  safeParseJson,
  stripCodeFences,
} from './queryResultNormalizer';

describe('stripCodeFences', () => {
  it('剥离 ```json 代码围栏', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥离无语言标记的围栏', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('普通文本原样返回（trim）', () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('safeParseJson', () => {
  it('解析标准 JSON', () => {
    expect(safeParseJson('{"rows": []}')).toEqual({ rows: [] });
  });

  it('解析带围栏的 JSON', () => {
    expect(safeParseJson('```json\n{"rows": [1]}\n```')).toEqual({ rows: [1] });
  });

  it('从混杂文本中提取 JSON 对象', () => {
    expect(safeParseJson('这是分析结果：{"rows": []} 以上')).toEqual({ rows: [] });
  });

  it('完全无效的文本返回 null', () => {
    expect(safeParseJson('not json at all')).toBeNull();
  });

  it('JSON 标量（非对象）返回 null', () => {
    expect(safeParseJson('42')).toBeNull();
  });
});

describe('normalizeQueryResult', () => {
  const baseValid = {
    generatedSQL: 'SELECT 1',
    thoughtProcess: ['step1'],
    aiExplanation: '解释',
    keyInsights: ['洞察1'],
    chartConfig: {
      type: 'line',
      title: '趋势',
      xAxisKey: 'date',
      yAxisKeys: ['value'],
    },
    rows: [{ date: '2024-01', value: 100 }],
    suggestedQuestions: ['q1'],
  };

  it('接受标准 rows 字段', () => {
    const result = normalizeQueryResult(baseValid);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(1);
    expect(result!.columns).toEqual(['date', 'value']);
    expect(result!.totalCount).toBe(1);
    expect(result!.chartConfig?.type).toBe('line');
  });

  it('兼容 data 字段（历史数据契约断裂回归测试）', () => {
    const { rows: _rows, ...rest } = baseValid;
    const result = normalizeQueryResult({ ...rest, data: [{ date: '2024-01', value: 5 }] });
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([{ date: '2024-01', value: 5 }]);
    expect(result!.totalCount).toBe(1);
  });

  it('缺少 rows/data 时返回 null', () => {
    const { rows: _rows, ...rest } = baseValid;
    expect(normalizeQueryResult(rest)).toBeNull();
  });

  it('非对象输入返回 null', () => {
    expect(normalizeQueryResult(null)).toBeNull();
    expect(normalizeQueryResult('string')).toBeNull();
    expect(normalizeQueryResult(42)).toBeNull();
  });

  it('非法图表类型矫正为 bar', () => {
    const result = normalizeQueryResult({
      ...baseValid,
      chartConfig: { ...baseValid.chartConfig, type: 'hologram3d' },
    });
    expect(result!.chartConfig?.type).toBe('bar');
  });

  it('P2-B 新增图表类型 treemap/heatmap 透传不矫正', () => {
    for (const type of ['treemap', 'heatmap'] as const) {
      const result = normalizeQueryResult({
        ...baseValid,
        chartConfig: { ...baseValid.chartConfig, type },
      });
      expect(result!.chartConfig?.type).toBe(type);
    }
  });

  it('yAxisKeys 为空时 chartConfig 置为 null', () => {
    const result = normalizeQueryResult({
      ...baseValid,
      chartConfig: { type: 'bar', title: 't', xAxisKey: 'date', yAxisKeys: [] },
    });
    expect(result!.chartConfig).toBeNull();
  });

  it('过滤非对象行', () => {
    const result = normalizeQueryResult({
      ...baseValid,
      rows: [{ date: 'a', value: 1 }, null, 'bad', { date: 'b', value: 2 }],
    });
    expect(result!.rows).toHaveLength(2);
  });

  it('kpiMetrics 过滤无效项并矫正 trend', () => {
    const result = normalizeQueryResult({
      ...baseValid,
      kpiMetrics: [
        { label: 'GMV', value: 100, trend: 'up' },
        { value: 999 },
        { label: 'UV', value: 5, trend: 'exploding' },
      ],
    });
    expect(result!.kpiMetrics).toHaveLength(2);
    expect(result!.kpiMetrics![0].trend).toBe('up');
    expect(result!.kpiMetrics![1].trend).toBeUndefined();
  });

  it('suggestedQuestions 最多保留 5 条', () => {
    const result = normalizeQueryResult({
      ...baseValid,
      suggestedQuestions: ['1', '2', '3', '4', '5', '6', '7'],
    });
    expect(result!.suggestedQuestions).toHaveLength(5);
  });
});

describe('normalizeReport', () => {
  it('接受合法报告', () => {
    const result = normalizeReport({ title: '周报', summary: '概要', insights: [] });
    expect(result).not.toBeNull();
    expect(result!.kpiList).toEqual([]);
    expect(result!.charts).toEqual([]);
  });

  it('缺少 title 返回 null', () => {
    expect(normalizeReport({ summary: 's', insights: [] })).toBeNull();
  });

  it('缺少 summary 返回 null', () => {
    expect(normalizeReport({ title: 't', insights: [] })).toBeNull();
  });

  it('insights 与 charts 均缺失返回 null', () => {
    expect(normalizeReport({ title: 't', summary: 's' })).toBeNull();
  });

  it('非对象输入返回 null', () => {
    expect(normalizeReport(undefined)).toBeNull();
  });
});
