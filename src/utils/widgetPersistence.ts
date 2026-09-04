/**
 * v0.9.24 决策数据看板固化图表持久化辅助：存量 localStorage 迁移筛选与服务端记录映射。
 * 与 reportPersistence.ts 同模式：服务端 dashboard_widgets 表 widget_id UNIQUE 约束保证重复迁移幂等。
 */
import type { DashboardWidget } from '../types/analytics';

/** 出厂内置图表 id（服务端启动 seed，迁移时排除避免覆盖出厂数据） */
export const DEFAULT_WIDGET_IDS = ['widget-1', 'widget-2', 'widget-3', 'widget-4', 'widget-5'];

/** 从 rehydrate 带入内存的旧本地图表中筛出需迁移项（排除出厂内置与结构不完整项） */
export function pickMigratableWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  return widgets.filter(
    (w) =>
      w &&
      typeof w.id === 'string' &&
      w.id.length > 0 &&
      w.id.length <= 64 &&
      !DEFAULT_WIDGET_IDS.includes(w.id) &&
      typeof w.title === 'string' &&
      w.title.trim().length > 0 &&
      w.chartConfig &&
      Array.isArray(w.data),
  );
}

/** 服务端记录 → 前端 DashboardWidget（widget JSON 校验；不合格返回 null 由调用方过滤） */
export function widgetFromRecord(record: { widgetId?: unknown; widget?: unknown }): DashboardWidget | null {
  const w = record?.widget;
  if (!w || typeof w !== 'object') return null;
  const widget = w as DashboardWidget;
  if (typeof widget.id !== 'string' || !widget.id) return null;
  if (typeof widget.title !== 'string' || !widget.title.trim()) return null;
  if (!widget.chartConfig || !Array.isArray(widget.data)) return null;
  return widget;
}
