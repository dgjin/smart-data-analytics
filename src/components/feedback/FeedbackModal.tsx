/**
 * v0.9.98 需求收集与意见反馈弹窗（用户侧，Header 入口）：
 * 上半区提交需求/建议/缺陷/其他 → 管理员评估分析 → 纳入基线后经标准接口供 AIOps 主动分析；
 * 下半区「我的反馈」展示处理状态（待评估 / 已纳入基线 / 未采纳）与管理员评估意见。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  MessageSquarePlus,
  X,
  Send,
  RefreshCw,
  Clock,
  BadgeCheck,
  XCircle,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  FeedbackEntry,
  FeedbackKind,
  FeedbackStatus,
  KIND_LABELS,
  STATUS_META,
  isKind,
  isStatus,
} from '../../types/requirements';

/** 状态图标（文案与配色复用共享 STATUS_META） */
const STATUS_ICONS: Record<FeedbackStatus, React.ElementType> = {
  PENDING: Clock,
  BASELINED: BadgeCheck,
  REJECTED: XCircle,
};

export const FeedbackModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [kind, setKind] = useState<FeedbackKind>('REQUIREMENT');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMine = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/requirements/mine');
      const data = await res.json();
      if (data.success) setEntries(data.entries || []);
    } catch {
      /* 列表加载失败不阻断提交 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMine();
  }, [loadMine]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const submit = async () => {
    if (!title.trim() || !content.trim() || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, title: title.trim(), content: content.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '提交失败');
      setNotice({ type: 'success', text: '已提交，管理员评估后将更新状态' });
      setTitle('');
      setContent('');
      void loadMine();
    } catch (err) {
      setNotice({ type: 'error', text: getErrorMessage(err) || '提交失败' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
            <MessageSquarePlus className="w-4 h-4 text-cyan-400" />
            <span>需求收集与意见反馈</span>
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* 提交表单 */}
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-300 font-medium">类型</label>
              <div className="flex items-center gap-2 flex-wrap">
                {(Object.keys(KIND_LABELS) as FeedbackKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                      kind === k
                        ? 'bg-cyan-600 text-white border-cyan-500'
                        : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    {KIND_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-300 font-medium">标题</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="一句话概括你的需求或意见（200 字以内）"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-300 font-medium">内容描述</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="请描述场景、期望效果或复现步骤，便于管理员评估分析"
                className="w-full resize-none bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
              />
            </div>
            {notice && (
              <div
                className={`p-2.5 rounded-lg border text-[11px] ${
                  notice.type === 'success'
                    ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                    : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
                }`}
              >
                {notice.text}
              </div>
            )}
            <div className="flex items-center justify-end">
              <button
                onClick={() => void submit()}
                disabled={!title.trim() || !content.trim() || submitting}
                className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{submitting ? '提交中…' : '提交'}</span>
              </button>
            </div>
          </div>

          {/* 我的反馈 */}
          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-300">我的反馈（{entries.length}）</span>
              <button
                onClick={() => void loadMine()}
                disabled={loading}
                className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                <span>刷新</span>
              </button>
            </div>
            {entries.length === 0 && !loading && (
              <p className="text-[11px] text-slate-500 py-2">暂无提交记录</p>
            )}
            <div className="space-y-2">
              {entries.map((e) => {
                const meta = isStatus(e.status) ? STATUS_META[e.status] : STATUS_META.PENDING;
                const Icon = STATUS_ICONS[e.status];
                return (
                  <div key={e.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-200 font-medium truncate" title={e.title}>
                        {e.title}
                      </span>
                      <span className={`shrink-0 inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>
                        <Icon className="w-2.5 h-2.5" />
                        <span>{meta.label}</span>
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {isKind(e.kind) ? KIND_LABELS[e.kind] : e.kind}
                      {e.priority && ` · ${e.priority}`}
                      {e.baselineVersion && ` · 基线 ${e.baselineVersion}`}
                      {e.createdAt && ` · ${new Date(e.createdAt).toLocaleString()}`}
                    </div>
                    {e.assessment && (
                      <div className="text-[10px] text-slate-400 bg-slate-900/80 rounded-lg px-2 py-1.5 leading-relaxed">
                        评估意见：{e.assessment}
                        {e.reviewer && <span className="text-slate-500">（{e.reviewer}）</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end px-6 py-3 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
