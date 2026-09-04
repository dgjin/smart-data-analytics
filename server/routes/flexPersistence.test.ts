import { describe, expect, it } from 'vitest';
import { normalizeDashboardWidgetPayload, toDashboardWidgetRecord } from './dashboardWidgets';
import { normalizeFlexQueryPayload, normalizeFlexHistoryItems, toFlexQueryRecord } from './flexQueries';

// v0.9.24 看板图表 / 灵活查询持久化路由的纯函数单测（校验与记录映射，不触库）

describe('normalizeDashboardWidgetPayload', () => {
  const validWidget = {
    id: 'widget-1700000000000',
    title: '各机构投放排名',
    chartConfig: { type: 'bar', title: 't', xAxisKey: 'jgmc', yAxisKeys: ['je'] },
    data: [{ jgmc: '北京市分公司', je: 720.3 }],
    colSpan: 2,
  };

  it('接受合法图表并裁剪 id/title 首尾空白', () => {
    const r = normalizeDashboardWidgetPayload({ ...validWidget, id: '  widget-x  ', title: '  标题  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.widget.id).toBe('widget-x');
      expect(r.widget.title).toBe('标题');
      expect(r.widget.colSpan).toBe(2);
    }
  });

  it('拒绝非对象 / 缺 id / 空标题 / 缺 chartConfig / data 非数组', () => {
    expect(normalizeDashboardWidgetPayload(null).ok).toBe(false);
    expect(normalizeDashboardWidgetPayload('x').ok).toBe(false);
    expect(normalizeDashboardWidgetPayload([validWidget]).ok).toBe(false);
    expect(normalizeDashboardWidgetPayload({ ...validWidget, id: '' }).ok).toBe(false);
    expect(normalizeDashboardWidgetPayload({ ...validWidget, title: '   ' }).ok).toBe(false);
    expect(normalizeDashboardWidgetPayload({ ...validWidget, chartConfig: null }).ok).toBe(false);
    expect(normalizeDashboardWidgetPayload({ ...validWidget, data: 'not-array' }).ok).toBe(false);
  });

  it('拒绝超长 id 与超长标题', () => {
    expect(normalizeDashboardWidgetPayload({ ...validWidget, id: 'w'.repeat(65) }).ok).toBe(false);
    expect(normalizeDashboardWidgetPayload({ ...validWidget, title: '标'.repeat(201) }).ok).toBe(false);
  });
});

describe('toDashboardWidgetRecord', () => {
  it('展开 widget_data JSON 并透传归属信息', () => {
    const row = {
      widget_id: 'widget-1',
      user_id: 0,
      username: 'system',
      widget_data: JSON.stringify({ id: 'widget-1', title: 't', chartConfig: {}, data: [] }),
    } as never;
    const rec = toDashboardWidgetRecord(row);
    expect(rec.widgetId).toBe('widget-1');
    expect(rec.userId).toBe(0);
    expect(rec.username).toBe('system');
    expect(rec.widget?.title).toBe('t');
  });

  it('widget_data JSON 损坏时 widget 为 null（不抛异常）', () => {
    const rec = toDashboardWidgetRecord({ widget_id: 'w', user_id: 1, username: 'u', widget_data: '{bad' } as never);
    expect(rec.widget).toBeNull();
  });
});

describe('normalizeFlexQueryPayload', () => {
  const validQuery = {
    id: 'flex-1700000000000',
    name: '各机构投放排名',
    dataSourceId: 'ds-1',
    config: { table: 'fct_jc_tz', dimensions: ['jgmc'], measures: [{ column: 'tfje', agg: 'SUM' }] },
    chartType: 'bar',
    createdAt: '2026-09-04',
  };

  it('接受合法固定报表并补齐空 dataSourceId', () => {
    const r = normalizeFlexQueryPayload({ ...validQuery, dataSourceId: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.dataSourceId).toBe('');
  });

  it('拒绝非对象 / 缺 id / 空名称 / 缺 config', () => {
    expect(normalizeFlexQueryPayload(null).ok).toBe(false);
    expect(normalizeFlexQueryPayload({ ...validQuery, id: '' }).ok).toBe(false);
    expect(normalizeFlexQueryPayload({ ...validQuery, name: '  ' }).ok).toBe(false);
    expect(normalizeFlexQueryPayload({ ...validQuery, config: [] }).ok).toBe(false);
    expect(normalizeFlexQueryPayload({ ...validQuery, config: null }).ok).toBe(false);
  });
});

describe('normalizeFlexHistoryItems', () => {
  const item = (id: string) => ({ id, name: 'n', dataSourceId: 'ds-1', config: { table: 't' }, chartType: 'table', ranAt: '09-04 10:00' });

  it('非数组输入归一为空数组', () => {
    expect(normalizeFlexHistoryItems(null)).toEqual([]);
    expect(normalizeFlexHistoryItems('x')).toEqual([]);
    expect(normalizeFlexHistoryItems({})).toEqual([]);
  });

  it('过滤结构非法条目（缺 id 或 config）', () => {
    const out = normalizeFlexHistoryItems([item('h1'), { id: 'h2' }, { config: {} }, 'x', item('h3')]);
    expect(out.map((x) => x.id)).toEqual(['h1', 'h3']);
  });

  it('超过 8 条裁剪（服务端兜底上限）', () => {
    const out = normalizeFlexHistoryItems(Array.from({ length: 12 }, (_, i) => item(`h${i}`)));
    expect(out).toHaveLength(8);
    expect(out[0].id).toBe('h0');
  });
});

describe('toFlexQueryRecord', () => {
  it('展开 query_data JSON 并输出 ISO 时间', () => {
    const row = {
      query_id: 'flex-1',
      user_id: 7,
      username: 'analyst1',
      data_source_id: 'ds-1',
      query_data: JSON.stringify({ id: 'flex-1', name: 'n', dataSourceId: 'ds-1', config: {}, chartType: 'bar', createdAt: '2026-09-04' }),
      created_at: new Date('2026-09-04T02:00:00Z'),
    } as never;
    const rec = toFlexQueryRecord(row);
    expect(rec.queryId).toBe('flex-1');
    expect(rec.username).toBe('analyst1');
    expect(rec.query?.chartType).toBe('bar');
    expect(rec.createdAt).toBe('2026-09-04T02:00:00.000Z');
  });
});
