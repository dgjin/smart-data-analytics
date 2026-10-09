/**
 * v0.9.98 需求收集与意见反馈：共享类型与文案（用户弹窗 FeedbackModal 与管理面板 FeedbackPanel 共用）。
 * 数据形态与 server/routes/requirements.ts 的 rowToEntry 映射保持一致。
 * v0.9.102 「继续评估」每次结论留痕：FeedbackRevision 评估历史（管理面板展示，导出供 AIOps 获取）。
 */

export type FeedbackKind = 'REQUIREMENT' | 'SUGGESTION' | 'BUG' | 'OTHER';
export type FeedbackStatus = 'PENDING' | 'BASELINED' | 'REJECTED';

/** 评估动作（与后端 POST /:id/review 的 action 取值一致） */
export type FeedbackReviewAction = 'BASELINE' | 'REJECT' | 'PENDING';

/** 单次评估历史记录（v0.9.102：继续评估的每次结论均留痕） */
export interface FeedbackRevision {
  id: number;
  entryId: number;
  action: FeedbackReviewAction;
  priority: string;
  baselineVersion: string;
  assessment: string;
  reviewer: string;
  createdAt: string | null;
}

export interface FeedbackEntry {
  id: number;
  kind: FeedbackKind;
  title: string;
  content: string;
  status: FeedbackStatus;
  priority: string;
  baselineVersion: string;
  assessment: string;
  submitter: string;
  department: string;
  reviewer: string;
  reviewedAt: string | null;
  createdAt: string | null;
  updatedAt?: string | null;
  /** 评估历史（管理列表与导出接口附带；时间升序） */
  revisions?: FeedbackRevision[];
}

export const KIND_LABELS: Record<FeedbackKind, string> = {
  REQUIREMENT: '功能需求',
  SUGGESTION: '改进建议',
  BUG: '问题缺陷',
  OTHER: '其他',
};

export const STATUS_META: Record<FeedbackStatus, { label: string; cls: string }> = {
  PENDING: { label: '待评估', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  BASELINED: { label: '已纳入基线', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  REJECTED: { label: '未采纳', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

/** 评估动作文案（与后端 action 语义一致） */
export const REVIEW_ACTION_LABELS: Record<FeedbackReviewAction, string> = {
  BASELINE: '纳入基线',
  REJECT: '不予采纳',
  PENDING: '退回待评估',
};

/** 评估动作配色（评估记录时间线徽标共用） */
export const REVIEW_ACTION_CLS: Record<FeedbackReviewAction, string> = {
  BASELINE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  REJECT: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

export const isKind = (v: string): v is FeedbackKind => v in KIND_LABELS;
export const isStatus = (v: string): v is FeedbackStatus => v in STATUS_META;
export const isReviewAction = (v: string): v is FeedbackReviewAction => v in REVIEW_ACTION_LABELS;
