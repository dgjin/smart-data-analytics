import { describe, it, expect } from 'vitest';
import { buildQueryPlaceholder, generateSchemaSuggestions } from './querySuggestions';
import { TableSchema } from '../types/analytics';

const salesTable: TableSchema = {
  id: 't_sales',
  name: 'sales',
  displayName: '销售明细表',
  description: '',
  rowCount: 100,
  columns: [
    { name: 'id', type: 'number', isPrimaryKey: true },
    { name: 'order_date', type: 'date', description: '下单日期', isDimension: true },
    { name: 'region', type: 'category', description: '大区 (华东/华南)', isDimension: true },
    { name: 'amount', type: 'number', description: '销售金额(元)', isMetric: true },
    { name: 'qty', type: 'number', description: '数量', isMetric: true },
  ],
};

const visitTable: TableSchema = {
  id: 't_visit',
  name: 'visits',
  displayName: '客户拜访记录',
  description: '',
  rowCount: 50,
  columns: [
    { name: 'visit_month', type: 'category', description: '拜访月份', isDimension: true },
    { name: 'count', type: 'number', description: '拜访次数', isMetric: true },
  ],
};

describe('generateSchemaSuggestions', () => {
  it('基于真实标注生成趋势/对比/TopN/占比等多意图提示', () => {
    const out = generateSchemaSuggestions([salesTable]);
    expect(out).toContain('分析 销售明细表 的 销售金额 按 下单日期 的变化趋势');
    expect(out).toContain('对比 销售明细表 不同 下单日期 的 销售金额');
    expect(out).toContain('查询 销售明细表 中 销售金额 最高的前10个 下单日期');
    expect(out).toContain('统计 销售明细表 各 下单日期 的 销售金额 占比');
  });

  it('列标签剥掉括号注释（单位/枚举说明）', () => {
    const out = generateSchemaSuggestions([salesTable]);
    expect(out.every((s) => !s.includes('(元)') && !s.includes('(华东/华南)'))).toBe(true);
  });

  it('多表时第一轮保证每张表都有主推荐', () => {
    const out = generateSchemaSuggestions([salesTable, visitTable]);
    expect(out.some((s) => s.includes('销售明细表'))).toBe(true);
    expect(out.some((s) => s.includes('客户拜访记录'))).toBe(true);
  });

  it('应用问数范围 scope 过滤表与列', () => {
    const out = generateSchemaSuggestions([salesTable, visitTable], {
      tables: ['t_visit'],
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.includes('客户拜访记录'))).toBe(true);
    expect(out.every((s) => !s.includes('销售明细表'))).toBe(true);
  });

  it('scope 圈定列时提示只使用被圈定的字段', () => {
    const out = generateSchemaSuggestions([salesTable], {
      tables: ['t_sales'],
      columns: { t_sales: ['region', 'qty'] },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => !s.includes('销售金额') && !s.includes('下单日期'))).toBe(true);
    expect(out.some((s) => s.includes('数量') && s.includes('大区'))).toBe(true);
  });

  it('无标注列按类型回退推导指标与维度，主键排除', () => {
    const raw: TableSchema = {
      id: 't_raw',
      name: 'raw',
      displayName: '原始表',
      description: '',
      rowCount: 10,
      columns: [
        { name: 'pk', type: 'number', isPrimaryKey: true },
        { name: 'created_at', type: 'date' },
        { name: 'status', type: 'category' },
        { name: 'total', type: 'number' },
      ],
    };
    const out = generateSchemaSuggestions([raw]);
    expect(out).toContain('分析 原始表 的 total 按 created_at 的变化趋势');
    expect(out.every((s) => !s.includes('pk'))).toBe(true);
  });

  it('仅有维度时生成记录数统计提示', () => {
    const dimOnly: TableSchema = {
      id: 't_dim',
      name: 'dim',
      displayName: '地区维表',
      description: '',
      rowCount: 5,
      columns: [{ name: 'region', type: 'category', description: '大区', isDimension: true }],
    };
    expect(generateSchemaSuggestions([dimOnly])).toContain('统计 地区维表 各 大区 的记录数量');
  });

  it('仅有指标时生成总量与平均值提示', () => {
    const metricOnly: TableSchema = {
      id: 't_m',
      name: 'm',
      displayName: '指标表',
      description: '',
      rowCount: 5,
      columns: [{ name: 'v', type: 'number', description: '数值', isMetric: true }],
    };
    expect(generateSchemaSuggestions([metricOnly])).toContain('统计 指标表 的 数值 总和与平均值');
  });

  it('结果去重且不超过 max 上限', () => {
    const out = generateSchemaSuggestions([salesTable, visitTable], null, 3);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(new Set(out).size).toBe(out.length);
  });

  it('空表/空列容错返回空数组', () => {
    expect(generateSchemaSuggestions([])).toEqual([]);
    expect(generateSchemaSuggestions(null as any)).toEqual([]);
    const empty: TableSchema = {
      id: 't_e', name: 'e', displayName: '空表', description: '', rowCount: 0, columns: [],
    };
    expect(generateSchemaSuggestions([empty])).toEqual([]);
  });
});

describe('buildQueryPlaceholder', () => {
  it('有推荐时拼接首条示例', () => {
    expect(buildQueryPlaceholder(['统计客户总数'], '兜底')).toBe('用自然语言提问，如：统计客户总数');
  });

  it('无推荐时使用兜底文案', () => {
    expect(buildQueryPlaceholder([], '兜底文案')).toBe('兜底文案');
  });

  it('超长示例截断为 36 字加省略号', () => {
    const long = '分'.repeat(50);
    const out = buildQueryPlaceholder([long], '兜底');
    expect(out).toBe(`用自然语言提问，如：${'分'.repeat(36)}...`);
  });
});
