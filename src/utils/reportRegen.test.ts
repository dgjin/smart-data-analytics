/**
 * v0.9.22 历史报表维护纯函数测试：
 * 生成条件解析（genParams 快照优先 / 旧报表回退）、重新生成准入、结果就地替换合并。
 */
import { describe, expect, it } from 'vitest';
import { resolveReportGenParams, canRegenerateReport, applyRegenResult } from './reportRegen';
import { SavedReport } from '../types/analytics';

const baseReport: SavedReport = {
  id: 'report-1',
  title: '综合经营分析 - 决策简报',
  summary: 's',
  createdAt: '2026-09-01',
  dataSourceId: 'ds1',
  templateType: 'executive',
  insights: [],
  kpiList: [],
  charts: [],
  customPrompt: '重点关注逾期',
  dataProvenance: 'live',
};

describe('resolveReportGenParams：生成条件解析', () => {
  it('genParams 快照优先（模板/要求/单位均取自快照）', () => {
    const r = resolveReportGenParams(
      { ...baseReport, genParams: { templateType: '资产质量与风险监控', customPrompt: '看长龄', amountUnit: '万元' } },
      '综合经营分析',
      '亿元'
    );
    expect(r).toEqual({ templateType: '资产质量与风险监控', customPrompt: '看长龄', amountUnit: '万元', dataSourceId: 'ds1' });
  });

  it('旧版报表无快照：回退平铺 customPrompt + 调用方默认模板与单位', () => {
    const r = resolveReportGenParams(baseReport, '综合经营分析', '亿元');
    expect(r).toEqual({ templateType: '综合经营分析', customPrompt: '重点关注逾期', amountUnit: '亿元', dataSourceId: 'ds1' });
  });

  it('快照缺失部分字段时逐项回退（单位取默认值，要求可取平铺字段）', () => {
    const r = resolveReportGenParams(
      { ...baseReport, genParams: { templateType: '投资收益与财务分析', customPrompt: '' } },
      '综合经营分析',
      '百万元'
    );
    expect(r.templateType).toBe('投资收益与财务分析');
    expect(r.customPrompt).toBe(''); // 快照显式空串优先于平铺字段
    expect(r.amountUnit).toBe('百万元');
  });
});

describe('canRegenerateReport：重新生成准入', () => {
  it('live 报表 + 有生成权限（ADMIN/ANALYST）→ 可重新生成', () => {
    expect(canRegenerateReport(baseReport, true)).toBe(true);
  });

  it('simulated 演示报表 / 无数据源 / 无权限（VIEWER）→ 不可', () => {
    expect(canRegenerateReport({ ...baseReport, dataProvenance: 'simulated' }, true)).toBe(false);
    expect(canRegenerateReport({ ...baseReport, dataSourceId: '' }, true)).toBe(false);
    expect(canRegenerateReport(baseReport, false)).toBe(false);
    expect(canRegenerateReport(null, true)).toBe(false);
  });
});

describe('applyRegenResult：重新生成结果就地替换合并', () => {
  const data = {
    title: '新标题',
    summary: '新摘要',
    createdAt: '2026-09-04',
    insights: [{ title: 'i', type: 'info' as const, content: 'c' }],
    kpiList: [{ label: 'k', value: '1', change: '0%', status: 'neutral' as const }],
    charts: [{ title: 'c1', chartConfig: {} as any, data: [], commentary: '' }],
    executedSqls: ['SELECT 1'],
  };
  const params = { templateType: '资产质量与风险监控', customPrompt: ' 看长龄 ', amountUnit: '万元', dataSourceId: 'ds1' };

  it('保留原报表 id 与批注，更新内容与生成条件快照', () => {
    const original: SavedReport = { ...baseReport, comments: [{ id: 'c1' } as any] };
    const out = applyRegenResult(original, data, params, 'live');
    expect(out.id).toBe('report-1');
    expect(out.comments).toEqual([{ id: 'c1' }]);
    expect(out.title).toBe('新标题');
    expect(out.createdAt).toBe('2026-09-04');
    expect(out.executedSqls).toEqual(['SELECT 1']);
    expect(out.genParams).toEqual({ templateType: '资产质量与风险监控', customPrompt: '看长龄', amountUnit: '万元' });
    expect(out.customPrompt).toBe('看长龄');
    expect(out.dataProvenance).toBe('live');
  });

  it('新条件为空要求时清空平铺 customPrompt（避免旧条件残留误导）', () => {
    const out = applyRegenResult(baseReport, data, { ...params, customPrompt: '   ' }, 'live');
    expect(out.customPrompt).toBeUndefined();
    expect(out.genParams?.customPrompt).toBe('');
  });
});
