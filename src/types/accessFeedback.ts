/**
 * v0.9.107 评价体系共享类型与文案：
 * - 问数星级评价：1-5 星 + 最多 3 个预设标签 + 最多 200 字说明（POST /api/ratings/query）；
 * - 全站满意度：同一用户 24h 内重复提交更新最近一条（POST /api/ratings/app）；
 * - 与 query_feedback（赞/踩 + 点踩纠错）相互独立，不影响 few-shot 与统一记忆体口径。
 */

/** 标签最多选 3 个、单个不超过 20 字（与服务端校验一致） */
export const MAX_RATING_TAGS = 3;
export const MAX_RATING_TAG_LENGTH = 20;
export const MAX_RATING_COMMENT = 200;

/** 问数评价预设标签（正面 5 + 负面 4） */
export const QUERY_RATING_TAGS = [
  '回答准确',
  '口径正确',
  '分析到位',
  '图表清晰',
  '响应迅速',
  '口径不清',
  '结果偏差',
  '分析不足',
  '答非所问',
] as const;

/** 全站满意度预设标签（正面 5 + 负面 4） */
export const APP_RATING_TAGS = [
  '上手容易',
  '回答专业',
  '速度流畅',
  '界面清晰',
  '功能齐全',
  '加载较慢',
  '回答不稳',
  '功能缺失',
  '操作繁琐',
] as const;

/** 全站满意度回显（GET /api/ratings/mine） */
export interface MySatisfaction {
  rating: number;
  tags: string[];
  comment: string;
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

/** 问数评价入参（与 POST /api/ratings/query 对齐） */
export interface QueryRatingPayload {
  dataSourceId: string;
  question: string;
  sql?: string;
  traceId?: string;
  rating: number;
  tags: string[];
  comment: string;
}

/** 评价来源（管理端明细筛选） */
export type RatingSource = 'all' | 'query' | 'app';
