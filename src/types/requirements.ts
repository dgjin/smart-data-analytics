/**
 * v0.9.98 需求收集与意见反馈：共享类型与文案（用户弹窗 FeedbackModal 与管理面板 FeedbackPanel 共用）。
 * 数据形态与 server/routes/requirements.ts 的 rowToEntry 映射保持一致。
 * v0.9.102 「继续评估」每次结论留痕：FeedbackRevision 评估历史（管理面板展示，导出供 AIOps 获取）。
 * v0.9.105 智能运维处理进度：OpsTrack/OpsTimelineEvent（经 /api/requirements/ops-progress 代理 AIOps）。
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

// ---------- 智能运维系统处理进度（v0.9.105） ----------

/** 处理阶段（与 AIOps TRACK_STAGES 键一致；面向需求提交者语义） */
export type OpsStage =
  | 'NOT_ANALYZED'
  | 'ANALYZING'
  | 'ANALYZED'
  | 'ANALYSIS_FAILED'
  | 'APPROVED'
  | 'RELEASED'
  | 'ESCALATED'
  | 'CANCELLED'
  | 'RELEASE_FAILED'
  | 'UNKNOWN';

/** 时间线事件阶段（分析生命周期事件 + 上述处理阶段） */
export type OpsEventStage = OpsStage | 'ANALYSIS_STARTED' | 'ANALYSIS_DONE';

/** 时间线单条事件（at 为存量版本缺完成时间时可能为空串） */
export interface OpsTimelineEvent {
  stage: OpsEventStage;
  at: string;
  version?: number;
  detail?: string;
}

/** 单条目处理进度视图（AIOps GET /api/requirements/track 的 track_view） */
export interface OpsTrack {
  entry_id: string;
  tracked: boolean;
  stage: OpsStage;
  stage_label: string;
  current_version: number;
  started_at: string;
  analysis_done_at: string;
  approved_at: string;
  release_status: string | null;
  release_at: string;
  updated_at: string;
  timeline: OpsTimelineEvent[];
}

/** 进度接口响应（configured=false 未配置集成；ok=false 上游失败携 error） */
export interface OpsProgressResponse {
  success?: boolean;
  configured: boolean;
  ok?: boolean;
  error?: string;
  ops: Record<string, OpsTrack>;
}

/** 处理阶段文案（与 AIOps TRACK_STAGES 同步；服务端 stage_label 为准，此处兜底） */
export const OPS_STAGE_LABELS: Record<OpsStage, string> = {
  NOT_ANALYZED: '等待智能运维系统处理',
  ANALYZING: '智能分析中',
  ANALYZED: '分析完成，待批准',
  ANALYSIS_FAILED: '分析未成功（可重试）',
  APPROVED: '已批准，修复与发布进行中',
  RELEASED: '已发布上线',
  ESCALATED: '已转人工跟进',
  CANCELLED: '修复流程已取消',
  RELEASE_FAILED: '修复流程失败',
  UNKNOWN: '状态未知',
};

/** 处理阶段配色（徽标） */
export const OPS_STAGE_CLS: Record<OpsStage, string> = {
  NOT_ANALYZED: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  ANALYZING: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  ANALYZED: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  ANALYSIS_FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  APPROVED: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  RELEASED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  ESCALATED: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  CANCELLED: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  RELEASE_FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  UNKNOWN: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

/** 时间线事件文案（分析生命周期事件额外补充） */
export const OPS_EVENT_LABELS: Record<string, string> = {
  ...OPS_STAGE_LABELS,
  ANALYSIS_STARTED: '开始分析',
  ANALYSIS_DONE: '分析完成',
};

/** 时间线事件配色（分析生命周期事件额外补充） */
export const OPS_EVENT_CLS: Record<string, string> = {
  ...OPS_STAGE_CLS,
  ANALYSIS_STARTED: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  ANALYSIS_DONE: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
};

/** 阶段/事件徽标配色安全取值（未知归入 UNKNOWN 灰） */
export const opsStageCls = (stage: string): string =>
  OPS_EVENT_CLS[stage] || OPS_STAGE_CLS.UNKNOWN;

/** 时间戳 → 紧凑展示（月/日 时:分）；空值返回「—」（存量版本无完成时间） */
export const formatOpsTime = (at: string): string => {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
