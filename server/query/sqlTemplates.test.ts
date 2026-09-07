/**
 * v0.4.15 复杂 SQL 构建能力：模板引擎单元测试
 */
import { describe, expect, it } from 'vitest';
import { AVAILABLE_TEMPLATES, validateTemplateParams } from './sqlTemplates';

describe('AVAILABLE_TEMPLATES: 模板清单', () => {
  it('至少包含同比环比和 TOP-N 占比等核心模板', () => {
    const ids = AVAILABLE_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('year_over_year');
    expect(ids).toContain('month_over_month');
    expect(ids).toContain('top_n_with_pct');
    expect(ids).toContain('conditional_agg_cross_tab');
  });

  it('每个模板都有 label/description/buildSql', () => {
    for (const t of AVAILABLE_TEMPLATES) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.buildSql).toBe('function');
    }
  });
});

describe('validateTemplateParams: YoY 模板', () => {
  it('有效参数通过', () => {
    const r = validateTemplateParams('year_over_year', { dimension: 'region', filterYear: 2024, prevYear: 2023 });
    expect(r.ok).toBe(true);
  });

  it('缺少必填参数拒绝', () => {
    const r = validateTemplateParams('year_over_year', {} as any);
    expect(r.ok).toBe(false);
  });
});

describe('validateTemplateParams: topN 模板', () => {
  it('有效参数通过', () => {
    const r = validateTemplateParams('top_n_with_pct', { metricAlias: 'total_amt', dimension: 'region', topN: 10, sortBy: 'DESC' });
    expect(r.ok).toBe(true);
  });

  it('非法排序方向拒绝', () => {
    const r = validateTemplateParams('top_n_with_pct', { metricAlias: 'x', dimension: 'd', topN: 5, sortBy: 'RANDOM' as any });
    expect(r.ok).toBe(false);
  });
});

describe('validateTemplateParams: 交叉表模板', () => {
  it('COLS 数组合法时通过', () => {
    const r = validateTemplateParams('conditional_agg_cross_tab', { rows: 'region', cols: [{ value: 2024, label: '2024 年' }, { value: 2023, label: '2023 年' }] });
    expect(r.ok).toBe(true);
  });

  it('COLS 为空或项非法时拒绝', () => {
    const r1 = validateTemplateParams('conditional_agg_cross_tab', { rows: 'r', cols: [] });
    expect(r1.ok).toBe(false);
    const r2 = validateTemplateParams('conditional_agg_cross_tab', { rows: 'r', cols: [{ value: 'invalid' as any, label: 'x' }] });
    expect(r2.ok).toBe(false);
  });
});
