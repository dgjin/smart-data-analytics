/**
 * v0.9.23 历史报表服务端持久化：saved-reports 路由纯函数测试
 * 入站校验归一（normalizeSavedReportPayload）/ 主题快照提取（extractTemplateType）/ 序列化（toSavedReportRecord）
 */
import { describe, expect, it } from 'vitest';
import { normalizeSavedReportPayload, extractTemplateType, toSavedReportRecord, SavedReportRow } from './savedReports';

describe('normalizeSavedReportPayload：入站校验与归一', () => {
  const base = { id: 'report-1725000000000', title: '综合经营分析 - 决策简报', dataSourceId: 'ds-1', charts: [], kpiList: [], insights: [] };

  it('合法负载透传并归一 dataProvenance', () => {
    const out = normalizeSavedReportPayload({ ...base, customPrompt: '看长龄', dataProvenance: 'simulated' });
    if (out.ok === false) throw new Error('should be ok');
    expect(out.report.id).toBe('report-1725000000000');
    expect(out.report.customPrompt).toBe('看长龄'); // 完整字段保留（存 report_data）
    expect(out.report.dataProvenance).toBe('simulated');
  });

  it('dataProvenance 缺失或非法值归一为 live', () => {
    const a = normalizeSavedReportPayload(base);
    if (a.ok === false) throw new Error('should be ok');
    expect(a.report.dataProvenance).toBe('live');
    const b = normalizeSavedReportPayload({ ...base, dataProvenance: 'unknown' });
    if (b.ok === false) throw new Error('should be ok');
    expect(b.report.dataProvenance).toBe('live');
  });

  it('缺 id / 空标题 / 非对象负载均拒绝', () => {
    expect(normalizeSavedReportPayload(null).ok).toBe(false);
    expect(normalizeSavedReportPayload([]).ok).toBe(false);
    expect(normalizeSavedReportPayload({ ...base, id: '' }).ok).toBe(false);
    expect(normalizeSavedReportPayload({ ...base, title: '  ' }).ok).toBe(false);
    expect(normalizeSavedReportPayload({ ...base, id: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('dataSourceId 缺失时归一为空串（历史演示数据兼容）', () => {
    const out = normalizeSavedReportPayload({ ...base, dataSourceId: undefined });
    if (out.ok === false) throw new Error('should be ok');
    expect(out.report.dataSourceId).toBe('');
  });
});

describe('extractTemplateType：主题快照提取', () => {
  it('genParams.templateType 优先于平铺 templateType', () => {
    expect(extractTemplateType({
      id: 'r1', title: 't', dataSourceId: 'ds',
      genParams: { templateType: '资产质量与风险监控' },
      templateType: 'executive',
    })).toBe('资产质量与风险监控');
  });

  it('无快照时回退平铺 templateType，均缺失返回空串', () => {
    expect(extractTemplateType({ id: 'r1', title: 't', dataSourceId: 'ds', templateType: '综合经营分析' })).toBe('综合经营分析');
    expect(extractTemplateType({ id: 'r1', title: 't', dataSourceId: 'ds' })).toBe('');
  });
});

describe('toSavedReportRecord：行序列化', () => {
  it('JSON 解析 report_data 并输出 ISO 时间戳', () => {
    const row: SavedReportRow = {
      id: 1,
      report_id: 'report-1725000000000',
      user_id: 7,
      username: 'analyst01',
      data_source_id: 'ds-1',
      template_type: '综合经营分析',
      data_provenance: 'live',
      report_data: JSON.stringify({ id: 'report-1725000000000', title: 't', dataSourceId: 'ds-1', charts: [{ title: 'c' }] }),
      created_at: new Date('2026-09-04T01:00:00.000Z'),
      updated_at: new Date('2026-09-04T02:00:00.000Z'),
    };
    const rec = toSavedReportRecord(row);
    expect(rec.reportId).toBe('report-1725000000000');
    expect(rec.username).toBe('analyst01');
    expect(rec.report.charts).toHaveLength(1);
    expect(rec.createdAt).toBe('2026-09-04T01:00:00.000Z');
    expect(rec.updatedAt).toBe('2026-09-04T02:00:00.000Z');
  });
});
