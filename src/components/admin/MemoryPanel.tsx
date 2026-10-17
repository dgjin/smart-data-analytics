/**
 * 统一记忆体管理面板（v0.9.106，仅 ADMIN）。
 *
 * 三个视图：
 * - 候选审核：点踩纠正候选（PENDING）→ 通过（可补充纠正说明/期望 SQL）或驳回；
 * - 记忆条目：已生效纠错记忆的检索、编辑、停用/启用；
 * - 顶部概览：开关（off/shadow/on）、灰度比例、待审核数、7 日注入量、手动归档。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BrainCircuit,
  CheckCircle2,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';

type ErrorType = 'TABLE_CHOICE' | 'COLUMN' | 'CALIBER' | 'UNDERSTANDING' | 'OTHER';
type ItemStatus = 'ACTIVE' | 'ARCHIVED' | 'DISABLED';

interface MemoryConfig {
  mode: 'off' | 'shadow' | 'on';
  rolloutPct: number;
  totalTokenBudget: number;
  budgets: Record<string, number>;
  autoCandidate: boolean;
  archiveDays: number;
}

interface MemoryStats {
  itemsActive: number;
  itemsArchived: number;
  candidatesPending: number;
  injected7d: number;
  correctionInjected7d: number;
  topCorrections: { id: number; question: string; hits: number; confidence: number }[];
}

interface Candidate {
  id: number;
  dataSourceId: string;
  userId: number | null;
  question: string;
  wrongSql: string;
  errorType: ErrorType;
  payload: { note?: string; expectedSql?: string; username?: string; traceId?: string };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MERGED';
  reviewedBy: string;
  reviewedAt: string | null;
  memoryId: number | null;
  createdAt: string | null;
}

interface MemoryItem {
  id: number;
  dataSourceId: string;
  userId: number | null;
  question: string;
  content: string;
  errorType: ErrorType;
  expectedSql: string;
  confidence: number;
  hits: number;
  lastUsedAt: string | null;
  status: ItemStatus;
  createdBy: string;
  createdAt: string | null;
}

const ERROR_LABELS: Record<ErrorType, string> = {
  TABLE_CHOICE: '选表错误',
  COLUMN: '字段错误',
  CALIBER: '口径/聚合错误',
  UNDERSTANDING: '理解偏差',
  OTHER: '其他',
};

const MODE_META: Record<MemoryConfig['mode'], { label: string; cls: string }> = {
  off: { label: '未启用（off）', cls: 'bg-slate-700/50 text-slate-300 border-slate-600' },
  shadow: { label: '影子模式（shadow）', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  on: { label: '已启用（on）', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
};

type Tab = 'candidates' | 'items';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(url, init);
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const msg = typeof data.error === 'string' ? data.error : `请求失败（${resp.status}）`;
    throw new Error(msg);
  }
  return data as T;
}

function shortTime(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : v;
}

export const MemoryPanel: React.FC = () => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);
  const activeDataSourceId = useAnalyticsStore((s) => s.activeDataSourceId);

  const [dsFilter, setDsFilter] = useState<string>(activeDataSourceId || '');
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [tab, setTab] = useState<Tab>('candidates');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [itemStatus, setItemStatus] = useState<ItemStatus | ''>('ACTIVE');
  const [itemQuery, setItemQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 审核表单（通过前可补充纠正说明与期望 SQL）
  const [review, setReview] = useState<{ id: number; content: string; expectedSql: string } | null>(null);
  // 条目编辑表单
  const [editing, setEditing] = useState<{ id: number; content: string; expectedSql: string; confidence: string } | null>(null);

  useEffect(() => {
    if (!dsFilter && activeDataSourceId) setDsFilter(activeDataSourceId);
  }, [activeDataSourceId, dsFilter]);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await requestJson<MemoryConfig>('/api/admin/memory/config'));
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '配置读取失败' });
    }
  }, []);

  const loadStats = useCallback(async () => {
    const qs = dsFilter ? `?dataSourceId=${encodeURIComponent(dsFilter)}` : '';
    try {
      setStats(await requestJson<MemoryStats>(`/api/admin/memory/stats${qs}`));
    } catch {
      /* 统计失败不阻断列表 */
    }
  }, [dsFilter]);

  const loadCandidates = useCallback(async () => {
    const qs = new URLSearchParams({ status: 'PENDING', limit: '20' });
    if (dsFilter) qs.set('dataSourceId', dsFilter);
    try {
      const data = await requestJson<{ total: number; items: Candidate[] }>(
        `/api/admin/memory/candidates?${qs.toString()}`
      );
      setCandidates(data.items);
      setCandidateTotal(data.total);
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '候选加载失败' });
    }
  }, [dsFilter]);

  const loadItems = useCallback(async () => {
    const qs = new URLSearchParams({ limit: '20' });
    if (dsFilter) qs.set('dataSourceId', dsFilter);
    if (itemStatus) qs.set('status', itemStatus);
    if (itemQuery.trim()) qs.set('q', itemQuery.trim());
    try {
      const data = await requestJson<{ total: number; items: MemoryItem[] }>(
        `/api/admin/memory/items?${qs.toString()}`
      );
      setItems(data.items);
      setItemTotal(data.total);
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '记忆加载失败' });
    }
  }, [dsFilter, itemStatus, itemQuery]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadConfig(), loadStats(), loadCandidates(), loadItems()]);
    setLoading(false);
  }, [loadConfig, loadStats, loadCandidates, loadItems]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const approve = async (id: number) => {
    setBusyId(id);
    try {
      await requestJson(`/api/admin/memory/candidates/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(review && review.id === id ? { content: review.content, expectedSql: review.expectedSql } : {}),
      });
      setNotice({ type: 'success', text: '已通过并生成纠错记忆，后续相似问题将自动引用' });
      setReview(null);
      await refreshAll();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '审核失败' });
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: number) => {
    setBusyId(id);
    try {
      await requestJson(`/api/admin/memory/candidates/${id}/reject`, { method: 'POST' });
      setNotice({ type: 'success', text: '已驳回该候选' });
      await refreshAll();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '驳回失败' });
    } finally {
      setBusyId(null);
    }
  };

  const saveItem = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      await requestJson(`/api/admin/memory/items/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: editing.content,
          expectedSql: editing.expectedSql,
          confidence: Number(editing.confidence),
        }),
      });
      setNotice({ type: 'success', text: '记忆已更新' });
      setEditing(null);
      await refreshAll();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '更新失败' });
    } finally {
      setBusyId(null);
    }
  };

  const toggleStatus = async (item: MemoryItem) => {
    setBusyId(item.id);
    try {
      await requestJson(`/api/admin/memory/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }),
      });
      setNotice({ type: 'success', text: item.status === 'ACTIVE' ? '已停用该记忆' : '已启用该记忆' });
      await refreshAll();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '状态更新失败' });
    } finally {
      setBusyId(null);
    }
  };

  const archive = async () => {
    setLoading(true);
    try {
      const res = await requestJson<{ archived: number }>('/api/admin/memory/archive', { method: 'POST' });
      setNotice({ type: 'success', text: `归档完成：${res.archived} 条长期未命中且低置信的记忆已归档` });
      await refreshAll();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '归档失败' });
    } finally {
      setLoading(false);
    }
  };

  const modeMeta = MODE_META[config?.mode || 'off'];

  return (
    <div className="space-y-4">
      {/* 顶部概览 */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-rose-400" />
            <h3 className="text-sm font-bold text-slate-100">统一记忆体</h3>
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${modeMeta.cls}`}>{modeMeta.label}</span>
            {config && config.mode !== 'off' && (
              <span className="text-[10px] text-slate-500">灰度 {config.rolloutPct}% · 总预算 {config.totalTokenBudget} tokens</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={dsFilter}
              onChange={(e) => setDsFilter(e.target.value)}
              className="rounded-lg bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="">全部数据源</option>
              {dataSources.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void refreshAll()}
              disabled={loading}
              className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[11px] text-slate-300 hover:text-white flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />刷新
            </button>
            <button
              onClick={() => void archive()}
              className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[11px] text-amber-300 hover:text-amber-200 flex items-center gap-1"
            >
              <Archive className="w-3 h-3" />归档低置信
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
          <StatCard label="待审核候选" value={stats?.candidatesPending ?? 0} accent="text-amber-300" />
          <StatCard label="生效纠错记忆" value={stats?.itemsActive ?? 0} accent="text-emerald-300" />
          <StatCard label="近 7 日记忆引用" value={stats?.injected7d ?? 0} accent="text-cyan-300" />
          <StatCard label="其中纠错注入" value={stats?.correctionInjected7d ?? 0} accent="text-rose-300" />
        </div>

        {config?.mode === 'off' && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              记忆体当前未启用：候选可正常采集与审核，但不会注入问数。启用方式：设置
              <code className="mx-1 px-1 rounded bg-slate-800 text-slate-200">MEMORY_ROUTER_ENABLED=shadow</code>
              观察一轮后改为 <code className="mx-1 px-1 rounded bg-slate-800 text-slate-200">on</code> 并配置灰度比例。
            </span>
          </div>
        )}
        {notice && (
          <div
            className={`mt-3 rounded-lg px-3 py-2 text-[11px] flex items-center justify-between ${
              notice.type === 'success'
                ? 'border border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                : 'border border-rose-500/40 bg-rose-950/30 text-rose-300'
            }`}
          >
            <span className="flex items-center gap-1.5">
              {notice.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              {notice.text}
            </span>
            <button onClick={() => setNotice(null)} className="text-[10px] opacity-70 hover:opacity-100">
              关闭
            </button>
          </div>
        )}
      </div>

      {/* Tab */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setTab('candidates')}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border ${
            tab === 'candidates'
              ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
              : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
        >
          候选审核{candidateTotal > 0 ? `（${candidateTotal}）` : ''}
        </button>
        <button
          onClick={() => setTab('items')}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border ${
            tab === 'items'
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
              : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
        >
          记忆条目{itemTotal > 0 ? `（${itemTotal}）` : ''}
        </button>
      </div>

      {/* 候选审核 */}
      {tab === 'candidates' && (
        <div className="space-y-2">
          {candidates.length === 0 ? (
            <EmptyHint text="暂无待审核的纠正候选。用户点踩并提交原因后，会在此出现。" />
          ) : (
            candidates.map((c) => (
              <div key={c.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-[10px] font-semibold">
                    {ERROR_LABELS[c.errorType]}
                  </span>
                  <span className="text-[11px] text-slate-200 font-semibold flex-1 min-w-[200px]">{c.question}</span>
                  <span className="text-[10px] text-slate-500">
                    {c.payload.username || '未知用户'} · {shortTime(c.createdAt)}
                  </span>
                </div>
                {c.payload.note && <p className="text-[11px] text-amber-200/90">用户说明：{c.payload.note}</p>}
                {c.payload.expectedSql && (
                  <pre className="text-[10px] font-mono text-cyan-200 bg-slate-950/70 border border-slate-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap">
                    {c.payload.expectedSql}
                  </pre>
                )}
                <details className="text-[10px] text-slate-500">
                  <summary className="cursor-pointer hover:text-slate-300">查看错误 SQL</summary>
                  <pre className="mt-1 font-mono text-slate-400 bg-slate-950/70 border border-slate-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap">
                    {c.wrongSql || '（未记录）'}
                  </pre>
                </details>

                {review?.id === c.id ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={review.content}
                      onChange={(e) => setReview({ ...review, content: e.target.value })}
                      rows={2}
                      placeholder="纠正说明（会注入后续相似问题的 prompt）"
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/60 resize-none"
                    />
                    <textarea
                      value={review.expectedSql}
                      onChange={(e) => setReview({ ...review, expectedSql: e.target.value })}
                      rows={3}
                      placeholder="期望 SQL（可选）"
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[10px] font-mono text-slate-200 focus:outline-none focus:border-cyan-500/60 resize-none"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setReview(null)} className="text-[10px] text-slate-400 hover:text-slate-200">
                        取消
                      </button>
                      <button
                        onClick={() => void approve(c.id)}
                        disabled={busyId === c.id}
                        className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold disabled:opacity-50"
                      >
                        {busyId === c.id ? '提交中…' : '确认通过'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => void reject(c.id)}
                      disabled={busyId === c.id}
                      className="px-2 py-1 rounded-lg border border-slate-700 text-[10px] text-slate-400 hover:text-rose-300 hover:border-rose-500/50 flex items-center gap-1 disabled:opacity-50"
                    >
                      <XCircle className="w-3 h-3" />驳回
                    </button>
                    <button
                      onClick={() =>
                        setReview({ id: c.id, content: c.payload.note || '', expectedSql: c.payload.expectedSql || '' })
                      }
                      className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3 h-3" />通过
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* 记忆条目 */}
      {tab === 'items' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={itemQuery}
                onChange={(e) => setItemQuery(e.target.value)}
                placeholder="搜索问题或纠正内容"
                className="w-full rounded-lg bg-slate-800 border border-slate-700 pl-7 pr-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-cyan-500/60"
              />
            </div>
            <select
              value={itemStatus}
              onChange={(e) => setItemStatus(e.target.value as ItemStatus | '')}
              className="rounded-lg bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="ACTIVE">生效中</option>
              <option value="DISABLED">已停用</option>
              <option value="ARCHIVED">已归档</option>
              <option value="">全部状态</option>
            </select>
            <button
              onClick={() => void loadItems()}
              className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[11px] text-slate-300 hover:text-white"
            >
              查询
            </button>
          </div>

          {items.length === 0 ? (
            <EmptyHint text="暂无记忆条目。审核通过候选后，纠错记忆会出现在这里。" />
          ) : (
            items.map((item) => (
              <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-slate-200 font-semibold flex-1 min-w-[200px]">{item.question}</span>
                  <span className="text-[10px] text-slate-500">置信度 {item.confidence.toFixed(2)}</span>
                  <span className="text-[10px] text-slate-500">命中 {item.hits}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded border text-[10px] ${
                      item.status === 'ACTIVE'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-600 bg-slate-800 text-slate-400'
                    }`}
                  >
                    {item.status === 'ACTIVE' ? '生效中' : item.status === 'DISABLED' ? '已停用' : '已归档'}
                  </span>
                </div>
                {editing?.id === item.id ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={editing.content}
                      onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                      rows={2}
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/60 resize-none"
                    />
                    <textarea
                      value={editing.expectedSql}
                      onChange={(e) => setEditing({ ...editing, expectedSql: e.target.value })}
                      rows={2}
                      placeholder="期望 SQL（可选）"
                      className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[10px] font-mono text-slate-200 focus:outline-none focus:border-cyan-500/60 resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-400">置信度</label>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={editing.confidence}
                        onChange={(e) => setEditing({ ...editing, confidence: e.target.value })}
                        className="w-20 rounded-lg bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                      />
                      <div className="flex-1" />
                      <button onClick={() => setEditing(null)} className="text-[10px] text-slate-400 hover:text-slate-200">
                        取消
                      </button>
                      <button
                        onClick={() => void saveItem()}
                        disabled={busyId === item.id}
                        className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] font-semibold disabled:opacity-50"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-[11px] text-slate-400 whitespace-pre-wrap">{item.content}</p>
                    {item.expectedSql && (
                      <pre className="text-[10px] font-mono text-cyan-200/80 bg-slate-950/70 border border-slate-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap">
                        {item.expectedSql}
                      </pre>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-500">
                        {ERROR_LABELS[item.errorType]} · 最近命中 {shortTime(item.lastUsedAt)}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() =>
                            setEditing({
                              id: item.id,
                              content: item.content,
                              expectedSql: item.expectedSql,
                              confidence: String(item.confidence),
                            })
                          }
                          className="px-2 py-0.5 rounded border border-slate-700 text-[10px] text-slate-400 hover:text-cyan-300 flex items-center gap-1"
                        >
                          <Pencil className="w-3 h-3" />编辑
                        </button>
                        <button
                          onClick={() => void toggleStatus(item)}
                          disabled={busyId === item.id}
                          className={`px-2 py-0.5 rounded border text-[10px] ${
                            item.status === 'ACTIVE'
                              ? 'border-slate-700 text-slate-400 hover:text-amber-300'
                              : 'border-slate-700 text-slate-400 hover:text-emerald-300'
                          } disabled:opacity-50`}
                        >
                          {item.status === 'ACTIVE' ? '停用' : '启用'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number; accent: string }> = ({ label, value, accent }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
    <div className="text-[10px] text-slate-500">{label}</div>
    <div className={`text-lg font-bold ${accent}`}>{value}</div>
  </div>
);

const EmptyHint: React.FC<{ text: string }> = ({ text }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-[11px] text-slate-500">
    <Loader2 className="w-4 h-4 mx-auto mb-2 opacity-40" />
    {text}
  </div>
);
