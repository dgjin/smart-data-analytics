import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  MessageCircleQuestion,
  Ban,
  Wrench,
  DatabaseZap,
  Gauge,
  Timer,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { apiFetch } from '../../api/client';

/** 对齐 server/routes/opsMetrics.ts */
interface NorthStarMetrics {
  totalQueries: number;
  answered: number;
  successRate: number;
  cacheHitRate: number;
  clarifyRate: number;
  refuseRate: number;
  fallbackRate: number;
  errorRate: number;
  deniedRate: number;
  feedbackTotal: number;
  upCount: number;
  downCount: number;
  upRate: number | null;
  downRate: number | null;
  tracedQueries: number;
  selfCorrected: number;
  selfCorrectRate: number | null;
  avgDurationMs: number;
}

interface DailyTrendPoint {
  date: string;
  total: number;
  success: number;
  cache: number;
  clarify: number;
  refused: number;
  fallback: number;
  error: number;
  denied: number;
  up: number;
  down: number;
  traces: number;
  selfCorrected: number;
}

interface WeeklyTrendPoint {
  week: string;
  total: number;
  successRate: number | null;
  cacheHitRate: number | null;
  clarifyRate: number | null;
  refuseRate: number | null;
  upRate: number | null;
  selfCorrectRate: number | null;
}

const DAY_OPTIONS = [7, 14, 30, 90];

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: string; // text color class
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
 * P0-4 在线准确率度量看板（系统管理 · 仅管理员）：
 * 北极星指标（点赞率/点踩率/澄清率/拒答率/自纠错触发率/缓存命中率）+ 日/周趋势。
 */
export const OpsMetricsPanel: React.FC = () => {
  const [days, setDays] = useState(7);
  const [trendMode, setTrendMode] = useState<'day' | 'week'>('day');
  const [northStar, setNorthStar] = useState<NorthStarMetrics | null>(null);
  const [daily, setDaily] = useState<DailyTrendPoint[]>([]);
  const [weekly, setWeekly] = useState<WeeklyTrendPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/ops/metrics?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '指标获取失败');
      setNorthStar(data.northStar);
      setDaily(data.daily || []);
      setWeekly(data.weekly || []);
    } catch (err: any) {
      setError(err.message || '指标获取失败');
    } finally {
      setIsLoading(false);
    }
  }, [days]);

  useEffect(() => {
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => void loadMetrics(), 0);
    return () => clearTimeout(timer);
  }, [loadMetrics]);

  // 趋势图数据：日模式由计数换算比率，周模式直接用后端聚合比率
  const chartData = useMemo(() => {
    const toRate = (part: number, total: number): number | null => (total > 0 ? Number(((part / total) * 100).toFixed(1)) : null);
    if (trendMode === 'week') {
      return weekly.map((w) => ({
        label: `${w.week.slice(5)} 周`,
        成功应答率: w.successRate === null ? null : Number((w.successRate * 100).toFixed(1)),
        缓存命中率: w.cacheHitRate === null ? null : Number((w.cacheHitRate * 100).toFixed(1)),
        澄清率: w.clarifyRate === null ? null : Number((w.clarifyRate * 100).toFixed(1)),
        拒答率: w.refuseRate === null ? null : Number((w.refuseRate * 100).toFixed(1)),
      }));
    }
    return daily.map((p) => ({
      label: p.date.slice(5),
      成功应答率: toRate(p.success + p.cache, p.total),
      缓存命中率: toRate(p.cache, p.total),
      澄清率: toRate(p.clarify, p.total),
      拒答率: toRate(p.refused, p.total),
    }));
  }, [daily, weekly, trendMode]);

  // 状态分布（区间内合计，取自日趋势列）
  const statusRows = useMemo(() => {
    const sum = (f: (p: DailyTrendPoint) => number) => daily.reduce((acc, p) => acc + f(p), 0);
    const rows: Array<{ label: string; count: number; tone: string }> = [
      { label: '成功（SUCCESS）', count: sum((p) => p.success), tone: 'text-emerald-300' },
      { label: '缓存命中（CACHE）', count: sum((p) => p.cache), tone: 'text-sky-300' },
      { label: '澄清（CLARIFY）', count: sum((p) => p.clarify), tone: 'text-amber-300' },
      { label: '拒答（REFUSED）', count: sum((p) => p.refused), tone: 'text-rose-300' },
      { label: '降级（FALLBACK）', count: sum((p) => p.fallback), tone: 'text-orange-300' },
      { label: '错误（ERROR）', count: sum((p) => p.error), tone: 'text-rose-400' },
      { label: '拦截（DENIED_*）', count: sum((p) => p.denied), tone: 'text-slate-400' },
    ];
    const total = rows.reduce((acc, r) => acc + r.count, 0);
    return { rows, total };
  }, [daily]);

  return (
    <div className="space-y-4">
      {/* 控制条：时间范围 + 趋势粒度 + 刷新 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-1.5">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                days === d
                  ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/30'
                  : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
              }`}
            >
              近 {d} 天
            </button>
          ))}
        </div>
        <div className="flex items-center space-x-2">
          <div className="flex items-center space-x-1 bg-slate-950 border border-slate-700 rounded-xl p-0.5">
            {(['day', 'week'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setTrendMode(m)}
                className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                  trendMode === m ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {m === 'day' ? '按天' : '按周'}
              </button>
            ))}
          </div>
          <button
            onClick={() => void loadMetrics()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl border bg-rose-950/60 border-rose-800/60 text-rose-300 text-xs flex items-center justify-between space-x-2">
          <span>{error}</span>
          <button
            onClick={() => void loadMetrics()}
            className="px-2.5 py-1 rounded-lg border border-rose-800/60 hover:bg-rose-900/40 text-[11px] font-medium shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {/* 北极星 KPI 六卡 */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard
          icon={<ThumbsUp className="w-3.5 h-3.5" />}
          label="点赞率"
          value={pct(northStar?.upRate ?? null)}
          sub={`${northStar?.upCount ?? 0} 赞 / ${northStar?.feedbackTotal ?? 0} 反馈`}
          tone="text-emerald-400"
        />
        <KpiCard
          icon={<ThumbsDown className="w-3.5 h-3.5" />}
          label="点踩率"
          value={pct(northStar?.downRate ?? null)}
          sub={`${northStar?.downCount ?? 0} 踩 / ${northStar?.feedbackTotal ?? 0} 反馈`}
          tone="text-rose-400"
        />
        <KpiCard
          icon={<MessageCircleQuestion className="w-3.5 h-3.5" />}
          label="澄清率"
          value={pct(northStar ? northStar.clarifyRate : null)}
          sub="歧义问题主动澄清占比"
          tone="text-amber-400"
        />
        <KpiCard
          icon={<Ban className="w-3.5 h-3.5" />}
          label="拒答率"
          value={pct(northStar ? northStar.refuseRate : null)}
          sub="越权/超范围拒答占比"
          tone="text-rose-400"
        />
        <KpiCard
          icon={<Wrench className="w-3.5 h-3.5" />}
          label="自纠错触发率"
          value={pct(northStar?.selfCorrectRate ?? null)}
          sub={`${northStar?.selfCorrected ?? 0} / ${northStar?.tracedQueries ?? 0} 条留痕链路`}
          tone="text-indigo-400"
        />
        <KpiCard
          icon={<DatabaseZap className="w-3.5 h-3.5" />}
          label="缓存命中率"
          value={pct(northStar ? northStar.cacheHitRate : null)}
          sub="语义缓存直接应答占比"
          tone="text-sky-400"
        />
      </div>

      {/* 概览条：总量 / 成功应答率 / 降级率 / 平均耗时 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={<Activity className="w-3.5 h-3.5" />}
          label="问数总量"
          value={(northStar?.totalQueries ?? 0).toLocaleString('zh-CN')}
          sub={`近 ${days} 天问数主链路请求`}
          tone="text-slate-300"
        />
        <KpiCard
          icon={<Gauge className="w-3.5 h-3.5" />}
          label="成功应答率"
          value={pct(northStar ? northStar.successRate : null)}
          sub={`${northStar?.answered ?? 0} 次成功（含缓存）`}
          tone="text-emerald-400"
        />
        <KpiCard
          icon={<Activity className="w-3.5 h-3.5" />}
          label="降级 / 错误率"
          value={`${pct(northStar ? northStar.fallbackRate : null)} / ${pct(northStar ? northStar.errorRate : null)}`}
          sub="降级为模拟分析 / 链路失败"
          tone="text-orange-400"
        />
        <KpiCard
          icon={<Timer className="w-3.5 h-3.5" />}
          label="平均端到端耗时"
          value={formatDuration(northStar?.avgDurationMs ?? 0)}
          sub="问数主链路平均处理时长"
          tone="text-slate-300"
        />
      </div>

      {/* 趋势图 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl p-4">
        <div className="flex items-center space-x-2 px-1 pb-3 text-xs font-bold text-slate-300">
          <Activity className="w-4 h-4 text-indigo-400" />
          <span>质量趋势（{trendMode === 'day' ? '按天' : '按周'}，单位：%）</span>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} stroke="#334155" />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} stroke="#334155" domain={[0, 100]} unit="%" />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, fontSize: 12 }}
                labelStyle={{ color: '#e2e8f0' }}
                formatter={(value: any) => (value === null || value === undefined ? '—' : `${value}%`)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="成功应答率" stroke="#34d399" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="缓存命中率" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="澄清率" stroke="#fbbf24" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="拒答率" stroke="#fb7185" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 状态分布表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center space-x-2 px-5 py-3 border-b border-slate-800 text-xs font-bold text-slate-300">
          <Activity className="w-4 h-4 text-indigo-400" />
          <span>问数状态分布（近 {days} 天，共 {statusRows.total.toLocaleString('zh-CN')} 次）</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-3 py-3 font-medium text-right">次数</th>
                <th className="px-5 py-3 font-medium">占比</th>
              </tr>
            </thead>
            <tbody>
              {statusRows.rows.map((r) => {
                const share = statusRows.total > 0 ? (r.count / statusRows.total) * 100 : 0;
                return (
                  <tr key={r.label} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                    <td className={`px-5 py-3 font-medium ${r.tone}`}>{r.label}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.count.toLocaleString('zh-CN')}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center space-x-2">
                        <div className="flex-1 min-w-[64px] h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-500 tabular-nums w-10 text-right">{share.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && statusRows.total === 0 && !error && (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-slate-500">
                    近 {days} 天暂无问数记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
