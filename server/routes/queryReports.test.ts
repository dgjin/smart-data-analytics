import { describe, expect, it } from 'vitest';
import { toQueryReportRecord, QueryReportRow } from './queryReports';

const baseRow: QueryReportRow = {
  id: 10,
  report_id: 'report-1724000000000',
  user_id: 1,
  username: 'admin',
  data_source_id: 'ds_1786620486498',
  question: '按机构统计当年投放与回现',
  template_id: 2,
  template_name: '综合经营分析',
  report_data: JSON.stringify({
    id: 'report-1724000000000',
    title: '机构投放回现分析',
    summary: '本年度各机构投放与回现情况汇总',
    createdAt: '2026-08-20',
    dataSourceId: 'ds_1786620486498',
    templateType: 'custom',
    insights: [{ title: '投放增长', type: 'positive', content: '投放同比增长' }],
    kpiList: [{ label: '投放金额', value: '1.2亿', change: '+5%', status: 'good' }],
    charts: [],
  }),
  created_at: new Date('2026-08-20T01:00:00.000Z'),
};

describe('toQueryReportRecord: 报告行记录 → 前端格式转换', () => {
  it('字段名转驼峰，report_data JSON 解析为对象', () => {
    const out = toQueryReportRecord(baseRow);
    expect(out.id).toBe(10);
    expect(out.reportId).toBe('report-1724000000000');
    expect(out.userId).toBe(1);
    expect(out.username).toBe('admin');
    expect(out.dataSourceId).toBe('ds_1786620486498');
    expect(out.question).toBe('按机构统计当年投放与回现');
    expect(out.templateId).toBe(2);
    expect(out.templateName).toBe('综合经营分析');
    expect(out.createdAt).toBe('2026-08-20T01:00:00.000Z');
    // reportData 被解析为对象
    expect(typeof out.reportData).toBe('object');
    expect(out.reportData.title).toBe('机构投放回现分析');
    expect(out.reportData.kpiList).toHaveLength(1);
    expect(out.reportData.insights).toHaveLength(1);
  });

  it('template_id 为 NULL（智能推断）时映射为 null', () => {
    const out = toQueryReportRecord({ ...baseRow, template_id: null, template_name: '' });
    expect(out.templateId).toBeNull();
    expect(out.templateName).toBe('');
  });

  it('report_data 非合法 JSON 时抛出（数据完整性兜底）', () => {
    expect(() => toQueryReportRecord({ ...baseRow, report_data: 'broken-json{' })).toThrow();
  });
});
