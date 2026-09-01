import React, { useState } from 'react';
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, Route, Database, Search, FileSearch, Lightbulb, ListChecks, Table2, Brain, Code2 } from 'lucide-react';
import { apiFetch } from '../../api/client';

/**
 * M1 推导过程可视化：
 * - TraceStepper：查询进行中的横向步骤器（SSE trace 事件实时追加）
 * - TraceReplay：完成后按 traceId 拉取完整推导链，垂直时间线逐环节可展开查看
 */

export interface TraceStepInfo {
  stepType: string;
  title: string;
  inputSummary?: string;
  outputSummary?: string;
  sqlText?: string;
  rowCount?: number;
  durationMs?: number;
  status?: 'ok' | 'fail';
}

const STEP_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  understanding: Brain,
  linking: Search,
  knowledge: FileSearch,
  metrics: Lightbulb,
  introspection: Database,
  plan: ListChecks,
  intermediate: Table2,
  template_match: CheckCircle2, // v0.4.15 C: 模板命中
  sql_gen: Code2,
  execution: Database,
  result_check: XCircle, // v0.4.15 D: 结果合理性校验
  analysis: Lightbulb,
  report: Route,
};

function fmtMs(ms?: number): string {
  if (typeof ms !== 'number' || ms < 0) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 垂直时间线：每个环节卡片可展开查看输入/输出摘要与 SQL */
export const TraceTimeline: React.FC<{ steps: TraceStepInfo[] }> = ({ steps }) => {
  const [openIdx, setOpenIdx] = useState<number | null>(steps.length > 0 ? steps.length - 1 : null);

  if (steps.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {steps.map((s, i) => {
        const Icon = STEP_ICON[s.stepType] || Route;
        const failed = s.status === 'fail';
        const open = openIdx === i;
        const hasDetail = Boolean(s.inputSummary || s.outputSummary || s.sqlText || typeof s.rowCount === 'number');
        // v0.4.15: 模板命中用特殊高亮，结果校验用黄色警示
        const isTemplateMatch = s.stepType === 'template_match';
        const isResultCheck = s.stepType === 'result_check';
        return (
          <div key={i} className={`rounded-xl border ${failed ? 'border-rose-500/40 bg-rose-950/20' : isTemplateMatch ? 'border-emerald-500/30 bg-emerald-950/20' : isResultCheck ? 'border-amber-500/30 bg-amber-950/20' : 'border-slate-800 bg-slate-950/60'}`}>
            <button
              type="button"
              onClick={() => hasDetail && setOpenIdx(open ? null : i)}
              className={`w-full flex items-center space-x-2 px-3 py-2 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${failed ? 'bg-rose-500/20 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                {failed ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              </span>
              <Icon className={`w-3.5 h-3.5 shrink-0 ${failed ? 'text-rose-400' : 'text-indigo-400'}`} />
              <span className="flex-1 truncate text-[11px] text-slate-200 font-medium">
                {i + 1}. {s.title}
              </span>
              {typeof s.rowCount === 'number' && s.rowCount >= 0 && (
                <span className="shrink-0 text-[10px] text-slate-500 font-mono">{s.rowCount} 行</span>
              )}
              {fmtMs(s.durationMs) && (
                <span className="shrink-0 text-[10px] text-slate-500 font-mono">{fmtMs(s.durationMs)}</span>
              )}
              {hasDetail && (
                open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-500" />
              )}
            </button>
            {open && hasDetail && (
              <div className="px-3 pb-2.5 pt-0.5 space-y-1.5 border-t border-slate-800/60">
                {s.inputSummary && (
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    <span className="text-slate-500 font-semibold">输入：</span>
                    {s.inputSummary}
                  </p>
                )}
                {s.outputSummary && (
                  <p className="text-[10px] text-slate-300 leading-relaxed">
                    <span className="text-slate-500 font-semibold">输出：</span>
                    {s.outputSummary}
                  </p>
                )}
                {s.sqlText && (
                  <pre className="text-[10px] font-mono text-emerald-300/90 bg-slate-900 border border-slate-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {s.sqlText}
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** 查询进行中的实时步骤器：横向展示已完成步骤与当前进行中状态 */
export const TraceStepper: React.FC<{ steps: TraceStepInfo[] }> = ({ steps }) => {
  if (steps.length === 0) return null;
  const latest = steps[steps.length - 1];
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 space-y-2">
      <div className="flex items-center flex-wrap gap-1.5">
        {steps.map((s, i) => {
          const Icon = STEP_ICON[s.stepType] || Route;
          const failed = s.status === 'fail';
          return (
            <span
              key={i}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-lg border text-[10px] ${
                failed
                  ? 'border-rose-500/40 bg-rose-950/40 text-rose-300'
                  : 'border-emerald-500/30 bg-emerald-950/30 text-emerald-300'
              }`}
              title={s.outputSummary || s.title}
            >
              <Icon className="w-3 h-3" />
              <span>{s.title}</span>
              {fmtMs(s.durationMs) && <span className="text-[9px] opacity-70 font-mono">{fmtMs(s.durationMs)}</span>}
            </span>
          );
        })}
        <span className="flex items-center space-x-1 px-2 py-0.5 rounded-lg border border-indigo-500/40 bg-indigo-950/40 text-indigo-300 text-[10px]">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>处理中</span>
        </span>
      </div>
      {latest.outputSummary && (
        <p className="text-[10px] text-slate-500 truncate">{latest.title}：{latest.outputSummary}</p>
      )}
    </div>
  );
};

/** 完成后的推导回放入口：点击按需拉取完整推导链并内嵌时间线展示 */
export const TraceReplay: React.FC<{ traceId: string }> = ({ traceId }) => {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TraceStepInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!open && steps === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/query/trace/${encodeURIComponent(traceId)}`);
        const data = await res.json();
        if (!res.ok || !Array.isArray(data?.steps)) throw new Error(data?.error || '推导记录加载失败');
        setSteps(data.steps);
      } catch (e: any) {
        setError(e?.message || '推导记录加载失败');
      } finally {
        setLoading(false);
      }
    }
    setOpen(!open);
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-violet-950/50 border border-violet-500/30 text-violet-300 hover:border-violet-400 text-[11px] font-medium transition-colors"
      >
        <Route className="w-3.5 h-3.5" />
        <span>{open ? '收起推导过程' : '查看推导过程'}</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin" />}
      </button>
      {open && (
        error ? (
          <p className="text-[11px] text-rose-400">{error}</p>
        ) : steps && steps.length > 0 ? (
          <TraceTimeline steps={steps} />
        ) : !loading ? (
          <p className="text-[11px] text-slate-500">暂无推导记录（可能为演示模式或缓存结果）</p>
        ) : null
      )}
    </div>
  );
};
