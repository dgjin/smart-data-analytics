import { describe, expect, it } from 'vitest';
import type { DashboardWidget } from '../types/analytics';
import { DEFAULT_WIDGET_IDS, pickMigratableWidgets, widgetFromRecord } from './widgetPersistence';

// v0.9.24 看板固化图表持久化辅助：迁移筛选与记录映射

const mkWidget = (id: string, title = '图表'): DashboardWidget => ({
  id,
  title,
  chartConfig: { type: 'bar', title, xAxisKey: 'jgmc', yAxisKeys: ['je'] },
  data: [{ jgmc: '北京市分公司', je: 720.3 }],
});

describe('pickMigratableWidgets', () => {
  it('排除出厂内置 widget-1..5（服务端 seed 已有权威数据）', () => {
    const legacy = [...DEFAULT_WIDGET_IDS.map((id) => mkWidget(id)), mkWidget('widget-1700000000000')];
    const out = pickMigratableWidgets(legacy);
    expect(out.map((w) => w.id)).toEqual(['widget-1700000000000']);
  });

  it('排除无 id / 空标题 / id 超长 / 缺 chartConfig / data 非数组的不完整项', () => {
    const bad = [
      { ...mkWidget('a'), id: '' },
      { ...mkWidget('b'), title: '  ' },
      { ...mkWidget('w'.repeat(65)) },
      { ...mkWidget('c'), chartConfig: null as never },
      { ...mkWidget('d'), data: 'x' as never },
    ];
    expect(pickMigratableWidgets(bad as DashboardWidget[])).toEqual([]);
  });

  it('保留用户固化的合法图表（含 sourceSql 自动重放字段）', () => {
    const w = { ...mkWidget('widget-1700000000001'), dataSourceId: 'ds-1', sourceSql: 'SELECT 1' };
    const out = pickMigratableWidgets([w]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceSql).toBe('SELECT 1');
  });
});

describe('widgetFromRecord', () => {
  it('合法记录返回 widget', () => {
    const rec = { widgetId: 'widget-1', widget: mkWidget('widget-1') };
    expect(widgetFromRecord(rec)?.title).toBe('图表');
  });

  it('widget 缺失或结构不完整返回 null', () => {
    expect(widgetFromRecord({ widgetId: 'w1' })).toBeNull();
    expect(widgetFromRecord({ widget: null })).toBeNull();
    expect(widgetFromRecord({ widget: { id: '', title: 't' } })).toBeNull();
    expect(widgetFromRecord({ widget: { id: 'w', title: '', chartConfig: {}, data: [] } })).toBeNull();
  });
});
