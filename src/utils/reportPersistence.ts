/**
 * v0.9.23 历史报表服务端持久化：前端辅助纯函数
 * - 本地遗留报表迁移筛选（persist rehydrate 后的旧 localStorage 数据 → 服务端）
 * - 服务端记录 → SavedReport 映射
 * 抽为纯函数独立单测，store（useAnalyticsStore）保持薄。
 */
import { SavedReport } from '../types/analytics';

/** 内置演示报表 id（不落库、不迁移；删除仅本地隐藏） */
export const DEMO_REPORT_ID = 'report-demo-1';

/**
 * 筛选可迁移到服务端的本地遗留报表：排除内置演示报表与结构不完整项。
 * 重复迁移由服务端 report_id UNIQUE 约束幂等吸收（409 视为已迁移）。
 */
export function pickMigratableReports(reports: SavedReport[]): SavedReport[] {
  return reports.filter(
    (r) => !!r && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64
      && r.id !== DEMO_REPORT_ID
      && typeof r.title === 'string' && r.title.trim().length > 0
  );
}

/** 服务端记录（/api/saved-reports 列表项）→ 前端 SavedReport（report_data 即完整结构，服务端排序字段不覆盖） */
export function reportFromRecord(record: { report?: unknown }): SavedReport | null {
  const report = record?.report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  const r = report as SavedReport;
  if (typeof r.id !== 'string' || !r.id) return null;
  return r;
}
