/**
 * v0.9.23 历史报表服务端持久化：前端迁移/映射纯函数测试
 */
import { describe, expect, it } from 'vitest';
import { DEMO_REPORT_ID, pickMigratableReports, reportFromRecord } from './reportPersistence';
import { SavedReport } from '../types/analytics';

const base: SavedReport = {
  id: 'report-1725000000000',
  title: '综合经营分析 - 决策简报',
  summary: 's',
  createdAt: '2026-09-01',
  dataSourceId: 'ds-1',
  templateType: 'executive',
  insights: [],
  kpiList: [],
  charts: [],
  dataProvenance: 'live',
};

describe('pickMigratableReports：本地遗留迁移筛选', () => {
  it('排除内置演示报表，保留用户生成的报表', () => {
    const demo: SavedReport = { ...base, id: DEMO_REPORT_ID, title: '演示报表' };
    const user1 = { ...base, id: 'report-1' };
    const user2 = { ...base, id: 'report-2', dataProvenance: 'simulated' as const };
    const out = pickMigratableReports([demo, user1, user2]);
    expect(out.map((r) => r.id)).toEqual(['report-1', 'report-2']);
  });

  it('排除结构不完整项（无 id / 空标题 / id 超长）', () => {
    const out = pickMigratableReports([
      { ...base, id: '' },
      { ...base, title: '  ' },
      { ...base, id: 'x'.repeat(65) },
      base,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(base.id);
  });

  it('空数组原样返回', () => {
    expect(pickMigratableReports([])).toEqual([]);
  });
});

describe('reportFromRecord：服务端记录映射', () => {
  it('提取 report_data 中的完整 SavedReport', () => {
    const rec = reportFromRecord({ report: base });
    expect(rec?.id).toBe(base.id);
    expect(rec?.dataProvenance).toBe('live');
  });

  it('非法记录返回 null（缺 report / 非对象 / 无 id）', () => {
    expect(reportFromRecord({})).toBeNull();
    expect(reportFromRecord({ report: [] })).toBeNull();
    expect(reportFromRecord({ report: { ...base, id: '' } })).toBeNull();
  });
});
