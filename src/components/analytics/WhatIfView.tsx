/**
 * P1-9 情景推演视图（高级分析面板 Tab 3）：
 * 基于看板固化图表的原聚合 SQL（sourceSql）输入情景描述 → POST /api/analytics/whatif
 * （LLM 改写情景 SQL → 安全校验 → 与原 SQL 对比执行）→ 改写说明 + 参数改动 + 对比表 + 解读。
 * 无 sourceSql（非 live 链路固化）或数据源缺失时不可用，如实提示。
 */
import React, { useState } from 'react';
import { FlaskConical, Loader2, Play, Sparkles } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { DashboardWidget } from '../../types/analytics';
import { readStr, readStrList } from './analysisUtils';

interface WhatIfParameterChange {
  column: string;
  from: string;
  to: string;
  description: string;
}

interface WhatIfComparisonData {
  column: string;
  before: { sum: number; avg: number };
  after: { sum: number; avg: number };
  delta: { sum: number; avg: number };
  deltaPct: { sum: number | null; avg: number | null };
}

interface WhatIfResponseData {
  plan: { scenarioSql: string; explanation: string; parameterChanges: WhatIfParameterChange[] };
  before: { sql: string; rowCount: number; rows: Record<string, unknown>[] };
  after: { sql: string; rowCount: number; rows: Record<string, unknown>[] };
  comparisons: WhatIfComparisonData[];
  summaryLines: string[];
  interpretation: Record<string, unknown> | null;
}

const EXAMPLES = [
  '收紧华东区域投放 20% 后指标如何变化',
  '把 M1 账龄客户占比提高 10% 的影响',
  '假设利率上浮 5% 的结果差异',
];

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(v);
}

function signedPct(v: number | null): string {
  if (v === null) return '不适用';
  return `${v > 0 ? '+' : ''}${v}%`;
}

export const WhatIfView: React.FC<{ widget: DashboardWidget }> = ({ widget }) => {
  const [scenario, setScenario] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WhatIfResponseData | null>(null);
  const [showSql, setShowSql] = useState<boolean>(false);

  const sql = widget.sourceSql || '';
  const dataSourceId = widget.dataSourceId || '';
  const available = !!sql && !!dataSourceId;

  const canRun = available && scenario.trim().length > 0 && !loading;

  const handleRun = async () => {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch('/api/analytics/whatif', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId,
          sql,
          scenario: scenario.trim(),
          question: widget.title,
        }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) throw new Error(data?.error || '情景推演失败');
      setResult({
        plan: data.plan,
        before: data.before,
        after: data.after,
        comparisons: Array.isArray(data.comparisons) ? data.comparisons : [],
        summaryLines: Array.isArray(data.summaryLines) ? data.summaryLines : [],
        interpretation: (data.interpretation ?? null) as Record<string, unknown> | null,
      });
    } catch (err: any) {
      setError(err?.message || '情景推演失败');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  if (!available) {
    return (
      <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-2xl space-y-1.5">
        <FlaskConical className="w-8 h-8 text-slate-600 mx-auto" />
        <div className="font-semibold text-slate-400">该图表暂不支持情景推演</div>
        <div>
          {!sql
            ? '情景推演需要图表固化的原聚合 SQL（仅真实执行链路固化的图表具备）。可先在有数据源的问数中重新查询并「固定至看板」。'
            : '图表缺少归属数据源信息，请在问数中重新固化。'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 场景输入 */}
      <div className="space-y-2">
        <div className="flex items-center space-x-1.5 text-[11px] text-slate-400">
          <FlaskConical className="w-3.5 h-3.5 text-amber-400" />
          <span>描述要模拟的情景（基于图表原 SQL 改写条件后对比执行）:</span>
        </div>
        <textarea
          value={scenario}
          onChange={(e) => setScenario(e.target.value.slice(0, 500))}
          disabled={loading}
          rows={2}
          placeholder="例如：收紧华东区域投放 20% 后不良率如何变化"
          className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 resize-none disabled:opacity-60"
        />
        <div className="flex items-center flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setScenario(ex)}
              disabled={loading}
              className="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800 hover:border-amber-500/60 hover:text-amber-300 text-[10px] text-slate-400 transition-colors disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
          <button
            onClick={() => void handleRun()}
            disabled={!canRun}
            className="ml-auto flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            <span>{loading ? '推演中…' : '开始推演'}</span>
          </button>
        </div>
        <div className="text-[10px] text-slate-600">
          推演会真实执行两次查询（原口径 + 情景口径），仅改写过滤条件，保持输出列结构不变。
        </div>
      </div>

      {error && (
        <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs">{error}</div>
      )}

      {result && (
        <>
          {/* 改写说明 + 参数改动 */}
          <div className="p-3 bg-amber-950/30 border border-amber-500/30 rounded-2xl space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-bold text-amber-300">情景改写说明</div>
              <button
                onClick={() => setShowSql((v) => !v)}
                className="text-[10px] text-slate-400 hover:text-amber-300 underline transition-colors"
              >
                {showSql ? '收起 SQL' : '查看情景 SQL'}
              </button>
            </div>
            <div className="text-xs text-slate-200 leading-relaxed">{result.plan.explanation}</div>
            {result.plan.parameterChanges.length > 0 && (
              <div className="flex items-center flex-wrap gap-1.5">
                {result.plan.parameterChanges.map((c, i) => (
                  <span
                    key={i}
                    title={c.description || `${c.column} ${c.from} → ${c.to}`}
                    className="px-2 py-0.5 rounded-lg bg-slate-900/80 border border-amber-500/40 text-[10px] text-amber-200 font-mono"
                  >
                    {c.column} {c.from} → {c.to}
                  </span>
                ))}
              </div>
            )}
            {showSql && (
              <pre className="p-2.5 bg-slate-950 rounded-xl border border-slate-800 text-[10px] text-slate-300 whitespace-pre-wrap break-all max-h-48 overflow-auto">
                {result.plan.scenarioSql}
              </pre>
            )}
          </div>

          {/* 对比表 */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-900 text-slate-400">
                  <th className="text-left px-3 py-1.5 font-semibold">指标列</th>
                  <th className="text-right px-3 py-1.5 font-semibold">原口径</th>
                  <th className="text-right px-3 py-1.5 font-semibold">情景口径</th>
                  <th className="text-right px-3 py-1.5 font-semibold">变化</th>
                  <th className="text-right px-3 py-1.5 font-semibold">变化率</th>
                </tr>
              </thead>
              <tbody>
                {result.comparisons.map((c) => {
                  // 行数不变时 sum/avg 变化率一致，合并为一行；否则分行展示合计/均值
                  const merged = c.deltaPct.sum !== null && c.deltaPct.sum === c.deltaPct.avg;
                  return (
                    <React.Fragment key={c.column}>
                      <tr className="border-t border-slate-800/60 text-slate-200">
                        <td className="px-3 py-1.5" rowSpan={merged ? 1 : 2}>
                          {c.column}
                          {!merged && <span className="ml-1 text-[9px] text-slate-500">合计/均值</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-400" rowSpan={merged ? 1 : 2}>
                          {fmt(c.before.sum)}
                          {!merged && <div className="text-[10px] text-slate-500">{fmt(c.before.avg)}</div>}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-300" rowSpan={merged ? 1 : 2}>
                          {fmt(c.after.sum)}
                          {!merged && <div className="text-[10px] text-slate-500">{fmt(c.after.avg)}</div>}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono font-semibold ${
                            c.delta.sum > 0 ? 'text-emerald-300' : c.delta.sum < 0 ? 'text-rose-300' : 'text-slate-400'
                          }`}
                        >
                          {c.delta.sum > 0 ? '+' : ''}{fmt(c.delta.sum)}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono ${
                            (c.deltaPct.sum ?? 0) > 0 ? 'text-emerald-300' : (c.deltaPct.sum ?? 0) < 0 ? 'text-rose-300' : 'text-slate-400'
                          }`}
                        >
                          {signedPct(c.deltaPct.sum)}
                        </td>
                      </tr>
                      {!merged && (
                        <tr className="text-slate-400 bg-slate-950/40">
                          <td className="px-3 py-1 text-right font-mono text-[10px]">
                            {c.delta.avg > 0 ? '+' : ''}{fmt(c.delta.avg)}
                          </td>
                          <td
                            className={`px-3 py-1 text-right font-mono text-[10px] ${
                              (c.deltaPct.avg ?? 0) > 0 ? 'text-emerald-300' : (c.deltaPct.avg ?? 0) < 0 ? 'text-rose-300' : 'text-slate-500'
                            }`}
                          >
                            {signedPct(c.deltaPct.avg)}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 行数提示 */}
          <div className="text-[10px] text-slate-500">
            原口径返回 {result.before.rowCount} 行，情景口径返回 {result.after.rowCount} 行
            {result.before.rowCount !== result.after.rowCount && '（行数变化说明情景改变了命中范围）'}
          </div>

          {/* 对比摘要 */}
          {result.summaryLines.length > 0 && (
            <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-2xl space-y-1">
              <div className="text-[10px] font-semibold text-slate-400">对比摘要</div>
              {result.summaryLines.map((line, i) => (
                <div key={i} className="text-[11px] text-slate-300 leading-relaxed">{line}</div>
              ))}
            </div>
          )}

          {/* LLM 解读 */}
          {result.interpretation && (
            <div className="p-3.5 bg-violet-950/30 border border-violet-500/30 rounded-2xl space-y-2">
              <div className="flex items-center space-x-1.5 font-bold text-violet-300 text-xs">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>AI 推演解读</span>
              </div>
              {readStr(result.interpretation, 'summary') && (
                <div className="text-xs text-slate-200 leading-relaxed">{readStr(result.interpretation, 'summary')}</div>
              )}
              {readStr(result.interpretation, 'verdict') && (
                <div className="p-2 bg-slate-900/80 rounded-xl border border-violet-500/30 text-[11px] text-violet-200">
                  {readStr(result.interpretation, 'verdict')}
                </div>
              )}
              {readStrList(result.interpretation, 'caveats').length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[10px] font-semibold text-slate-400">口径提醒</div>
                  {readStrList(result.interpretation, 'caveats').map((c, i) => (
                    <div key={i} className="text-[10px] text-slate-400 leading-relaxed">· {c}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!result && !loading && !error && (
        <div className="p-4 text-center text-[10px] text-slate-600 border border-dashed border-slate-800 rounded-2xl">
          输入一个「如果……会怎样」的场景假设，系统会基于图表原 SQL 改写条件并对比执行，给出量化影响。
        </div>
      )}
    </div>
  );
};
