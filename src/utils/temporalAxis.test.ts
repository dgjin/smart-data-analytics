import { describe, expect, it } from 'vitest';
import { detectTemporalAxis } from './temporalAxis';

describe('detectTemporalAxis：时间序列判定（同比/环比前置校验）', () => {
  it('机构名等分类维度返回 false（回归：各机构风险项目分布图误算同比/环比）', () => {
    const orgs = ['工商银行', '建设银行', '农业银行', '中国银行', '交通银行', '邮储银行', '招商银行', '兴业银行'];
    expect(detectTemporalAxis(orgs)).toBe(false);
  });

  it('YYYY-MM 升序月度序列为时间轴', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);
    expect(detectTemporalAxis(months)).toBe(true);
  });

  it('YYYY-MM-DD 日序列为时间轴', () => {
    expect(detectTemporalAxis(['2025-08-01', '2025-08-02', '2025-08-03'])).toBe(true);
  });

  it('降序时间序列同样允许', () => {
    expect(detectTemporalAxis(['2025-12', '2025-11', '2025-10', '2025-09'])).toBe(true);
  });

  it('乱序时间序列拒绝（偏移基线会错位）', () => {
    expect(detectTemporalAxis(['2025-03', '2025-01', '2025-02'])).toBe(false);
  });

  it('纯年份序列（数字与字符串）为时间轴', () => {
    expect(detectTemporalAxis([2019, 2020, 2021, 2022, 2023, 2024, 2025])).toBe(true);
    expect(detectTemporalAxis(['2022', '2023', '2024', '2025'])).toBe(true);
  });

  it('中文年月与中文季度为时间轴', () => {
    expect(detectTemporalAxis(['2025年1月', '2025年2月', '2025年3月'])).toBe(true);
    expect(detectTemporalAxis(['2024年第1季度', '2024年第2季度', '2024年第3季度', '2024年第4季度'])).toBe(true);
  });

  it('Q 季度标记为时间轴', () => {
    expect(detectTemporalAxis(['2024Q1', '2024Q2', '2024Q3', '2024Q4', '2025Q1'])).toBe(true);
  });

  it('裸月份（当年按月分组）为时间轴，相邻相等允许', () => {
    expect(detectTemporalAxis(['1月', '2月', '3月', '4月', '5月', '6月'])).toBe(true);
    expect(detectTemporalAxis(['1月', '1月'])).toBe(true);
  });

  it('月序列混入「合计」行拒绝（存在不可解析样本）', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);
    expect(detectTemporalAxis([...months, '合计'])).toBe(false);
  });

  it('非年份数字（编号/序号）拒绝', () => {
    expect(detectTemporalAxis([1, 2, 3, 4, 5, 6, 7, 8])).toBe(false);
  });

  it('少于 2 个非空样本拒绝', () => {
    expect(detectTemporalAxis([])).toBe(false);
    expect(detectTemporalAxis(['2025-01'])).toBe(false);
  });

  it('Date 对象序列为时间轴', () => {
    expect(detectTemporalAxis([new Date('2025-01-01'), new Date('2025-02-01'), new Date('2025-03-01')])).toBe(true);
  });
});
