import React from 'react';
import { Bot } from 'lucide-react';
import { TraceStepper, TraceStepInfo } from './AnalysisTracePanel';

interface QueryLoadingIndicatorProps {
  /** P2-7 SSE 流式进度：服务端阶段事件推送的实时状态文案 */
  streamProgress: string | null;
  /** P2-1 SQL 先行回显：sql_ready/executed 阶段携带的 SQL，长等待期提前展示 */
  streamPreviewSql: string | null;
  /** M1 推导留痕：SSE trace 事件实时追加的步骤链 */
  liveTraceSteps: TraceStepInfo[];
}

/**
 * 问数加载指示区（P0 上帝组件拆分：自 QueryChat 提取的纯展示组件）。
 * 含加载 spinner、流式进度文案、SQL 先行预览、实时推导步骤器。
 */
export const QueryLoadingIndicator: React.FC<QueryLoadingIndicatorProps> = ({
  streamProgress,
  streamPreviewSql,
  liveTraceSteps,
}) => {
  return (
    <div className="flex items-start space-x-3">
      <div className="w-8 h-8 rounded-xl bg-slate-800 text-indigo-400 flex items-center justify-center border border-slate-700 animate-pulse">
        <Bot className="w-4 h-4" />
      </div>
      <div className="flex-1 space-y-2">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-xs text-slate-300 flex items-center space-x-3">
          <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span>{streamProgress || 'AI 正在解析 Schema 并生成智能可视化数据...'}</span>
        </div>
        {/* P2-1 SQL 先行回显：阶段一完成即展示生成的 SQL，缩短长执行的感知等待 */}
        {streamPreviewSql && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3">
            <div className="text-[10px] font-bold text-emerald-400/80 mb-1.5">已生成 SQL（先行预览，最终以执行结果为准）</div>
            <pre className="text-[10px] leading-relaxed text-slate-400 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto select-all">{streamPreviewSql}</pre>
          </div>
        )}
        {/* M1 分析过程显性呈现：实时步骤器展示已完成的推导环节 */}
        {liveTraceSteps.length > 0 && <TraceStepper steps={liveTraceSteps} />}
      </div>
    </div>
  );
};
