import React, { useCallback, useEffect, useState } from 'react';
import {
  Radar,
  RefreshCw,
  Plus,
  Play,
  Pause,
  Trash2,
  History,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Database,
  Clock,
  X,
  Loader2,
  BellRing,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { apiFetch } from '../../api/client';
import { PatrolPlan, PatrolRun, AnomalyItem } from '../../types/analytics';

/**
 * P0-1 异常巡检面板：数据源级巡检计划管理 + 异常预警结果展示（无页头/容器的内容组件）。
 * 巡检复用报表异常检测引擎（Z-Score/阈值），到期自动扫描该数据源最新真实数据（live）决策报表；
 * 团队共享巡检结果，创建/启停/立即执行限 ADMIN/ANALYST（服务端同样强校验）。
 * 挂载于系统管理「异常巡检」分类（v0.9.52 起为巡检唯一入口）。
 */

/** 巡检间隔预设（分钟 → 展示文案） */
const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: '每 15 分钟' },
  { value: 60, label: '每小时' },
  { value: 360, label: '每 6 小时' },
  { value: 720, label: '每 12 小时' },
  { value: 1440, label: '每天' },
  { value: 10080, label: '每周' },
];

function formatInterval(minutes: number): string {
  const hit = INTERVAL_OPTIONS.find((o) => o.value === minutes);
  if (hit) return hit.label;
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

function formatTime(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}

const RUN_STATUS_META: Record<string, { label: string; cls: string }> = {
  ANOMALY: { label: '发现异常', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  CLEAN: { label: '正常', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  NO_DATA: { label: '无可扫描报表', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  ERROR: { label: '执行失败', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
};

const SEVERITY_META: Record<string, { label: string; cls: string }> = {
  high: { label: '高', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40' },
  medium: { label: '中', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  low: { label: '低', cls: 'bg-slate-500/20 text-slate-300 border-slate-500/40' },
};

export const PatrolPanel: React.FC = () => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);
  const activeDataSourceId = useAnalyticsStore((s) => s.activeDataSourceId);
  const user = useAuthStore((s) => s.user);
  const canManage = user?.role === 'ADMIN' || user?.role === 'ANALYST';
  const isAdmin = user?.role === 'ADMIN';

  const [patrols, setPatrols] = useState<PatrolPlan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 新建表单
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ dataSourceId: '', name: '', intervalMinutes: 1440 });
  const [submitting, setSubmitting] = useState(false);

  // 运行中标记（立即巡检 / 启停 / 删除）
  const [runningId, setRunningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 运行历史弹窗
  const [historyFor, setHistoryFor] = useState<PatrolPlan | null>(null);
  const [runs, setRuns] = useState<PatrolRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!form.dataSourceId && activeDataSourceId) setForm((f) => ({ ...f, dataSourceId: activeDataSourceId }));
  }, [activeDataSourceId, form.dataSourceId]);

  const loadPatrols = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/patrols');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '巡检计划加载失败');
      setPatrols(data.patrols || []);
    } catch (err: any) {
      setError(err?.message || '巡检计划加载失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPatrols();
  }, [loadPatrols]);

  const dsName = (id: string) => dataSources.find((d) => d.id === id)?.name || id;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!form.dataSourceId) {
      setNotice({ type: 'error', text: '请选择巡检的数据源' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/patrols', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId: form.dataSourceId,
          name: form.name.trim(),
          intervalMinutes: form.intervalMinutes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '创建失败');
      setNotice({ type: 'success', text: `巡检计划「${data.patrol?.name || form.name}」已创建，将按设定周期自动巡检` });
      setShowCreate(false);
      setForm({ dataSourceId: activeDataSourceId || '', name: '', intervalMinutes: 1440 });
      loadPatrols();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || '创建失败' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (p: PatrolPlan) => {
    const next = p.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    try {
      const res = await apiFetch(`/api/patrols/${encodeURIComponent(p.patrolId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '操作失败');
      setNotice({ type: 'success', text: next === 'ACTIVE' ? `「${p.name}」已启用巡检` : `「${p.name}」已暂停巡检` });
      loadPatrols();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || '操作失败' });
    }
  };

  const handleDelete = async (p: PatrolPlan) => {
    if (!window.confirm(`确认删除巡检计划「${p.name}」？其运行历史将一并删除。`)) return;
    setDeletingId(p.patrolId);
    try {
      const res = await apiFetch(`/api/patrols/${encodeURIComponent(p.patrolId)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败');
      setPatrols((prev) => prev.filter((x) => x.patrolId !== p.patrolId));
      setNotice({ type: 'success', text: `已删除「${p.name}」` });
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || '删除失败' });
    } finally {
      setDeletingId(null);
    }
  };

  const handleRunNow = async (p: PatrolPlan) => {
    if (runningId) return;
    setRunningId(p.patrolId);
    try {
      const res = await apiFetch(`/api/patrols/${encodeURIComponent(p.patrolId)}/run`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || '执行失败');
      const r = data.result;
      const text =
        r.status === 'ANOMALY'
          ? `「${p.name}」巡检完成：发现 ${r.anomalyCount} 项异常（高优 ${r.highCount} 项）`
          : r.status === 'CLEAN'
          ? `「${p.name}」巡检完成：指标表现正常`
          : r.status === 'NO_DATA'
          ? `「${p.name}」暂无可扫描的真实数据报表（请先生成一份决策报表）`
          : `「${p.name}」巡检执行失败：${r.error || '未知错误'}`;
      setNotice({ type: r.status === 'ERROR' ? 'error' : 'success', text });
      loadPatrols();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || '执行失败' });
    } finally {
      setRunningId(null);
    }
  };

  const openHistory = async (p: PatrolPlan) => {
    setHistoryFor(p);
    setRuns([]);
    setRunsLoading(true);
    try {
      const res = await apiFetch(`/api/patrols/${encodeURIComponent(p.patrolId)}/runs?limit=20`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setRuns(data.runs || []);
    } catch {
      // 历史加载失败仅展示空态
    } finally {
      setRunsLoading(false);
    }
  };

  const canOperate = (p: PatrolPlan) => canManage && (isAdmin || user?.id === p.userId);

  return (
    <div className="space-y-4">
      {/* 工具条：刷新 / 新建巡检计划（页面与系统管理双入口共用） */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">共 {patrols.length} 个巡检计划</span>
        <div className="flex items-center space-x-2">
          <button
            onClick={loadPatrols}
            disabled={isLoading}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
          {canManage && (
            <button
              onClick={() => setShowCreate((v) => !v)}
              className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建巡检计划</span>
            </button>
          )}
        </div>
      </div>

      {/* 通知条 */}
      {notice && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center space-x-2 p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 新建表单 */}
      {showCreate && canManage && (
        <form onSubmit={handleCreate} className="bg-slate-900 border border-indigo-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
          <h3 className="font-bold text-slate-100 text-sm border-b border-slate-800 pb-2 flex items-center space-x-2">
            <BellRing className="w-4 h-4 text-amber-400" />
            <span>新建巡检计划</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">巡检数据源:</label>
              <select
                value={form.dataSourceId}
                onChange={(e) => setForm({ ...form, dataSourceId: e.target.value })}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">请选择…</option>
                {dataSources.map((ds) => (
                  <option key={ds.id} value={ds.id}>{ds.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">计划名称（可空，默认「数据源名 巡检」）:</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如: 不良资产主库每日巡检"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">巡检周期:</label>
              <select
                value={form.intervalMinutes}
                onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            巡检将按期扫描该数据源「最近一份真实数据决策报表」，命中 Z-Score 偏离或阈值异常的指标会记录到运行历史并在此中心预警。
          </p>
          <div className="flex items-center justify-end space-x-2 pt-1">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting || !form.dataSourceId}
              className="px-5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow"
            >
              {submitting ? '创建中…' : '创建巡检计划'}
            </button>
          </div>
        </form>
      )}

      {/* 空态 */}
      {!isLoading && !error && patrols.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <Radar className="w-12 h-12 mb-3 opacity-30" />
          <div className="text-sm font-medium">暂无巡检计划</div>
          <div className="text-xs mt-1.5 text-slate-600">
            {canManage
              ? '点击上方「新建巡检计划」，让系统按期自动扫描数据源异常波动'
              : '巡检计划由管理员或分析师创建后，此处将展示自动巡检发现的异常预警'}
          </div>
        </div>
      )}

      {/* 计划列表 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {patrols.map((p) => {
          const statusMeta = p.lastRunStatus ? RUN_STATUS_META[p.lastRunStatus] : null;
          return (
            <div key={p.patrolId} className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-amber-500/30 transition-colors space-y-3">
              <div className="flex items-start justify-between space-x-2">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-100 truncate">{p.name}</div>
                  <div className="flex items-center space-x-2 text-[11px] text-slate-500 mt-1">
                    <span className="flex items-center space-x-1">
                      <Database className="w-3 h-3" />
                      <span className="truncate max-w-[180px]">{dsName(p.dataSourceId)}</span>
                    </span>
                    <span className="flex items-center space-x-1">
                      <Clock className="w-3 h-3" />
                      <span>{formatInterval(p.intervalMinutes)}</span>
                    </span>
                  </div>
                </div>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${
                    p.status === 'ACTIVE'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-slate-500/15 text-slate-400 border-slate-500/30'
                  }`}
                >
                  {p.status === 'ACTIVE' ? '巡检中' : '已暂停'}
                </span>
              </div>

              {/* 最近巡检快照 */}
              <div className="grid grid-cols-3 gap-2 text-[11px] bg-slate-950/60 border border-slate-800/80 rounded-xl p-2.5">
                <div>
                  <div className="text-slate-500">上次巡检</div>
                  <div className="text-slate-300 mt-0.5">{formatTime(p.lastRunAt)}</div>
                </div>
                <div>
                  <div className="text-slate-500">巡检结果</div>
                  <div className="mt-0.5">
                    {statusMeta ? (
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${statusMeta.cls}`}>
                        {statusMeta.label}
                        {p.lastRunStatus === 'ANOMALY' ? ` · ${p.lastAnomalyCount} 项` : ''}
                      </span>
                    ) : (
                      <span className="text-slate-500">尚未执行</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">下次巡检</div>
                  <div className="text-slate-300 mt-0.5">{p.status === 'ACTIVE' ? formatTime(p.nextRunAt) : '—'}</div>
                </div>
              </div>

              <div className="flex items-center space-x-2 pt-1 border-t border-slate-800/60">
                {canOperate(p) && (
                  <>
                    <button
                      onClick={() => handleRunNow(p)}
                      disabled={runningId !== null}
                      className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-amber-300 text-[11px] font-medium transition-colors disabled:opacity-50"
                    >
                      {runningId === p.patrolId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                      <span>{runningId === p.patrolId ? '巡检中…' : '立即巡检'}</span>
                    </button>
                    <button
                      onClick={() => handleToggle(p)}
                      className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[11px] font-medium transition-colors"
                    >
                      {p.status === 'ACTIVE' ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      <span>{p.status === 'ACTIVE' ? '暂停' : '启用'}</span>
                    </button>
                  </>
                )}
                <button
                  onClick={() => openHistory(p)}
                  className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[11px] font-medium transition-colors"
                >
                  <History className="w-3 h-3" />
                  <span>运行历史</span>
                </button>
                {canOperate(p) && (
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={deletingId === p.patrolId}
                    className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-950/40 border border-slate-700 hover:border-rose-500/30 text-slate-400 hover:text-rose-300 text-[11px] transition-colors disabled:opacity-50 ml-auto"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{deletingId === p.patrolId ? '删除中…' : '删除'}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 运行历史弹窗 */}
      {historyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setHistoryFor(null)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[82vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950 shrink-0">
              <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
                <History className="w-4 h-4 text-indigo-400" />
                <span>「{historyFor.name}」运行历史</span>
              </h3>
              <button onClick={() => setHistoryFor(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-3">
              {runsLoading && (
                <div className="flex items-center justify-center py-8 text-slate-500 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  <span>加载中…</span>
                </div>
              )}
              {!runsLoading && runs.length === 0 && (
                <p className="text-xs text-slate-500 py-6 text-center">暂无运行记录，可点击「立即巡检」执行一次基线扫描</p>
              )}
              {runs.map((run) => {
                const meta = RUN_STATUS_META[run.status] || RUN_STATUS_META.ERROR;
                return (
                  <div key={run.id} className="border border-slate-800 rounded-xl p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center space-x-2">
                        <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                        <span className="text-slate-500 text-[11px]">{formatTime(run.runAt)}</span>
                        {run.reportTitle && (
                          <span className="text-slate-400 text-[11px] truncate max-w-[280px]" title={run.reportTitle}>
                            扫描报表：{run.reportTitle}
                          </span>
                        )}
                      </div>
                      {run.status === 'ANOMALY' && (
                        <span className="text-[11px] text-rose-300">
                          异常 {run.anomalyCount} 项 · 高优 {run.highCount} 项
                        </span>
                      )}
                    </div>
                    {run.error && <div className="text-rose-300 text-[11px]">{run.error}</div>}
                    {run.anomalies.length > 0 && (
                      <ul className="space-y-1.5">
                        {run.anomalies.map((a: AnomalyItem) => {
                          const sev = SEVERITY_META[a.severity] || SEVERITY_META.low;
                          return (
                            <li key={a.id} className="flex items-start space-x-2 bg-slate-950/60 border border-slate-800/80 rounded-lg p-2">
                              <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-bold ${sev.cls}`}>{sev.label}</span>
                              <div className="min-w-0 space-y-0.5">
                                <div className="text-slate-200 font-medium">
                                  {a.metricLabel}
                                  {a.dimensionValue ? `（${a.dimensionValue}）` : ''}
                                  <span className="text-slate-500 font-normal ml-2">
                                    {a.type === 'spike' ? '突增' : a.type === 'drop' ? '骤降' : a.type === 'threshold' ? '阈值越界' : '离群'}
                                    {typeof a.deviationPercent === 'number' ? ` ${a.deviationPercent > 0 ? '+' : ''}${a.deviationPercent}%` : ''}
                                  </span>
                                </div>
                                <div className="text-slate-400 text-[11px] leading-relaxed">{a.reasoning}</div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {run.status === 'CLEAN' && (
                      <div className="flex items-center space-x-1.5 text-emerald-300 text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>本次巡检未发现异常波动</span>
                      </div>
                    )}
                    {run.status === 'NO_DATA' && (
                      <div className="flex items-center space-x-1.5 text-slate-400 text-[11px]">
                        <XCircle className="w-3.5 h-3.5" />
                        <span>该数据源暂无真实数据（live）决策报表可供扫描</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
