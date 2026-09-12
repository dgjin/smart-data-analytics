/**
 * P1-5 时序预测视图（高级分析面板 Tab 1）：
 * 从看板数据选 y（指标列）与 x（期序列，可选）→ POST /api/analytics/forecast
 * （统计引擎出数 + LLM 解读，解读失败降级不阻断）→ 迷你趋势图 + 拟合评估 + 预测明细 + 业务解读。
 */
import React, { useMemo, useState } from 'react';
import { Activity, Loader2, Play, Sparkles, TrendingUp } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { DashboardWidget } from '../../types/analytics';
import { profileColumns, pickForecastDefaults, readStr } from './analysisUtils';
import { MiniForecastPoint, MiniSeriesChart } from './MiniSeriesChart';

interface ForecastResponseData {
  model: string;
  points: MiniForecastPoint[];
  fit: { mape: number | null; r2: number | null; rmse: number };
  backtest?: { model: string; mape: number | null }[];
  diagnostics: string[];
}

const PERIOD_OPTIONS = [3, 6, 12];
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: '自动择优' },
  { value: 'ma', label: '移动平均' },
  { value: 'lr', label: '线性回归' },
  { value: 'seasonal', label: '季节分解' },
];
const SEASONAL_PERIOD_OPTIONS = [4, 12];
// 与服务端 MAX_SERIES_LENGTH 对齐：超出截取尾部（预测以近期趋势为主）
const MAX_SERIES = 240;
const MODEL_LABELS: Record<string, string> = { auto: '自动择优', ma: '移动平均', lr: '线性回归', seasonal: '季节分解' };

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(v);
}

export const ForecastView: React.FC<{ widget: DashboardWidget }> = ({ widget }) => {
  const profile = useMemo(() => profileColumns(widget.data || []), [widget.data]);
  const defaults = useMemo(() => pickForecastDefaults(profile), [profile]);

  const [yKey, setYKey] = useState<string>(defaults.yKey);
  const [xKey, setXKey] = useState<string>(defaults.xKey);
  const [periods, setPeriods] = useState<number>(6);
  const [model, setModel] = useState<string>('auto');
  const [seasonalPeriod, setSeasonalPeriod] = useState<number>(4);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForecastResponseData | null>(null);
  const [interpretation, setInterpretation] = useState<Record<string, unknown> | null>(null);

  // 成对提取序列：y 非数值的行整行跳过，保证 x/y 严格对齐；超长截尾部
  const series = useMemo(() => {
    const ys: number[] = [];
    const xs: string[] = [];
    for (const row of widget.data || []) {
      if (!row || typeof row !== 'object') continue;
      const raw = (row as Record<string, unknown>)[yKey];
      if (raw === null || raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      ys.push(n);
      xs.push(xKey ? String((row as Record<string, unknown>)[xKey] ?? '') : '');
    }
    if (ys.length > MAX_SERIES) return { ys: ys.slice(-MAX_SERIES), xs: xs.slice(-MAX_SERIES) };
    return { ys, xs };
  }, [widget.data, xKey, yKey]);

  const canRun = !!yKey && series.ys.length >= 3 && !loading;

  const handleRun = async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch('/api/analytics/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          yValues: series.ys,
          ...(series.xs.some((x) => x) ? { xValues: series.xs } : {}),
          periods,
          model,
          ...(model === 'seasonal' ? { seasonalPeriod } : {}),
          metricLabel: `${widget.title} · ${yKey}`,
        }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.forecast) throw new Error(data?.error || '预测执行失败');
      setResult(data.forecast as ForecastResponseData);
      setInterpretation((data.interpretation ?? null) as Record<string, unknown> | null);
    } catch (err: any) {
      setError(err?.message || '预测执行失败');
      setResult(null);
      setInterpretation(null);
    } finally {
      setLoading(false);
    }
  };

  const selectCls =
    'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-indigo-500 cursor-pointer disabled:opacity-50 max-w-[180px]';
  const lastHistory = series.ys.length > 0 ? series.ys[series.ys.length - 1] : null;

  return (
    <div className="space-y-3">
      {/* 参数行：指标列 / 期序列 / 期数 / 模型 */}
      <div className="flex items-center flex-wrap gap-2 text-[11px] text-slate-400">
        <span className="flex items-center space-x-1">
          <TrendingUp className="w-3.5 h-3.5 text-indigo-400" />
          <span>指标列:</span>
          <select value={yKey} onChange={(e) => setYKey(e.target.value)} disabled={loading} className={selectCls}>
            {profile.numeric.length === 0 && <option value="">（无可用数值列）</option>}
            {profile.numeric.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </span>
        <span className="flex items-center space-x-1">
          <span>期序:</span>
          <select value={xKey} onChange={(e) => setXKey(e.target.value)} disabled={loading} className={selectCls} title="按该列排序展示期次；不选则按数据原顺序">
            <option value="">（按数据原顺序）</option>
            {profile.all.filter((k) => k !== yKey).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </span>
        <span className="flex items-center space-x-1">
          <span>预测期数:</span>
          <select value={periods} onChange={(e) => setPeriods(Number(e.target.value))} disabled={loading} className={selectCls}>
            {PERIOD_OPTIONS.map((p) => (
              <option key={p} value={p}>未来 {p} 期</option>
            ))}
          </select>
        </span>
        <span className="flex items-center space-x-1">
          <span>模型:</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={loading} className={selectCls} title="自动择优：尾部回测按 MAPE 选最稳的模型">
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </span>
        {model === 'seasonal' && (
          <span className="flex items-center space-x-1">
            <span>周期:</span>
            <select value={seasonalPeriod} onChange={(e) => setSeasonalPeriod(Number(e.target.value))} disabled={loading} className={selectCls}>
              {SEASONAL_PERIOD_OPTIONS.map((p) => (
                <option key={p} value={p}>{p} 期</option>
              ))}
            </select>
          </span>
        )}
        <button
          onClick={() => void handleRun()}
          disabled={!canRun}
          className="ml-auto flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          <span>{loading ? '预测中…' : '开始预测'}</span>
        </button>
      </div>

      {/* 样本提示 */}
      <div className="text-[10px] text-slate-500">
        可用历史样本 {series.ys.length} 期{lastHistory !== null ? `（末值 ${fmt(lastHistory)}）` : ''}，至少需要 3 期
      </div>

      {error && (
        <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs">{error}</div>
      )}

      {result && (
        <>
          {/* 拟合评估 chips */}
          <div className="flex items-center flex-wrap gap-2 text-[10px]">
            <span className="px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/40 text-indigo-300 font-semibold">
              {MODEL_LABELS[result.model] || result.model}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300" title="均方根误差：拟合值与实际值的平均偏差">
              RMSE {fmt(result.fit.rmse)}
            </span>
            {result.fit.mape !== null && (
              <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300" title="平均绝对百分比误差：平均偏差相对于数值的比例">
                MAPE {result.fit.mape}%
              </span>
            )}
            {result.fit.r2 !== null && (
              <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300" title="拟合优度：越接近 1 越贴合历史走势">
                R² {result.fit.r2}
              </span>
            )}
            {result.backtest && result.backtest.length > 0 && (
              <span
                className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400"
                title={result.backtest.map((b) => `${MODEL_LABELS[b.model] || b.model}: MAPE ${b.mape ?? '—'}%`).join('，')}
              >
                回测候选 {result.backtest.length} 个
              </span>
            )}
          </div>

          {/* 趋势图 */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3">
            <MiniSeriesChart history={series.ys} points={result.points} />
          </div>

          {/* 预测明细表 */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-900 text-slate-400">
                  <th className="text-left px-3 py-1.5 font-semibold">期次</th>
                  <th className="text-right px-3 py-1.5 font-semibold">预测值</th>
                  <th className="text-right px-3 py-1.5 font-semibold" title="约 80% 置信水平的波动区间">80% 波动区间</th>
                </tr>
              </thead>
              <tbody>
                {lastHistory !== null && (
                  <tr className="border-t border-slate-800/60 text-slate-500">
                    <td className="px-3 py-1.5">历史末值</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmt(lastHistory)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">—</td>
                  </tr>
                )}
                {result.points.map((p) => (
                  <tr key={p.step} className="border-t border-slate-800/60 text-slate-200">
                    <td className="px-3 py-1.5">
                      未来第 {p.step} 期
                      {series.xs.length >= series.ys.length && series.xs[series.xs.length - 1] ? (
                        <span className="ml-1.5 text-[10px] text-slate-500">（接 {series.xs[series.xs.length - 1]} 之后）</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-violet-300">{fmt(p.yhat)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-400">
                      {fmt(p.lower)} ~ {fmt(p.upper)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 统计诊断 */}
          {result.diagnostics.length > 0 && (
            <div className="flex items-start space-x-1.5 text-[10px] text-slate-500">
              <Activity className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="leading-relaxed">{result.diagnostics.join('；')}</span>
            </div>
          )}

          {/* LLM 预测解读（降级时该卡不渲染） */}
          {interpretation && (
            <div className="p-3.5 bg-indigo-950/40 border border-indigo-500/30 rounded-2xl space-y-2">
              <div className="flex items-center space-x-1.5 font-bold text-indigo-300 text-xs">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>AI 预测解读</span>
              </div>
              {readStr(interpretation, 'summary') && (
                <div className="text-xs text-slate-200 leading-relaxed">{readStr(interpretation, 'summary')}</div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {readStr(interpretation, 'trendNote') && (
                  <div className="p-2 bg-slate-900/80 rounded-xl border border-slate-800/80">
                    <div className="text-[10px] font-semibold text-cyan-400 mb-0.5">趋势与节奏</div>
                    <div className="text-[11px] text-slate-300 leading-relaxed">{readStr(interpretation, 'trendNote')}</div>
                  </div>
                )}
                {readStr(interpretation, 'riskNote') && (
                  <div className="p-2 bg-slate-900/80 rounded-xl border border-slate-800/80">
                    <div className="text-[10px] font-semibold text-amber-400 mb-0.5">不确定性提示</div>
                    <div className="text-[11px] text-slate-300 leading-relaxed">{readStr(interpretation, 'riskNote')}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {!result && !loading && !error && (
        <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-2xl">
          选择指标列与预测期数后点击「开始预测」，将基于历史走势给出未来 N 期数值与波动区间。
        </div>
      )}
    </div>
  );
};
