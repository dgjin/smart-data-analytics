/**
 * v0.9.98 需求收集与意见反馈：共享类型与文案（用户弹窗 FeedbackModal 与管理面板 FeedbackPanel 共用）。
 * 数据形态与 server/routes/requirements.ts 的 rowToEntry 映射保持一致。
 */

export type FeedbackKind = 'REQUIREMENT' | 'SUGGESTION' | 'BUG' | 'OTHER';
export type FeedbackStatus = 'PENDING' | 'BASELINED' | 'REJECTED';

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

export const isKind = (v: string): v is FeedbackKind => v in KIND_LABELS;
export const isStatus = (v: string): v is FeedbackStatus => v in STATUS_META;
