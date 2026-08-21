import React, { useCallback, useEffect, useState } from 'react';
import {
  BookMarked,
  RefreshCw,
  Plus,
  CheckCircle2,
  XCircle,
  Trash2,
  History,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';

/**
 * P1-8 指标层治理面板：语义指标的提议 / 审批 / 驳回 / 版本化回溯管理。
 * - ADMIN：直接创建生效、审批/驳回提议、编辑、停用、删除、版本回溯
 * - ANALYST：提交提议（PENDING）待审批，被驳回可重新提议
 * 未审批（PENDING/REJECTED）指标不会进入问数生产 linking。
 */

type MetricStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DISABLED';

interface MetricItem {
  id: number;
  dataSourceId: string;
  name: string;
  aliases: string[];
  description: string;
  expr: string;
  tableName: string;
  filters: string;
  status: MetricStatus;
  version?: number;
  approvedBy?: string;
  approvedAt?: string | null;
  createdBy?: string;
}

interface VersionEntry {
  version: number;
  action: string;
  actor: string;
  createdAt: string;
  snapshot: Partial<MetricItem>;
}

const STATUS_META: Record<MetricStatus, { label: string; cls: string }> = {
  PENDING: { label: '待审批', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  ACTIVE: { label: '已生效', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  REJECTED: { label: '已驳回', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  DISABLED: { label: '已停用', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

const ACTION_LABELS: Record<string, string> = {
  CREATE: '创建',
  APPROVE: '审批生效',
  UPDATE: '变更',
  RESTORE: '回溯',
};

export const MetricsPanel: React.FC = () => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'ADMIN';

  const [dataSourceId, setDataSourceId] = useState('');
  const [metrics, setMetrics] = useState<MetricItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 创建/提议表单
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState({ name: '', aliases: '', description: '', expr: '', tableName: '', filters: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 版本历史弹窗
  const [versionsFor, setVersionsFor] = useState<MetricItem | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 默认选中第一个数据源
  useEffect(() => {
    if (!dataSourceId && dataSources.length > 0) setDataSourceId(dataSources[0].id);
  }, [dataSources, dataSourceId]);

  const loadMetrics = useCallback(async () => {
    if (!dataSourceId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/metrics?dataSourceId=${encodeURIComponent(dataSourceId)}`);
      const data = await res.json();
      if (res.ok && data.metrics) {
        setMetrics(data.metrics);
      } else {
        showNotice('error', data.error || '加载指标失败');
      }
    } catch (err: any) {
      showNotice('error', err.message || '加载指标失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId]);

  useEffect(() => {
    const timer = setTimeout(() => loadMetrics(), 0);
    return () => clearTimeout(timer);
  }, [loadMetrics]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId,
          name: form.name.trim(),
          aliases: form.aliases.split(/[,，、]/).map((a) => a.trim()).filter(Boolean),
          description: form.description.trim(),
          expr: form.expr.trim(),
          tableName: form.tableName.trim(),
          filters: form.filters.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '提交失败');
      showNotice('success', data.status === 'PENDING' ? `指标「${form.name.trim()}」已提交，待管理员审批` : `指标「${form.name.trim()}」已创建生效`);
      setIsCreating(false);
      setForm({ name: '', aliases: '', description: '', expr: '', tableName: '', filters: '' });
      loadMetrics();
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAction = async (m: MetricItem, action: 'approve' | 'reject' | 'repropose') => {
    const labels = { approve: '审批通过', reject: '驳回', repropose: '重新提议' };
    try {
      const res = await apiFetch(`/api/metrics/${m.id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `${labels[action]}失败`);
      showNotice('success', `已${labels[action]}「${m.name}」`);
      loadMetrics();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleToggleStatus = async (m: MetricItem) => {
    const next = m.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      const res = await apiFetch(`/api/metrics/${m.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: m.name,
          aliases: m.aliases,
          description: m.description,
          expr: m.expr,
          tableName: m.tableName,
          filters: m.filters,
          status: next,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '操作失败');
      showNotice('success', next === 'ACTIVE' ? `已启用「${m.name}」` : `已停用「${m.name}」`);
      loadMetrics();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleDelete = async (m: MetricItem) => {
    if (!window.confirm(`确认删除指标「${m.name}」？此操作不可恢复。`)) return;
    try {
      const res = await apiFetch(`/api/metrics/${m.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败');
      showNotice('success', `已删除「${m.name}」`);
      loadMetrics();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const openVersions = async (m: MetricItem) => {
    setVersionsFor(m);
    setVersions([]);
    try {
      const res = await apiFetch(`/api/metrics/${m.id}/versions`);
      const data = await res.json();
      if (res.ok) setVersions(data.versions || []);
    } catch {
      showNotice('error', '加载版本历史失败');
    }
  };

  const handleRestore = async (m: MetricItem, version: number) => {
    if (!window.confirm(`确认将「${m.name}」回溯到版本 v${version}？当前口径将保存为新版本。`)) return;
    try {
      const res = await apiFetch(`/api/metrics/${m.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '回溯失败');
      showNotice('success', `已回溯「${m.name}」到 v${version} 口径`);
      setVersionsFor(null);
      loadMetrics();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const pendingCount = metrics.filter((m) => m.status === 'PENDING').length;

  return (
    <div className="space-y-4">
      {/* 工具条：数据源选择 + 新建 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-3">
          <BookMarked className="w-4 h-4 text-indigo-400" />
          <span className="text-xs font-bold text-slate-300">语义指标库</span>
          <select
            value={dataSourceId}
            onChange={(e) => setDataSourceId(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            {dataSources.map((ds) => (
              <option key={ds.id} value={ds.id}>{ds.name}</option>
            ))}
          </select>
          {pendingCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold">
              {pendingCount} 条待审批
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => loadMetrics()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
          <button
            onClick={() => setIsCreating((v) => !v)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{isAdmin ? '新建指标' : '提议指标'}</span>
          </button>
        </div>
      </div>

      {/* Notice */}
      {notice && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* 创建/提议表单 */}
      {isCreating && (
        <form onSubmit={handleCreate} className="bg-slate-900 border border-indigo-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
          <h3 className="font-bold text-slate-100 text-sm border-b border-slate-800 pb-2">
            {isAdmin ? '新建指标（直接生效）' : '提议指标（提交后待管理员审批）'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">指标名（≤50字）:</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 有效客户数" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">聚合表达式:</label>
              <input value={form.expr} onChange={(e) => setForm({ ...form, expr: e.target.value })} placeholder="COUNT(DISTINCT id)" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">归属表:</label>
              <input value={form.tableName} onChange={(e) => setForm({ ...form, tableName: e.target.value })} placeholder="customer" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">同义词（逗号分隔）:</label>
              <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="有效客户, 活跃客户" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">固定过滤（可空）:</label>
              <input value={form.filters} onChange={(e) => setForm({ ...form, filters: e.target.value })} placeholder="status = 'active'" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">口径说明:</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="面向人的口径解释" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500" />
            </div>
          </div>
          <div className="flex items-center justify-end space-x-2 pt-1">
            <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700">取消</button>
            <button type="submit" disabled={isSubmitting || !form.name.trim() || !form.expr.trim() || !form.tableName.trim()} className="px-5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow">
              {isSubmitting ? '提交中…' : isAdmin ? '确认创建' : '提交审批'}
            </button>
          </div>
        </form>
      )}

      {/* 指标列表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-4 py-3 font-medium">指标</th>
                <th className="px-4 py-3 font-medium">口径</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">版本</th>
                <th className="px-4 py-3 font-medium">提议/审批</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => {
                const meta = STATUS_META[m.status] || STATUS_META.ACTIVE;
                return (
                  <tr key={m.id} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-200">{m.name}</div>
                      {m.aliases.length > 0 && <div className="text-[10px] text-slate-500">同义词：{m.aliases.join('、')}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-[11px] text-indigo-300">{m.expr}</code>
                      <div className="text-[10px] text-slate-500">
                        表 {m.tableName}{m.filters ? ` · WHERE ${m.filters}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">v{m.version || 1}</td>
                    <td className="px-4 py-3 text-slate-500 text-[10px]">
                      <div>提议：{m.createdBy || '-'}</div>
                      {m.approvedBy && <div>审批：{m.approvedBy}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end space-x-1.5">
                        {isAdmin && m.status === 'PENDING' && (
                          <>
                            <button onClick={() => handleAction(m, 'approve')} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40 text-[11px] font-medium transition-colors">
                              <CheckCircle2 className="w-3 h-3" /><span>通过</span>
                            </button>
                            <button onClick={() => handleAction(m, 'reject')} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                              <XCircle className="w-3 h-3" /><span>驳回</span>
                            </button>
                          </>
                        )}
                        {!isAdmin && m.status === 'REJECTED' && m.createdBy === currentUser?.username && (
                          <button onClick={() => handleAction(m, 'repropose')} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-amber-800/60 text-amber-300 hover:bg-amber-950/40 text-[11px] font-medium transition-colors">
                            <RotateCcw className="w-3 h-3" /><span>重新提议</span>
                          </button>
                        )}
                        <button onClick={() => openVersions(m)} title="版本历史" className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <History className="w-3 h-3" /><span>历史</span>
                        </button>
                        {isAdmin && (m.status === 'ACTIVE' || m.status === 'DISABLED') && (
                          <button onClick={() => handleToggleStatus(m)} className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors ${m.status === 'ACTIVE' ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40'}`}>
                            {m.status === 'ACTIVE' ? '停用' : '启用'}
                          </button>
                        )}
                        {isAdmin && (
                          <button onClick={() => handleDelete(m)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                            <Trash2 className="w-3 h-3" /><span>删除</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && metrics.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">该数据源暂无指标定义</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 版本历史弹窗 */}
      {versionsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setVersionsFor(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
                <History className="w-4 h-4 text-indigo-400" />
                <span>「{versionsFor.name}」版本历史</span>
              </h3>
              <button onClick={() => setVersionsFor(null)} className="text-slate-400 hover:text-slate-200 text-xs">关闭</button>
            </div>
            {versions.length === 0 && <p className="text-xs text-slate-500 py-4 text-center">暂无版本历史</p>}
            {versions.map((v) => (
              <div key={`${v.version}-${v.createdAt}`} className="border border-slate-800 rounded-xl p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-slate-200">v{v.version}</span>
                    <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 text-[10px] font-semibold">{ACTION_LABELS[v.action] || v.action}</span>
                    <span className="text-slate-500 text-[10px]">{v.actor} · {v.createdAt ? new Date(v.createdAt).toLocaleString('zh-CN') : ''}</span>
                  </div>
                  {isAdmin && versionsFor.status !== 'PENDING' && (
                    <button onClick={() => handleRestore(versionsFor, v.version)} className="px-2 py-0.5 rounded-lg border border-amber-800/60 text-amber-300 hover:bg-amber-950/40 text-[10px] font-medium transition-colors">
                      回溯到此版本
                    </button>
                  )}
                </div>
                {v.snapshot.expr && (
                  <div className="text-slate-400">
                    <code className="text-indigo-300">{v.snapshot.expr}</code>
                    <span className="text-slate-500"> · 表 {v.snapshot.tableName}{v.snapshot.filters ? ` · WHERE ${v.snapshot.filters}` : ''}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
