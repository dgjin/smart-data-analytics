import React, { useCallback, useEffect, useState } from 'react';
import {
  Siren,
  RefreshCw,
  AlertCircle,
  Wrench,
  CheckCircle2,
  Timer,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';

/** 对齐 server/routes/opsEvents.ts（v0.9.93 自动运维 API） */
interface OpsEvent {
  id: number;
  severity: string;
  source: string;
  category: string;
  entity_type: string;
  entity_id: string;
  message: string;
  trace_id: string;
  status: string;
  dedup_count: number;
  handled_by: string;
  handled_at: string | null;
  created_at: string;
  last_seen_at: string;
}

interface OpsSummary {
  byStatus: { status: string; cnt: number | string }[];
  last24h: { category: string; severity: string; cnt: number | string }[];
}

/** 事件来源中文标签（五源归集 + 前端错误上报，与后端 VALID_SOURCE 对齐） */
const SOURCE_LABELS: Record<string, string> = {
  audit: '问数失败',
  task: '后台任务',
  patrol: '异常巡检',
  drift: '知识漂移',
  fatal: '进程异常',
  client: '前端错误',
};

/** 严重级徽章与色条（CRITICAL 最醒目，INFO 淡化） */
const SEVERITY_META: Record<string, { badge: string; bar: string }> = {
  CRITICAL: { badge: 'bg-rose-600/20 text-rose-300 border-rose-500/40', bar: 'bg-rose-500' },
  ERROR: { badge: 'bg-rose-500/10 text-rose-400 border-rose-500/30', bar: 'bg-rose-600' },
  WARN: { badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', bar: 'bg-amber-500' },
  INFO: { badge: 'bg-sky-500/10 text-sky-400 border-sky-500/30', bar: 'bg-sky-600' },
};

/** 状态徽章：NEW=待处理（醒目）/ ACK=处理中 / RESOLVED=已闭环 */
const STATUS_META: Record<string, { label: string; badge: string }> = {
  NEW: { label: '待处理', badge: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  ACK: { label: '已受理', badge: 'bg-sky-500/15 text-sky-300 border-sky-500/40' },
  RESOLVED: { label: '已闭环', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 最近出现显著晚于首次出现（>1s）才展示，避免同一时刻重复文案 */
function lastSeenLater(ev: OpsEvent): boolean {
  if (!ev.last_seen_at || !ev.created_at) return false;
  return new Date(ev.last_seen_at).getTime() - new Date(ev.created_at).getTime() > 1000;
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: string;
}

const KpiCard: React.FC<KpiCardProps> = ({ icon, label, value, sub, tone }) => (
  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
    <div className={`flex items-center space-x-1.5 ${tone} text-[11px] font-semibold uppercase tracking-wider`}>
      {icon}
      <span>{label}</span>
    </div>
    <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">{value}</div>
    <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
  </div>
);

/**
 * v0.9.94 运维事件面板（系统管理 · 仅管理员）：
 * 自动运维事件流（问数失败/后台任务/巡检/漂移/进程异常/前端错误）的统一查看与处置通道，
 * 与智能体（OPS_API_TOKEN）共用同一 API——面板操作审计归属 admin，智能体操作归属 ops_agent。
 */
export const OpsEventsPanel: React.FC = () => {
  const [events, setEvents] = useState<OpsEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [summary, setSummary] = useState<OpsSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const buildQuery = useCallback((cursor?: number | null): string => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (severityFilter) params.set('severity', severityFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    params.set('limit', '50');
    if (cursor && cursor > 0) params.set('cursor', String(cursor));
    return params.toString();
  }, [statusFilter, severityFilter, sourceFilter]);

  /** 首屏/刷新/过滤切换：列表第一页 + 摘要并行加载 */
  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [listRes, sumRes] = await Promise.all([
        apiFetch(`/api/ops/events?${buildQuery()}`),
        apiFetch('/api/ops/events/summary'),
      ]);
      const listData = await listRes.json();
      const sumData = await sumRes.json();
      if (!listRes.ok || !listData.success) throw new Error(listData.error || '运维事件获取失败');
      if (!sumRes.ok || !sumData.success) throw new Error(sumData.error || '运维事件摘要获取失败');
      setEvents(listData.events || []);
      setNextCursor(listData.nextCursor ?? null);
      setSummary({ byStatus: sumData.byStatus || [], last24h: sumData.last24h || [] });
    } catch (err) {
      setError(getErrorMessage(err) || '运维事件获取失败');
    } finally {
      setIsLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 游标续拉：追加到既有列表（切换过滤后 load 会重置） */
  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const res = await apiFetch(`/api/ops/events?${buildQuery(nextCursor)}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '加载更多失败');
      setEvents((prev) => [...prev, ...(data.events || [])]);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(getErrorMessage(err) || '加载更多失败');
    } finally {
      setIsLoadingMore(false);
    }
  }, [buildQuery, nextCursor, isLoadingMore]);

  /** 受理 / 关闭（关闭允许填写处置摘要，记入审计留痕；幂等——已处于目标态时回显提示） */
  const handleAction = async (ev: OpsEvent, action: 'ack' | 'resolve') => {
    if (actingId !== null) return;
    let note = '';
    if (action === 'resolve') {
      const input = window.prompt('处置摘要（可留空，将记入审计留痕）：');
      if (input === null) return;
      note = input;
    }
    setActingId(ev.id);
    try {
      const res = await apiFetch(`/api/ops/events/${ev.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      setNotice(
        data.already
          ? `事件 #${ev.id} 已处于「${STATUS_META[data.status]?.label ?? data.status}」状态`
          : `事件 #${ev.id} 已${action === 'ack' ? '受理' : '处置关闭'}`
      );
      await load();
    } catch (err) {
      setError(getErrorMessage(err) || '操作失败');
    } finally {
      setActingId(null);
    }
  };

  const statusCount = (s: string): number => {
    const row = summary?.byStatus.find((r) => r.status === s);
    return Number(row?.cnt ?? 0);
  };
  const total24h = (summary?.last24h ?? []).reduce((acc, r) => acc + Number(r.cnt), 0);
  const high24h = (summary?.last24h ?? [])
    .filter((r) => r.severity === 'CRITICAL' || r.severity === 'ERROR')
    .reduce((acc, r) => acc + Number(r.cnt), 0);

  return (
    <div className="space-y-4">
      {/* 标题条：子面板标识（与其他管理面板同风格） */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex items-center space-x-2 shadow-xl">
        <Siren className="w-4 h-4 text-rose-400 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-200">运维事件流</div>
          <div className="text-[11px] text-slate-500 truncate">
            问数失败 / 后台任务 / 巡检 / 知识漂移 / 进程异常 / 前端错误的统一归集 · 与自动运维智能体共用同一处置通道
          </div>
        </div>
      </div>

      {/* 控制条：状态 / 严重级 / 来源过滤 + 刷新 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center flex-wrap gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            title="按状态过滤"
            className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="">全部状态</option>
            <option value="NEW">待处理</option>
            <option value="ACK">已受理</option>
            <option value="RESOLVED">已闭环</option>
          </select>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            title="按严重级过滤"
            className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="">全部严重级</option>
            <option value="CRITICAL">CRITICAL</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            title="按来源过滤"
            className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="">全部来源</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => void load()}
          disabled={isLoading}
          className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50 shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-xl border bg-rose-950/60 border-rose-800/60 text-rose-300 text-xs flex items-center justify-between space-x-2">
          <span className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{error}</span>
          </span>
          <button
            onClick={() => void load()}
            className="px-2.5 py-1 rounded-lg border border-rose-800/60 hover:bg-rose-900/40 text-[11px] font-medium shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {notice && (
        <div className="p-3 rounded-xl border bg-emerald-950/60 border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* 态势 KPI 四卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={<AlertCircle className="w-3.5 h-3.5" />}
          label="待处理"
          value={statusCount('NEW').toLocaleString('zh-CN')}
          sub="智能体与人工的待办队列"
          tone="text-amber-400"
        />
        <KpiCard
          icon={<Wrench className="w-3.5 h-3.5" />}
          label="处理中"
          value={statusCount('ACK').toLocaleString('zh-CN')}
          sub="已受理待闭环"
          tone="text-sky-400"
        />
        <KpiCard
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          label="已闭环"
          value={statusCount('RESOLVED').toLocaleString('zh-CN')}
          sub="含历史全部处置完成"
          tone="text-emerald-400"
        />
        <KpiCard
          icon={<Timer className="w-3.5 h-3.5" />}
          label="近 24h 新增"
          value={total24h.toLocaleString('zh-CN')}
          sub={`其中 ${high24h.toLocaleString('zh-CN')} 条高优先（CRITICAL/ERROR）`}
          tone="text-slate-300"
        />
      </div>

      {/* 事件列表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-xs font-bold text-slate-300">
            <ScrollText className="w-4 h-4 text-rose-400" />
            <span>
              事件列表（已加载 {events.length} 条{nextCursor ? ' · 还有更多' : ''}）
            </span>
          </div>
          <span className="text-[10px] text-slate-500">同键事件 15 分钟窗口自动合并（×N 为合并次数）</span>
        </div>

        {isLoading ? (
          <div className="px-5 py-12 text-center">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-rose-400" />
            <p className="text-sm text-slate-500">加载中...</p>
          </div>
        ) : events.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <ShieldCheck className="w-12 h-12 mx-auto mb-3 text-emerald-500/50" />
            <p className="text-sm text-slate-400">
              {statusFilter || severityFilter || sourceFilter ? '当前筛选条件下暂无事件' : '暂无运维事件，系统运行健康'}
            </p>
            <p className="text-[11px] text-slate-600 mt-1">
              事件由问数失败 / 后台任务 / 巡检 / 知识漂移 / 进程异常 / 前端错误六类信号自动归集
            </p>
          </div>
        ) : (
          <div>
            {events.map((ev) => {
              const sev = SEVERITY_META[ev.severity] ?? SEVERITY_META.INFO;
              const st = STATUS_META[ev.status] ?? { label: ev.status, badge: 'bg-slate-500/10 text-slate-400 border-slate-500/30' };
              const busy = actingId === ev.id;
              return (
                <div
                  key={ev.id}
                  className="flex border-b border-slate-800/60 last:border-b-0 hover:bg-slate-800/20 transition-colors"
                >
                  <div className={`w-1 shrink-0 ${sev.bar}`} />
                  <div className="flex-1 min-w-0 px-4 py-3 flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex items-center flex-wrap gap-1.5">
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${sev.badge}`}>
                          {ev.severity}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border text-[10px] font-medium bg-slate-800/70 text-slate-300 border-slate-700">
                          {SOURCE_LABELS[ev.source] || ev.source}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${st.badge}`}>
                          {st.label}
                        </span>
                        {ev.category && (
                          <span className="text-[10px] text-slate-500 font-mono">{ev.category}</span>
                        )}
                        {ev.dedup_count > 1 && (
                          <span
                            className="px-1.5 py-0.5 rounded border text-[10px] text-amber-400/90 bg-amber-500/10 border-amber-500/30"
                            title="同键事件在去重窗口内被合并的次数"
                          >
                            ×{ev.dedup_count} 合并
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-slate-200 break-all">{ev.message}</div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 font-mono">
                        <span>#{ev.id}</span>
                        {ev.entity_type && (
                          <span className="truncate max-w-[220px]" title={`${ev.entity_type}:${ev.entity_id}`}>
                            {ev.entity_type}:{ev.entity_id}
                          </span>
                        )}
                        {ev.trace_id && (
                          <span className="truncate max-w-[180px]" title={ev.trace_id}>
                            trace {ev.trace_id}
                          </span>
                        )}
                        <span title="首次出现时间">{fmtTime(ev.created_at)}</span>
                        {lastSeenLater(ev) && (
                          <span className="text-amber-500/80" title="最近一次出现的合并时间">
                            最近出现 {fmtTime(ev.last_seen_at)}
                          </span>
                        )}
                        {ev.handled_by && (
                          <span className="text-sky-400/80" title="处置人 / 智能体与时间">
                            {ev.handled_by} · {fmtTime(ev.handled_at)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {ev.status === 'NEW' && (
                        <button
                          onClick={() => void handleAction(ev, 'ack')}
                          disabled={busy}
                          className="px-2.5 py-1.5 rounded-lg border border-sky-800/70 text-sky-400 hover:bg-sky-950/30 text-xs font-medium transition-colors disabled:opacity-40"
                        >
                          {busy ? '处理中…' : '受理'}
                        </button>
                      )}
                      {ev.status !== 'RESOLVED' && (
                        <button
                          onClick={() => void handleAction(ev, 'resolve')}
                          disabled={busy}
                          className="px-2.5 py-1.5 rounded-lg border border-emerald-800/70 text-emerald-400 hover:bg-emerald-950/30 text-xs font-medium transition-colors disabled:opacity-40"
                        >
                          处置关闭
                        </button>
                      )}
                      {ev.status === 'RESOLVED' && (
                        <span className="text-[10px] text-emerald-500/70">已闭环</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {nextCursor && !isLoading && (
          <div className="px-5 py-3 border-t border-slate-800 text-center">
            <button
              onClick={() => void loadMore()}
              disabled={isLoadingMore}
              className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors border border-slate-700 disabled:opacity-50"
            >
              {isLoadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
