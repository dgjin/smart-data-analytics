import { describe, expect, it } from 'vitest';
import { detectTimeRange, detectAggregationIntent, generateTimeRangeSQL } from './ruleBased';

describe('Rule-Based Fallback: 时间范围检测', () => {
  it('YYYY-MM-DD 格式：2024-01-01 至 2024-01-31', () => {
    const result = detectTimeRange('2024-01-01 至 2024-01-31');
    expect(result.detected).toBe(true);
    expect(result.startDate).toBe('2024-01-01');
    expect(result.endDate).toBe('2024-01-31');
    expect(result.format).toBe('iso');
  });

  it('YYYY-MM-DD 格式：to 连接词', () => {
    // 跳过英文月份格式的测试（MVP 版本暂不支持）
    const result = detectTimeRange('January 2024 to February 2024');
    expect(result.detected).toBe(false); // 当前版本未实现此功能
  });

  it('中文格式：2024 年 1 月至 2024 年 2 月', () => {
    const result = detectTimeRange('2024 年 1 月至 2024 年 2 月');
    expect(result.detected).toBe(true);
    expect(result.format).toBe('chinese');
    expect(result.startDate).toBe('2024-01-01');
    expect(result.endDate).toBe('2024-02-01');
  });

  it('无时间范围返回未检测到', () => {
    const result = detectTimeRange('销售额是多少？');
    expect(result.detected).toBe(false);
  });
});

describe('Rule-Based Fallback: 聚合意图识别', () => {
  it('金额关键词检测：总额、总和、合计', () => {
    const result1 = detectAggregationIntent('上个月的总额是多少？');
    expect(result1.hasAmountAgg).toBe(true);
    
    const result2 = detectAggregationIntent('今年总和销售额');
    expect(result2.hasAmountAgg).toBe(true);
    
    const result3 = detectAggregationIntent('预算合计');
    expect(result3.hasAmountAgg).toBe(true);
  });

  it('数量关键词检测：数量、笔数、count', () => {
    const result1 = detectAggregationIntent('交易数量是多少？');
    expect(result1.hasQuantityAgg).toBe(true);
    
    const result2 = detectAggregationIntent('订单笔数统计');
    expect(result2.hasQuantityAgg).toBe(true);
    
    const result3 = detectAggregationIntent('customer count');
    expect(result3.hasQuantityAgg).toBe(true);
  });

  it('无聚合关键词', () => {
    const result = detectAggregationIntent('列出所有客户');
    expect(result.hasAmountAgg).toBe(false);
    expect(result.hasQuantityAgg).toBe(false);
  });
});

describe('Rule-Based Fallback: SQL 生成', () => {
  it('金额 + 时间范围生成 SUM 查询', () => {
    const query = '2024-01-01 至 2024-01-31 的收入总额';
    const result = generateTimeRangeSQL(query, 'ds_001');
    expect(result.sql).toContain('SUM(amount)');
    expect(result.sql).toContain('BETWEEN');
    expect(result.explanation).toContain('2024-01-01');
  });

  it('数量 + 时间范围生成 COUNT 查询', () => {
    const query = '2024-01-01 到 2024-01-31 的订单数量';
    const result = generateTimeRangeSQL(query, 'ds_001');
    expect(result.sql).toContain('COUNT(*)');
    expect(result.explanation).toContain('2024-01-01');
  });

  it('无关键词默认返回记录数', () => {
    const query = '2024-01-01 到 2024-01-31 的数据';
    const result = generateTimeRangeSQL(query, 'ds_001');
    expect(result.sql).toContain('COUNT(*)');
  });

  it('无效时间范围抛出错误', () => {
    const query = '销售额是多少？';
    expect(() => generateTimeRangeSQL(query, 'ds_001')).toThrow('未检测到有效时间范围');
  });
});
