/**
 * v0.9.107 评价体系共享类型与文案（v0.9.109 简化为纯星级）：
 * - 问数星级评价：仅 1-5 星，点星即提交（POST /api/ratings/query）；
 * - 全站满意度：仅 1-5 星，同一用户 24h 内重复提交更新最近一条（POST /api/ratings/app）；
 * - 与 query_feedback（赞/踩 + 点踩纠错）相互独立，不影响 few-shot 与统一记忆体口径。
 * 服务端仍兼容 tags/comment 字段（历史数据），新交互不再采集。
 */

/** 全站满意度回显（GET /api/ratings/mine） */
export interface MySatisfaction {
  rating: number;
  createdAt: string;
}

/** 星级文案：用于按钮态与提示 */
export const RATING_LABELS: Record<number, string> = {
  1: '很不满意',
  2: '不太满意',
  3: '一般',
  4: '比较满意',
  5: '非常满意',
};

/** 评价来源（管理端明细筛选） */
export type RatingSource = 'all' | 'query' | 'app';
