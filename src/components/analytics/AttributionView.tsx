/**
 * P1-6 多维归因视图（高级分析面板 Tab 2）：
 * 选维度（可选）/时期/指标列 → POST /api/analytics/attribution（服务端聚合最新两期 +
 * 贡献度拆解 + LLM 结论）→ 总体变化卡 + 贡献排行表 + 业务结论卡。
 * 语义提醒：适配可加指标（金额/数量/余额）；比率型指标需上游按分子/分母展开。
 */
import React, { useMemo, useState } from 'react';
import { BarChart3, Loader2, Play, Sparkles } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { DashboardWidget } from '../../types/analytics';
import { profileColumns, pickAttributionDefaults, readStr, readStrList } from './analysisUtils';

interface AttributionItemData {
  dims: string[];
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null;
  contribution: number;
  rank: number;
}

interface AttributionResultData {
  items: AttributionItemData[];
  total: { current: number; previous: number; delta: number; deltaPct: number | null };
  topPositive: AttributionItemData[];
  topNegative: AttributionItemData[];
  diagnostics: string[];
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(v);
}

function signed(v: number, pct?: number | null): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${fmt(v)}${pct === null || pct === undefined ? '' : `（${sign}${pct}%）`}`;
}

/** 安全读取 keyDrivers（[{dimension, reason}] 对象数组） */
function readDrivers(obj: Record<string, unknown> | null): { dimension: string; reason: string }[] {
  const v = obj?.['keyDrivers'];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      dimension: typeof x.dimension === 'string' ? x.dimension : '',
      reason: typeof x.reason === 'string' ? x.reason : '',
    }))
    .filter((x) => x.dimension || x.reason)
    .slice(0, 5);
}

export const AttributionView: React.FC<{ widget: DashboardWidget }> = ({ widget }) => {
  const profile = useMemo(() => profileColumns(widget.data || []), [widget.data]);
  const defaults = useMemo(() => pickAttributionDefaults(profile), [profile]);

  const [dimKey, setDimKey] = useState<string>(defaults.dimKey);
  const [periodKey, setPeriodKey] = useState<string>(defaults.periodKey);
  const [metricKey, setMetricKey] = useState<string>(defaults.metricKey);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AttributionResultData | null>(null);
  const [periods, setPeriods] = useState<[string, string] | null>(null);
  const [interpretation, setInterpretation] = useState<Record<string, unknown> | null>(null);

  const canRun = !!periodKey && !!metricKey && !loading;

  const handleRun = async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch('/api/analytics/attribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: widget.data,
          aggregate: { ...(dimKey ? { dimKey } : {}), periodKey, metricKey },
          subject: `${widget.title} · ${metricKey}`,
        }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.attribution) throw new Error(data?.error || '归因分析失败');
      setResult(data.attribution as AttributionResultData);
      setPeriods(Array.isArray(data.periods) && data.periods.length === 2 ? (data.periods as [string, string]) : null);
      setInterpretation((data.interpretation ?? null) as Record<string, unknown> | null);
    } catch (err: any) {
      setError(err?.message || '归因分析失败');
      setResult(null);
      setPeriods(null);
      setInterpretation(null);
    } finally {
      setLoading(false);
    }
  };

  const selectCls =
    'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-emerald-500 cursor-pointer disabled:opacity-50 max-w-[180px]';
  const sortedItems = result ? [...result.items].sort((a, b) => a.rank - b.rank) : [];
  const maxAbsDelta = result ? Math.max(...result.items.map((i) => Math.abs(i.delta)), 1e-9) : 1;

  return (
    <div className="space-y-3">
      {/* 参数行：维度 / 时期 / 指标 */}
      <div className="flex items-center flex-wrap gap-2 text-[11px] text-slate-400">
        <span className="flex items-center space-x-1">
          <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
          <span>维度:</span>
          <select value={dimKey} onChange={(e) => setDimKey(e.target.value)} disabled={loading} className={selectCls} title="按该列分组拆解贡献度；不选则整表作为合计">
            <option value="">（整体合计）</option>
            {profile.labels.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </span>
        <span className="flex items-center space-x-1">
          <span>时期列:</span>
          <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} disabled={loading} className={selectCls} title="取该列最新两期做环比拆解">
            {profile.timeLike.length === 0 && profile.all.length > 0 && <option value={profile.all[0]}>{profile.all[0]}</option>}
            {profile.timeLike.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </span>
        <span className="flex items-center space-x-1">
          <span>指标列:</span>
          <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)} disabled={loading} className={selectCls}>
            {profile.numeric.length === 0 && <option value="">（无可用数值列）</option>}
            {profile.numeric.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </span>
        <button
          onClick={() => void handleRun()}
          disabled={!canRun}
          className="ml-auto flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          <span>{loading ? '拆解中…' : '开始归因'}</span>
        </button>
      </div>

      {error && (
        <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs">{error}</div>
      )}

      {result && (
        <>
          {/* 总体变化卡 */}
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2.5 bg-slate-900/80 border border-slate-800 rounded-xl">
              <div className="text-[10px] text-slate-500">{periods ? `对比期（${periods[0]}）` : '对比期'}</div>
              <div className="text-sm font-bold text-slate-200 font-mono mt-0.5">{fmt(result.total.previous)}</div>
            </div>
            <div className="p-2.5 bg-slate-900/80 border border-slate-800 rounded-xl">
              <div className="text-[10px] text-slate-500">{periods ? `当期（${periods[1]}）` : '当期'}</div>
              <div className="text-sm font-bold text-slate-200 font-mono mt-0.5">{fmt(result.total.current)}</div>
            </div>
            <div
              className={`p-2.5 rounded-xl border ${
                result.total.delta > 0
                  ? 'bg-emerald-950/40 border-emerald-500/40'
                  : result.total.delta < 0
                  ? 'bg-rose-950/40 border-rose-500/40'
                  : 'bg-slate-900/80 border-slate-800'
              }`}
            >
              <div className="text-[10px] text-slate-500">总体变化</div>
              <div
                className={`text-sm font-bold font-mono mt-0.5 ${
                  result.total.delta > 0 ? 'text-emerald-300' : result.total.delta < 0 ? 'text-rose-300' : 'text-slate-200'
                }`}
              >
                {signed(result.total.delta, result.total.deltaPct)}
              </div>
            </div>
          </div>

          {/* 贡献排行表 */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-900 text-slate-400">
                  <th className="text-left px-3 py-1.5 font-semibold w-10">#</th>
                  <th className="text-left px-3 py-1.5 font-semibold">{dimKey || '合计'}</th>
                  <th className="text-right px-3 py-1.5 font-semibold">对比期</th>
                  <th className="text-right px-3 py-1.5 font-semibold">当期</th>
                  <th className="text-right px-3 py-1.5 font-semibold">变化</th>
                  <th className="text-right px-3 py-1.5 font-semibold" title="该维度变化量占全部行变化量绝对值之和的比重">贡献度</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr key={`${item.rank}-${item.dims.join('/')}`} className="border-t border-slate-800/60 text-slate-200">
                    <td className="px-3 py-1.5 text-slate-500 font-mono">{item.rank}</td>
                    <td className="px-3 py-1.5 max-w-[200px] truncate" title={item.dims.join(' / ')}>
                      {item.dims.join(' / ') || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmt(item.previous)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-300">{fmt(item.current)}</td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono font-semibold ${
                        item.delta > 0 ? 'text-emerald-300' : item.delta < 0 ? 'text-rose-300' : 'text-slate-400'
                      }`}
                    >
                      {signed(item.delta, item.deltaPct)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex items-center justify-end space-x-1.5">
                        <div className="w-14 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${item.delta >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
                            style={{ width: `${Math.min(100, (Math.abs(item.delta) / maxAbsDelta) * 100)}%` }}
                            title={`变化量绝对值占最大项的 ${((Math.abs(item.delta) / maxAbsDelta) * 100).toFixed(0)}%`}
                          />
                        </div>
                        <span className={`font-mono ${item.contribution > 0 ? 'text-emerald-300' : item.contribution < 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                          {item.contribution > 0 ? '+' : ''}{item.contribution}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 统计诊断 */}
          {result.diagnostics.length > 0 && (
            <div className="text-[10px] text-slate-500 leading-relaxed">{result.diagnostics.join('；')}</div>
          )}

          {/* LLM 业务结论 */}
          {interpretation && (
            <div className="p-3.5 bg-emerald-950/30 border border-emerald-500/30 rounded-2xl space-y-2">
              <div className="flex items-center space-x-1.5 font-bold text-emerald-300 text-xs">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>AI 归因结论</span>
              </div>
              {readStr(interpretation, 'summary') && (
                <div className="text-xs text-slate-200 leading-relaxed">{readStr(interpretation, 'summary')}</div>
              )}
              {readDrivers(interpretation).length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold text-slate-400">关键驱动</div>
                  {readDrivers(interpretation).map((d, i) => (
                    <div key={i} className="p-2 bg-slate-900/80 rounded-xl border border-slate-800/80 text-[11px]">
                      <span className="font-semibold text-emerald-200">{d.dimension}</span>
                      {d.reason && <span className="text-slate-300">：{d.reason}</span>}
                    </div>
                  ))}
                </div>
              )}
              {readStrList(interpretation, 'actions').length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold text-slate-400">建议动作</div>
                  <ul className="space-y-0.5">
                    {readStrList(interpretation, 'actions').map((a, i) => (
                      <li key={i} className="text-[11px] text-slate-300 flex items-start space-x-1.5">
                        <span className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center shrink-0 font-bold text-[9px] mt-0.5">
                          {i + 1}
                        </span>
                        <span className="leading-tight">{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!result && !loading && !error && (
        <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-2xl">
          选择维度、时期与指标列后点击「开始归因」，将取最新两期数据按维度拆解贡献度并自动排序。
          <div className="mt-1.5 text-[10px] text-slate-600">提示：适用于金额/数量等可加指标；比率型指标（如不良率）建议先在问数中按分子分母展开。</div>
        </div>
      )}
    </div>
  );
};
