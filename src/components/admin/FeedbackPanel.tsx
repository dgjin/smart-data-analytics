/**
 * v0.9.98 需求反馈管理面板（系统管理「治理与审核 › 需求反馈」）：
 * 统计摘要 + 状态/类型筛选 + 评估分析（纳入基线 / 不予采纳 / 退回待评估）+ 删除；
 * 录入：管理员可直接录入需求反馈（类型/标题/内容/优先级，必填与格式校验后经
 * POST /api/requirements 落库，录入成功即刷新列表）；
 * 「已纳入基线」条目经 /api/requirements/export 标准接口提供给 AIOps 平台主动分析。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Lightbulb,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  BadgeCheck,
  XCircle,
  ClipboardCheck,
  FilePlus2,
  Trash2,
  ChevronDown,
  ChevronUp,
  Search,
  X,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import { matchFieldSearch } from '../../utils/pinyin';
import {
  FeedbackEntry,
  FeedbackKind,
  FeedbackStatus,
  KIND_LABELS,
  REVIEW_ACTION_CLS,
  REVIEW_ACTION_LABELS,
  STATUS_META,
  isKind,
  isReviewAction,
  isStatus,
} from '../../types/requirements';

type StatusFilter = '' | FeedbackStatus;
type ReviewAction = 'BASELINE' | 'REJECT' | 'PENDING';

interface SummaryData {
  byStatus: { status: string; cnt: number }[];
  byKind: { kind: string; cnt: number }[];
  byPriority: { priority: string; cnt: number }[];
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

const STATUS_ICONS: Record<FeedbackStatus, React.ElementType> = {
  PENDING: Clock,
  BASELINED: BadgeCheck,
  REJECTED: XCircle,
};

/** 状态筛选页签（'' = 全部） */
const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: '', label: '全部' },
  { id: 'PENDING', label: '待评估' },
  { id: 'BASELINED', label: '已纳入基线' },
  { id: 'REJECTED', label: '未采纳' },
];

// ---------- 评估弹窗 ----------

const ReviewDialog: React.FC<{
  entry: FeedbackEntry;
  onClose: () => void;
  onDone: (text: string) => void;
}> = ({ entry, onClose, onDone }) => {
  // v0.9.102 继续评估：已评估条目预填上次结论（优先级/基线版本/评估意见），
  // 修改后保存即追加一条新评估记录（历史保留），避免空白表单误覆盖原有结论
  const [action, setAction] = useState<ReviewAction>(() => (entry.status === 'REJECTED' ? 'REJECT' : 'BASELINE'));
  const [priority, setPriority] = useState(entry.priority || 'P2');
  const [baselineVersion, setBaselineVersion] = useState(entry.baselineVersion || '');
  const [assessment, setAssessment] = useState(entry.assessment || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const reviewedTimes = entry.revisions?.length || (entry.reviewedAt ? 1 : 0);

  const submit = async () => {
    if (submitting) return;
    if (action === 'BASELINE' && !assessment.trim()) {
      setError('纳入基线前须填写评估分析意见');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch(`/api/requirements/${entry.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'BASELINE' ? { priority, baselineVersion: baselineVersion.trim() } : {}),
          assessment: assessment.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '评估操作失败');
      const label =
        action === 'BASELINE' ? `已纳入基线${baselineVersion.trim() ? `（${baselineVersion.trim()}）` : ''}` : action === 'REJECT' ? '已标记不予采纳' : '已退回待评估';
      onDone(`#${entry.id} ${label}`);
    } catch (err) {
      setError(getErrorMessage(err) || '评估操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800">
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
            <ClipboardCheck className="w-4 h-4 text-cyan-400" />
            <span>评估分析 #{entry.id}</span>
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 条目概要 */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-1">
            <div className="flex items-center space-x-2 text-[11px] text-slate-400">
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                {isKind(entry.kind) ? KIND_LABELS[entry.kind] : entry.kind}
              </span>
              <span>
                {entry.submitter}
                {entry.department ? ` · ${entry.department}` : ''}
              </span>
              {entry.createdAt && <span>· {new Date(entry.createdAt).toLocaleString()}</span>}
            </div>
            <p className="text-xs text-slate-200 font-semibold">{entry.title}</p>
            <p className="text-[11px] text-slate-400 whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
              {entry.content}
            </p>
          </div>

          {/* 继续评估提示：已评估条目带回历史结论，保存后追加记录 */}
          {reviewedTimes > 0 && (
            <div className="rounded-lg border border-cyan-800/50 bg-cyan-950/30 px-3 py-2 text-[11px] text-cyan-300/90 leading-relaxed">
              该条目已完成 {reviewedTimes} 次评估，表单已带入上次结论；保存后将追加第 {reviewedTimes + 1} 次评估记录（历史保留，可供智能运维同步获取）。
            </div>
          )}

          {/* 决策动作 */}
          <div className="space-y-1">
            <label className="text-xs text-slate-300 font-medium">评估结论</label>
            <div className="flex items-center gap-2">
              {(
                [
                  { id: 'BASELINE', label: '纳入基线', cls: 'bg-emerald-600 border-emerald-500' },
                  { id: 'REJECT', label: '不予采纳', cls: 'bg-rose-600 border-rose-500' },
                  { id: 'PENDING', label: '退回待评估', cls: 'bg-slate-600 border-slate-500' },
                ] as { id: ReviewAction; label: string; cls: string }[]
              ).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAction(a.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    action === a.id ? `${a.cls} text-white` : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {action === 'BASELINE' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-slate-300 font-medium">优先级</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-600/70"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-300 font-medium">基线版本（可选）</label>
                <input
                  value={baselineVersion}
                  onChange={(e) => setBaselineVersion(e.target.value)}
                  maxLength={50}
                  placeholder={`如 v${import.meta.env.VITE_APP_VERSION || ''}`}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
                />
              </div>
            </div>
          )}

          {action !== 'PENDING' && (
            <div className="space-y-1">
              <label className="text-xs text-slate-300 font-medium">
                评估分析意见{action === 'BASELINE' ? '（必填，随基线提供给 AIOps 分析）' : '（可选，说明原因）'}
              </label>
              <textarea
                value={assessment}
                onChange={(e) => setAssessment(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="价值判断、实现成本、排期建议等"
                className="w-full resize-none bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
              />
            </div>
          )}
          {action === 'PENDING' && (
            <p className="text-[11px] text-slate-500">退回待评估：清空优先级与基线字段，保留既有评估笔记便于再评估。</p>
          )}

          {error && (
            <div className="p-2.5 rounded-lg border bg-rose-950/60 border-rose-800/60 text-rose-300 text-[11px]">{error}</div>
          )}
        </div>
        <div className="flex items-center justify-end space-x-2 px-5 py-3 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow"
          >
            {submitting ? '提交中…' : '确认评估'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------- 录入弹窗（系统管理「需求反馈录入」） ----------

const EntryDialog: React.FC<{
  onClose: () => void;
  onDone: (text: string) => void;
}> = ({ onClose, onDone }) => {
  const [kind, setKind] = useState<FeedbackKind>('REQUIREMENT');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState('P2');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (submitting) return;
    if (!title.trim()) {
      setError('请填写标题');
      return;
    }
    if (!content.trim()) {
      setError('请填写内容描述');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, title: title.trim(), content: content.trim(), priority }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '录入失败');
      onDone(`已录入需求反馈 #${data.id}`);
    } catch (err) {
      setError(getErrorMessage(err) || '录入失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800">
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
            <FilePlus2 className="w-4 h-4 text-cyan-400" />
            <span>需求反馈录入</span>
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 类型 */}
          <div className="space-y-1">
            <label className="text-xs text-slate-300 font-medium">类型</label>
            <div className="flex items-center gap-2 flex-wrap">
              {(Object.keys(KIND_LABELS) as FeedbackKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    kind === k ? 'bg-cyan-600 text-white border-cyan-500' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                  }`}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          {/* 标题（必填） */}
          <div className="space-y-1">
            <label className="text-xs text-slate-300 font-medium">
              标题<span className="text-rose-400"> *</span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="一句话概括需求或意见（200 字以内）"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
            />
          </div>

          {/* 内容描述（必填） */}
          <div className="space-y-1">
            <label className="text-xs text-slate-300 font-medium">
              内容描述<span className="text-rose-400"> *</span>
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              maxLength={5000}
              placeholder="请描述场景、期望效果或验收要点，便于后续评估分析"
              className="w-full resize-none bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
            />
          </div>

          {/* 优先级 */}
          <div className="space-y-1">
            <label className="text-xs text-slate-300 font-medium">优先级</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-600/70"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="p-2.5 rounded-lg border bg-rose-950/60 border-rose-800/60 text-rose-300 text-[11px]">{error}</div>
          )}
        </div>
        <div className="flex items-center justify-end space-x-2 px-5 py-3 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow"
          >
            {submitting ? '录入中…' : '确认录入'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------- 主面板 ----------

export const FeedbackPanel: React.FC = () => {
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [kindFilter, setKindFilter] = useState<'' | FeedbackKind>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [reviewTarget, setReviewTarget] = useState<FeedbackEntry | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (kindFilter) params.set('kind', kindFilter);
      const [listRes, summaryRes] = await Promise.all([
        apiFetch(`/api/requirements${params.size ? `?${params.toString()}` : ''}`),
        apiFetch('/api/requirements/summary'),
      ]);
      const listData = await listRes.json();
      const summaryData = await summaryRes.json();
      if (listData.success) setEntries(listData.entries || []);
      else showNotice('error', listData.error || '列表获取失败');
      if (summaryData.success) setSummary(summaryData);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '列表获取失败');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, kindFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const remove = async (e: FeedbackEntry) => {
    if (deletingId) return;
    if (!window.confirm(`确认删除 #${e.id}「${e.title}」？删除后不可恢复。`)) return;
    setDeletingId(e.id);
    try {
      const res = await apiFetch(`/api/requirements/${e.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
      showNotice('success', `#${e.id} 已删除`);
      void loadData();
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  const countOf = (status: FeedbackStatus) =>
    summary?.byStatus.find((r) => r.status === status)?.cnt ?? 0;

  const priorityCount = (p: string) => summary?.byPriority.find((r) => r.priority === p)?.cnt ?? 0;

  // 关键词前端过滤：标题/内容（含拼音首字母，如 xq 命中「需求」）或提交人；空关键词显示全部
  const keyword = searchQuery.trim();
  const filteredEntries = useMemo(
    () =>
      keyword
        ? entries.filter((e) => matchFieldSearch(keyword, e.title, e.content) || matchFieldSearch(keyword, e.submitter))
        : entries,
    [entries, keyword],
  );

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
      {/* 头部：标题 + 刷新 */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
        <div className="flex items-center space-x-2 text-xs font-bold text-slate-300">
          <Lightbulb className="w-4 h-4 text-cyan-400" />
          <span>需求收集与意见反馈（基线条目经标准接口供 AIOps 主动分析）</span>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setEntryOpen(true)}
            className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow transition-colors"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            <span>录入反馈</span>
          </button>
          <button
            onClick={() => void loadData()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* 统计摘要 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-5 py-3 border-b border-slate-800 bg-slate-950/40">
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 px-3 py-2">
          <div className="text-[10px] text-amber-300/80 font-medium">待评估</div>
          <div className="text-lg font-bold text-amber-300">{countOf('PENDING')}</div>
        </div>
        <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2">
          <div className="text-[10px] text-emerald-300/80 font-medium">已纳入基线</div>
          <div className="text-lg font-bold text-emerald-300">{countOf('BASELINED')}</div>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 px-3 py-2">
          <div className="text-[10px] text-slate-400 font-medium">未采纳</div>
          <div className="text-lg font-bold text-slate-300">{countOf('REJECTED')}</div>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 px-3 py-2">
          <div className="text-[10px] text-slate-400 font-medium">基线优先级分布</div>
          <div className="flex items-center gap-2 mt-1">
            {PRIORITIES.map((p) => (
              <span key={p} className="text-[11px] text-slate-300">
                {p} <b className="text-slate-100">{priorityCount(p)}</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      {notice && (
        <div
          className={`mx-5 mt-3 p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* 筛选 */}
      <div className="flex items-center justify-between px-5 py-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2 overflow-x-auto">
          {STATUS_TABS.map((t) => (
            <button
              key={t.id || 'all'}
              onClick={() => setStatusFilter(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap border transition-colors ${
                statusFilter === t.id
                  ? 'bg-cyan-600 text-white border-cyan-500'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索标题 / 内容 / 提交人…"
              aria-label="搜索需求反馈"
              className="w-56 pl-8 pr-7 py-1.5 rounded-lg border border-slate-700 bg-slate-950/60 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                title="清空搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as '' | FeedbackKind)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-600/70"
          >
            <option value="">全部类型</option>
            {(Object.keys(KIND_LABELS) as FeedbackKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 列表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
              <th className="px-5 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">类型</th>
              <th className="px-4 py-3 font-medium">标题</th>
              <th className="px-4 py-3 font-medium">提交人</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">优先级/基线</th>
              <th className="px-4 py-3 font-medium">更新时间</th>
              <th className="px-5 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.length === 0 && !isLoading && (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-slate-500">
                  {keyword ? `未找到与「${keyword}」匹配的条目，可尝试更短的关键词或清空搜索` : '暂无条目'}
                </td>
              </tr>
            )}
            {filteredEntries.map((e) => {
              const meta = isStatus(e.status) ? STATUS_META[e.status] : STATUS_META.PENDING;
              const Icon = STATUS_ICONS[e.status] || Clock;
              const expanded = expandedId === e.id;
              return (
                <React.Fragment key={e.id}>
                  <tr
                    className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors cursor-pointer"
                    onClick={() => setExpandedId(expanded ? null : e.id)}
                  >
                    <td className="px-5 py-3 font-mono text-slate-400">#{e.id}</td>
                    <td className="px-4 py-3">{isKind(e.kind) ? KIND_LABELS[e.kind] : e.kind}</td>
                    <td className="px-4 py-3 max-w-[280px]">
                      <span className="flex items-center gap-1 min-w-0">
                        {expanded ? (
                          <ChevronUp className="w-3 h-3 shrink-0 text-slate-500" />
                        ) : (
                          <ChevronDown className="w-3 h-3 shrink-0 text-slate-500" />
                        )}
                        <span className="truncate text-slate-200" title={e.title}>
                          {e.title}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-slate-200">{e.submitter}</span>
                      {e.department && <span className="block text-[10px] text-slate-500">{e.department}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>
                        <Icon className="w-2.5 h-2.5" />
                        <span>{meta.label}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {e.priority ? (
                        <span className="font-semibold text-slate-200">{e.priority}</span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                      {e.baselineVersion && <span className="block text-[10px] text-emerald-400/80">{e.baselineVersion}</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {e.updatedAt ? new Date(e.updatedAt).toLocaleString() : '-'}
                    </td>
                    <td className="px-5 py-3 text-right space-x-2 whitespace-nowrap" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        onClick={() => setReviewTarget(e)}
                        className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-cyan-600/15 text-cyan-300 border border-cyan-700/40 hover:bg-cyan-600/25 text-[11px] font-semibold transition-colors"
                        title={e.reviewedAt ? '继续评估（历史保留，可再次调整结论）' : '评估分析'}
                      >
                        <ClipboardCheck className="w-3.5 h-3.5" />
                        <span>{e.reviewedAt ? '继续评估' : '评估'}</span>
                      </button>
                      <button
                        onClick={() => void remove(e)}
                        disabled={deletingId === e.id}
                        className="inline-flex items-center px-2 py-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 border border-transparent hover:border-rose-800/50 transition-colors"
                        title="删除条目"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-slate-800/60 bg-slate-950/60">
                      <td colSpan={8} className="px-8 py-3 space-y-2">
                        <p className="text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed">{e.content}</p>
                        <div className="flex items-center gap-4 text-[10px] text-slate-500 flex-wrap">
                          <span>提交：{e.createdAt ? new Date(e.createdAt).toLocaleString() : '-'}</span>
                          {e.reviewedAt && <span>评估：{new Date(e.reviewedAt).toLocaleString()}</span>}
                          {e.reviewer && <span>评估人：{e.reviewer}</span>}
                        </div>
                        {e.assessment && (
                          <div className="text-[11px] text-slate-400 bg-slate-900/80 border border-slate-800 rounded-lg px-3 py-2 leading-relaxed">
                            评估意见：{e.assessment}
                          </div>
                        )}
                        {/* v0.9.102 评估记录时间线：多次评估（继续评估）的新内容逐条留痕 */}
                        {e.revisions && e.revisions.length > 1 && (
                          <div className="space-y-1.5">
                            <div className="text-[10px] font-medium text-slate-500">
                              评估记录（{e.revisions.length} 次）
                            </div>
                            {e.revisions.map((rev) => (
                              <div key={rev.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                                <span className="shrink-0 text-slate-500 tabular-nums">
                                  {rev.createdAt ? new Date(rev.createdAt).toLocaleString() : '-'}
                                </span>
                                <span
                                  className={`shrink-0 px-1.5 py-px rounded-full border text-[10px] font-semibold ${
                                    isReviewAction(rev.action)
                                      ? REVIEW_ACTION_CLS[rev.action]
                                      : 'bg-slate-800 text-slate-400 border-slate-700'
                                  }`}
                                >
                                  {isReviewAction(rev.action) ? REVIEW_ACTION_LABELS[rev.action] : rev.action}
                                </span>
                                <span className="shrink-0 text-slate-400">{rev.reviewer || '-'}</span>
                                {rev.priority && <span className="shrink-0 font-semibold text-slate-300">{rev.priority}</span>}
                                {rev.baselineVersion && (
                                  <span className="shrink-0 text-emerald-400/80">{rev.baselineVersion}</span>
                                )}
                                {rev.assessment && <span className="min-w-0 text-slate-300">{rev.assessment}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 评估弹窗 */}
      {reviewTarget && (
        <ReviewDialog
          entry={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onDone={(text) => {
            setReviewTarget(null);
            showNotice('success', text);
            void loadData();
          }}
        />
      )}

      {/* 录入弹窗 */}
      {entryOpen && (
        <EntryDialog
          onClose={() => setEntryOpen(false)}
          onDone={(text) => {
            setEntryOpen(false);
            showNotice('success', text);
            void loadData();
          }}
        />
      )}
    </div>
  );
};
