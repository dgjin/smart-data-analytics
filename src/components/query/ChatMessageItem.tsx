// P0-1 拆分：单条对话消息卡片（用户提问 / 助手回答）——从 QueryChat.tsx 抽出的纯展示组件，
// 涵盖反馈点赞、数据来源徽标、语义缓存、DLP 提示、歧义澄清、M2 计划卡片、P1-7 Agent 编排卡片、
// 报告卡片、KPI/图表/明细表结果区与推荐追问；一切状态变更通过回调 props 回传父组件
import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  Bot,
  CheckCircle,
  Code2,
  Copy,
  FileText,
  HelpCircle,
  Lightbulb,
  ListChecks,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
  XCircle,
  Zap,
} from 'lucide-react';
import { ChartConfig, ChatMessage, QueryResultData } from '../../types/analytics';
import { ChartCustomizer } from '../charts/ChartCustomizer';
import { DataTable } from '../charts/DataTable';
import { DynamicChart } from '../charts/DynamicChart';
import { KPIStats } from '../charts/KPIStats';
import { TraceReplay } from './AnalysisTracePanel';

export interface ChatMessageItemProps {
  msg: ChatMessage;
  /** 欢迎语内容：welcome- 前缀消息的 content 以当前数据源真实表结构动态替换 */
  welcomeContent: string;
  isQueryLoading: boolean;
  /** 歧义澄清是否已确认口径（确认后选项置灰） */
  clarificationResolved: boolean;
  /** M2 计划卡片是否已处理（批准/修改/取消后置灰） */
  planResolved: boolean;
  /** P1-7 Agent 编排计划卡片是否已处理（批准/取消后置灰） */
  agentPlanResolved: boolean;
  onInspectSql: (result: QueryResultData) => void;
  onFeedback: (msg: ChatMessage, verdict: 'UP' | 'DOWN') => void;
  onSendQuery: (queryText?: string, approvedPlanId?: string, options?: { refreshCache?: boolean }) => void;
  onCopyQuestion: (content: string) => void;
  onEditQuestion: (content: string) => void;
  onSelectClarification: (msg: ChatMessage, query: string) => void;
  onApprovePlan: (msg: ChatMessage) => void;
  onEditPlanQuestion: (msg: ChatMessage) => void;
  onDismissPlan: (msgId: string) => void;
  /** P1-7 Agent 编排：批准执行计划（父组件调 /api/agent/run 并落结果消息） */
  onApproveAgentPlan: (msg: ChatMessage) => void;
  onDismissAgentPlan: (msgId: string) => void;
  onUpdateChartConfig: (msgId: string, config: ChartConfig) => void;
  onPinChart: (msg: ChatMessage) => void;
  onOpenReport: (reportId: string) => void;
}

/** 推导回放 traceId 需匹配服务端校验格式（GET /api/query/trace/:traceId 的 tr_ 前缀白名单） */
const TRACE_ID_PATTERN = /^tr_[A-Za-z0-9_]{6,40}$/;

/** P1-7 Agent 能力标签样式 */
const CAPABILITY_META: Record<string, { label: string; cls: string }> = {
  query: { label: '问数', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' },
  forecast: { label: '时序预测', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/40' },
  attribution: { label: '多维归因', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
};

function capabilityBadge(capability: string): React.ReactNode {
  const meta = CAPABILITY_META[capability] || { label: capability, cls: 'bg-slate-700/40 text-slate-300 border-slate-600' };
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold shrink-0 ${meta.cls}`}>{meta.label}</span>
  );
}

function agentNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(v);
}

/** Agent 计划卡参数摘要（forecast/attribution 步）：列与期数一目了然 */
function agentStepParamsSummary(step: { capability: string; params: Record<string, unknown> }): string {
  const p = step.params || {};
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  if (step.capability === 'forecast') {
    return [s(p.yKey) && `指标：${s(p.yKey)}`, s(p.xKey) && `期列：${s(p.xKey)}`, typeof p.periods === 'number' && `预测 ${p.periods} 期`]
      .filter(Boolean)
      .join(' · ');
  }
  if (step.capability === 'attribution') {
    return [s(p.dimKey) && `维度：${s(p.dimKey)}`, s(p.periodKey) && `时期：${s(p.periodKey)}`, s(p.metricKey) && `指标：${s(p.metricKey)}`]
      .filter(Boolean)
      .join(' · ');
  }
  return '';
}

export const ChatMessageItem: React.FC<ChatMessageItemProps> = ({
  msg,
  welcomeContent,
  isQueryLoading,
  clarificationResolved,
  planResolved,
  agentPlanResolved,
  onInspectSql,
  onFeedback,
  onSendQuery,
  onCopyQuestion,
  onEditQuestion,
  onSelectClarification,
  onApprovePlan,
  onEditPlanQuestion,
  onDismissPlan,
  onApproveAgentPlan,
  onDismissAgentPlan,
  onUpdateChartConfig,
  onPinChart,
  onOpenReport,
}) => {
  const isUser = msg.role === 'user';

  // v0.9.38 结果全屏：图表与明细在 fixed 叠层内放大完整呈现（Esc/按钮退出），交互对齐灵活查询的 fullZone 模式
  const [resultFull, setResultFull] = useState(false);
  useEffect(() => {
    if (!resultFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setResultFull(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [resultFull]);

  /** 结果区主体（KPI/洞察/图表/明细）：普通与全屏两态复用同一份 JSX，full 时图表加高、明细分页放大 */
  const renderResultBody = (full: boolean) => {
    const qr = msg.queryResult;
    if (!qr) return null;
    return (
      <>
        {/* KPI Cards */}
        {qr.kpiMetrics && <KPIStats metrics={qr.kpiMetrics} />}

        {/* AI Key Insights Box */}
        {qr.keyInsights && qr.keyInsights.length > 0 && (
          <div className="p-3.5 bg-indigo-950/40 border border-indigo-500/30 rounded-2xl space-y-2">
            <div className="flex items-center space-x-1.5 font-bold text-indigo-300 text-xs">
              <Lightbulb className="w-4 h-4 text-amber-400" />
              <span>AI 归因分析与决策提示:</span>
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-slate-200">
              {qr.keyInsights.map((insight, idx) => (
                <li
                  key={idx}
                  className="p-2 bg-slate-900/80 rounded-xl border border-slate-800/80 flex items-start space-x-2"
                >
                  <span className="w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">
                    {idx + 1}
                  </span>
                  <span className="leading-tight">{insight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Interactive Chart */}
        {qr.chartConfig && (
          <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <BarChart3 className="w-4 h-4 text-cyan-400" />
                <h4 className="font-bold text-slate-100 text-sm">
                  {qr.chartConfig.title}
                </h4>
              </div>
            </div>

            {/* Chart Customizer Toolbar */}
            <ChartCustomizer
              config={qr.chartConfig}
              onChange={(newConfig) => onUpdateChartConfig(msg.id, newConfig)}
              onPinToDashboard={() => onPinChart(msg)}
            />

            {/* Render Chart（全屏时加高，保证多系列/长类目轴完整可读） */}
            <DynamicChart
              config={qr.chartConfig}
              data={qr.rows}
              height={full ? 560 : 320}
            />
          </div>
        )}

        {/* Data Table（全屏时每页 50 行，减少翻页即可看全明细） */}
        {qr.rows && (
          <DataTable
            data={qr.rows}
            columnNames={qr.columnNames}
            title="明细数据集"
            pageSize={full ? 50 : 10}
          />
        )}
      </>
    );
  };

  return (
    <div
      className={`flex items-start space-x-3 ${
        isUser ? 'flex-row-reverse space-x-reverse' : ''
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm ${
          isUser
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-800 text-indigo-400 border border-slate-700'
        }`}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>

      {/* Message Card */}
      <div
        className={`max-w-4xl space-y-3 ${
          isUser
            ? 'bg-indigo-600/90 text-white px-4 py-2.5 rounded-2xl rounded-tr-none text-xs leading-relaxed shadow-md'
            : 'w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 md:p-5 shadow-sm text-xs text-slate-200'
        }`}
      >
        {/* Header info */}
        <div className="flex items-center justify-between border-b border-slate-800/60 pb-2 text-[11px] text-slate-400">
          <span className="flex items-center space-x-2">
            <span className="font-semibold text-slate-300">
              {isUser ? '你' : '智能数据分析助手 NL2SQL'}
            </span>
            {!isUser && msg.queryResult?.expertPersona && (
              <span
                className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium"
                title="根据你的问题内容自动匹配的专家分析视角"
              >
                {msg.queryResult.expertPersona}视角
              </span>
            )}
          </span>
          <div className="flex items-center space-x-3">
            {msg.queryResult && !isUser && (
              <button
                onClick={() => onInspectSql(msg.queryResult!)}
                className="flex items-center space-x-1 text-indigo-400 hover:text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded-md border border-indigo-500/30 font-medium transition-colors"
              >
                <Code2 className="w-3 h-3" />
                <span>查看生成的 SQL</span>
              </button>
            )}
            {msg.queryResult && !isUser && msg.question && (
              <span className="flex items-center space-x-1" title="对本次回答进行评价">
                <button
                  onClick={() => onFeedback(msg, 'UP')}
                  disabled={Boolean(msg.feedback)}
                  className={`p-1 rounded-md border transition-colors ${
                    msg.feedback === 'UP'
                      ? 'text-emerald-400 border-emerald-500/50 bg-emerald-950/40'
                      : 'text-slate-400 border-slate-700 hover:text-emerald-400 hover:border-emerald-500/50 disabled:opacity-50'
                  }`}
                  aria-label="回答有帮助"
                >
                  <ThumbsUp className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onFeedback(msg, 'DOWN')}
                  disabled={Boolean(msg.feedback)}
                  className={`p-1 rounded-md border transition-colors ${
                    msg.feedback === 'DOWN'
                      ? 'text-rose-400 border-rose-500/50 bg-rose-950/40'
                      : 'text-slate-400 border-slate-700 hover:text-rose-400 hover:border-rose-500/50 disabled:opacity-50'
                  }`}
                  aria-label="回答不准确"
                >
                  <ThumbsDown className="w-3 h-3" />
                </button>
              </span>
            )}
            <span>{msg.timestamp}</span>
          </div>
        </div>

        {/* Fallback Data Notice */}
        {msg.isFallback && !isUser && (
          <div className="p-2 rounded-lg bg-amber-950/50 border border-amber-500/40 text-amber-300 text-[11px] flex items-center space-x-1.5">
            <Lightbulb className="w-3.5 h-3.5 shrink-0" />
            <span>AI 服务当前不可用，以下展示为内置示例数据，仅用于演示界面功能。</span>
          </div>
        )}

        {/* 拒答提示：问题与数据源无关/超出能力，如实反馈（无演示数据托底） */}
        {!isUser && msg.refused && (
          <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-500/40 text-slate-300 text-[11px] flex items-center space-x-1.5">
            <HelpCircle className="w-3.5 h-3.5 shrink-0" />
            <span>问数仅支持当前数据源相关的数据分析；该问题与数据无关或数据源中缺少支撑数据，未生成任何结果。</span>
          </div>
        )}

        {/* 数据来源徽标（P1：live = 真实库执行；simulated = 演示数据，CSV/demo 等场景强制标记） */}
        {!isUser && msg.queryResult && msg.dataProvenance === 'live' && (
          <div className="p-2 rounded-lg bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 text-[11px] flex items-center space-x-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>真实数据：SQL 已在数据库中实际执行，图表与解读均基于返回的 {msg.queryResult.totalCount} 行结果。</span>
          </div>
        )}
        {!isUser && msg.queryResult && !msg.isFallback && msg.dataProvenance === 'simulated' && (
          <div className="p-2 rounded-lg bg-amber-950/50 border border-amber-500/40 text-amber-300 text-[11px] flex items-center space-x-1.5">
            <Lightbulb className="w-3.5 h-3.5 shrink-0" />
            <span>演示数据：当前数据源不支持真实查询（非 MySQL 直连），以下为 AI 生成的模拟数据，仅供演示。</span>
          </div>
        )}

        {/* P1-6 语义缓存命中提示：来自相似问题缓存，可一键刷新重新走真实查询 */}
        {!isUser && msg.semanticCache && (
          <div className="p-2 rounded-lg bg-sky-950/50 border border-sky-500/40 text-sky-300 text-[11px] flex items-center justify-between gap-2">
            <div className="flex items-center space-x-1.5 min-w-0">
              <Zap className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate" title={msg.semanticCache.matchedQuestion}>
                来自相似问题缓存（原问题：{msg.semanticCache.matchedQuestion}，相似度 {(msg.semanticCache.similarity * 100).toFixed(1)}%）
              </span>
            </div>
            <button
              onClick={() => msg.question && onSendQuery(msg.question, undefined, { refreshCache: true })}
              disabled={isQueryLoading}
              className="shrink-0 px-2 py-0.5 rounded bg-sky-900/60 hover:bg-sky-800 border border-sky-500/40 text-sky-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              重新查询
            </button>
          </div>
        )}

        {/* P2-12 DLP 脱敏提示：结果中敏感字段已按角色策略掩码 */}
        {!isUser && msg.dlpMaskedLabels && msg.dlpMaskedLabels.length > 0 && (
          <div className="p-2 rounded-lg bg-violet-950/50 border border-violet-500/40 text-violet-300 text-[11px] flex items-center space-x-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>DLP 数据防泄漏：结果中的{msg.dlpMaskedLabels.join('、')}已按你的角色权限自动脱敏。</span>
          </div>
        )}

        {/* Sensitive Column Filter Notice（L7 敏感标记） */}
        {!isUser && (msg.sensitiveFiltered ?? 0) > 0 && (
          <div className="p-2 rounded-lg bg-sky-950/50 border border-sky-500/40 text-sky-300 text-[11px] flex items-center space-x-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>安全策略已从 AI 分析上下文中剔除 {msg.sensitiveFiltered} 个敏感字段，本次分析不会涉及这些数据。</span>
          </div>
        )}

        {/* M1 推导回放：按需拉取本次问数的全链路步骤时间线；
            仅服务端校验格式可回放——v0.9.53 前 Agent 编排旧消息的 agent- 前缀 traceId 无留痕记录，不展示入口 */}
        {!isUser && msg.traceId && TRACE_ID_PATTERN.test(msg.traceId) && <TraceReplay traceId={msg.traceId} />}

        {/* Content Text（欢迎语按当前数据源真实表结构动态生成） */}
        <div className="whitespace-pre-wrap leading-relaxed text-sm">
          {msg.id.startsWith('welcome-') ? welcomeContent : msg.content}
        </div>

        {/* 歧义澄清卡片：语义理解存在异议时展示候选口径，用户点选后按该理解重新提交 */}
        {!isUser && msg.clarification && msg.clarification.options.length > 0 && (
          <div className="p-3 bg-sky-950/40 border border-sky-500/30 rounded-2xl space-y-2">
            <div className="flex items-center space-x-1.5 font-bold text-sky-300 text-xs">
              <HelpCircle className="w-4 h-4" />
              <span>请选择您想要的分析口径（确认后将按该理解执行）:</span>
            </div>
            <div className="space-y-1.5">
              {msg.clarification.options.map((opt, idx) => {
                return (
                  <button
                    key={idx}
                    disabled={clarificationResolved || isQueryLoading}
                    onClick={() => onSelectClarification(msg, opt.query)}
                    title={opt.query}
                    className="w-full text-left px-3 py-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 hover:border-sky-500/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="text-xs font-semibold text-sky-200">{opt.label}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5 truncate">{opt.query}</div>
                  </button>
                );
              })}
            </div>
            {clarificationResolved && (
              <div className="text-[11px] text-slate-500 flex items-center space-x-1">
                <CheckCircle className="w-3 h-3 text-emerald-400" />
                <span>已确认口径，正在按该理解执行分析…</span>
              </div>
            )}
          </div>
        )}

        {/* M2 计划卡片：执行前展示编号步骤与涉及表，批准后携带 planId 提交 */}
        {!isUser && msg.queryPlan && (
          <div className="p-3 bg-violet-950/30 border border-violet-500/30 rounded-2xl space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5 font-bold text-violet-300 text-xs">
                <ListChecks className="w-4 h-4" />
                <span>分析计划（{msg.queryPlan.steps.length} 步 · {msg.queryPlan.complexity === 'multi-step' ? '多步复合' : '单步简单'}）</span>
              </div>
              {msg.queryPlan.relatedTables.length > 0 && (
                <div className="flex items-center space-x-1 flex-wrap justify-end">
                  <span className="text-[10px] text-slate-500">涉及表:</span>
                  {msg.queryPlan.relatedTables.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono text-slate-300">{t}</span>
                  ))}
                </div>
              )}
            </div>
            <ol className="space-y-1.5">
              {msg.queryPlan.steps.map((st, idx) => (
                <li key={idx} className="flex items-start space-x-2 p-2 rounded-xl bg-slate-900/80 border border-slate-800/80">
                  <span className="w-4 h-4 rounded-full bg-violet-500/20 text-violet-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">{idx + 1}</span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-200">
                      {st.title}
                      <span className="ml-1.5 text-[10px] text-slate-500 font-mono">{st.type}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{st.description}</div>
                  </div>
                </li>
              ))}
            </ol>
            {planResolved ? (
              <div className="text-[11px] text-slate-500 flex items-center space-x-1">
                <CheckCircle className="w-3 h-3 text-emerald-400" />
                <span>该计划已处理，如需重新执行请重新制定计划。</span>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <button
                  disabled={isQueryLoading}
                  onClick={() => onApprovePlan(msg)}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  批准执行
                </button>
                <button
                  disabled={isQueryLoading}
                  onClick={() => onEditPlanQuestion(msg)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50"
                >
                  修改提问
                </button>
                <button
                  onClick={() => onDismissPlan(msg.id)}
                  className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-rose-400 text-xs transition-colors"
                >
                  取消
                </button>
                <span className="text-[10px] text-slate-500 ml-auto">计划 10 分钟内有效</span>
              </div>
            )}
          </div>
        )}

        {/* P1-7 Agent 编排计划卡片：Planner 规划的多能力步骤，批准后逐步执行（取数→统计） */}
        {!isUser && msg.agentPlan && (
          <div className="p-3 bg-fuchsia-950/30 border border-fuchsia-500/30 rounded-2xl space-y-2.5">
            <div className="flex items-center space-x-1.5 font-bold text-fuchsia-300 text-xs">
              <Bot className="w-4 h-4" />
              <span>多能力编排计划（{msg.agentPlan.steps.length} 步）</span>
            </div>
            <ol className="space-y-1.5">
              {msg.agentPlan.steps.map((st, idx) => {
                const paramsSummary = agentStepParamsSummary(st);
                return (
                  <li key={st.id} className="flex items-start space-x-2 p-2 rounded-xl bg-slate-900/80 border border-slate-800/80">
                    <span className="w-4 h-4 rounded-full bg-fuchsia-500/20 text-fuchsia-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-1.5">
                        {capabilityBadge(st.capability)}
                        <span className="text-xs font-semibold text-slate-200 truncate">{st.goal}</span>
                      </div>
                      {paramsSummary && <div className="text-[10px] text-slate-500 mt-0.5">{paramsSummary}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
            {agentPlanResolved ? (
              <div className="text-[11px] text-slate-500 flex items-center space-x-1">
                <CheckCircle className="w-3 h-3 text-emerald-400" />
                <span>该编排计划已处理，如需重新执行请重新提问。</span>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <button
                  disabled={isQueryLoading}
                  onClick={() => onApproveAgentPlan(msg)}
                  className="px-3 py-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  批准执行
                </button>
                <button
                  onClick={() => onDismissAgentPlan(msg.id)}
                  className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-rose-400 text-xs transition-colors"
                >
                  取消
                </button>
                <span className="text-[10px] text-slate-500 ml-auto">计划 10 分钟内有效 · 执行时逐步真实取数</span>
              </div>
            )}
          </div>
        )}

        {/* P1-7 Agent 编排执行结果卡片：每步的取数/预测/归因结果与状态 */}
        {!isUser && msg.agentRun && (
          <div className="p-3 bg-fuchsia-950/20 border border-fuchsia-500/25 rounded-2xl space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5 font-bold text-fuchsia-300 text-xs">
                <Bot className="w-4 h-4" />
                <span>
                  编排执行结果（{msg.agentRun.steps.filter((s) => s.ok).length}/{msg.agentRun.steps.length} 步成功）
                </span>
              </div>
            </div>
            <div className="space-y-2">
              {msg.agentRun.steps.map((step) => (
                <div key={step.id} className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800/80 space-y-1.5">
                  {/* 步骤头 */}
                  <div className="flex items-center space-x-1.5">
                    {step.ok ? (
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    )}
                    {capabilityBadge(step.capability)}
                    <span className="text-xs font-semibold text-slate-200 truncate">{step.goal}</span>
                  </div>
                  {/* 摘要 */}
                  <div className={`text-[11px] leading-relaxed ${step.ok ? 'text-slate-400' : 'text-rose-300'}`}>
                    {step.error || step.summary}
                  </div>

                  {/* query 步：数据预览小表 */}
                  {step.ok && step.rows && step.rows.length > 0 && step.columns && (
                    <div className="border border-slate-800 rounded-lg overflow-hidden">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="bg-slate-900 text-slate-400">
                            {step.columns.slice(0, 6).map((c) => (
                              <th key={c} className="text-left px-2 py-1 font-semibold truncate max-w-[120px]">{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {step.rows.slice(0, 5).map((r, i) => (
                            <tr key={i} className="border-t border-slate-800/60 text-slate-300">
                              {step.columns!.slice(0, 6).map((c) => (
                                <td key={c} className="px-2 py-1 truncate max-w-[120px]">
                                  {(r as Record<string, unknown>)[c] === null || (r as Record<string, unknown>)[c] === undefined
                                    ? ''
                                    : String((r as Record<string, unknown>)[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {(step.rowCount || 0) > 5 && (
                        <div className="px-2 py-1 text-[9px] text-slate-500 border-t border-slate-800/60">
                          仅预览前 5 行，共 {step.rowCount} 行
                        </div>
                      )}
                    </div>
                  )}

                  {/* forecast 步：预测点摘要表 */}
                  {step.ok && step.forecast && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-slate-500">
                        模型 {step.forecast.model} ｜ MAPE {agentNum(step.forecast.fit.mape)}% ｜ R² {agentNum(step.forecast.fit.r2)}
                      </div>
                      <div className="border border-slate-800 rounded-lg overflow-hidden">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="bg-slate-900 text-slate-400">
                              <th className="text-left px-2 py-1 font-semibold">期次</th>
                              <th className="text-right px-2 py-1 font-semibold">预测值</th>
                              <th className="text-right px-2 py-1 font-semibold">80% 区间</th>
                            </tr>
                          </thead>
                          <tbody>
                            {step.forecast.points.map((p) => (
                              <tr key={p.step} className="border-t border-slate-800/60 text-slate-300">
                                <td className="px-2 py-1">未来第 {p.step} 期</td>
                                <td className="px-2 py-1 text-right font-mono text-violet-300">{agentNum(p.yhat)}</td>
                                <td className="px-2 py-1 text-right font-mono text-slate-400">
                                  {agentNum(p.lower)} ~ {agentNum(p.upper)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* attribution 步：贡献 TOP 列表 */}
                  {step.ok && step.attribution && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-slate-500">
                        对比期 {step.attribution.periods[0]} → {step.attribution.periods[1]} ｜ 总体{' '}
                        {step.attribution.total.delta > 0 ? '+' : ''}
                        {agentNum(step.attribution.total.delta)}
                        {step.attribution.total.deltaPct === null ? '' : `（${step.attribution.total.deltaPct > 0 ? '+' : ''}${step.attribution.total.deltaPct}%）`}
                      </div>
                      <div className="space-y-0.5">
                        {[...step.attribution.items]
                          .sort((a, b) => a.rank - b.rank)
                          .slice(0, 5)
                          .map((item, i) => (
                            <div key={i} className="flex items-center justify-between text-[10px] px-2 py-0.5 bg-slate-950/60 rounded">
                              <span className="text-slate-300 truncate max-w-[180px]" title={item.dims.join('/')}>
                                #{item.rank} {item.dims.join('/') || '合计'}
                              </span>
                              <span className="flex items-center space-x-2 shrink-0">
                                <span className={`font-mono font-semibold ${item.delta > 0 ? 'text-emerald-300' : item.delta < 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                                  {item.delta > 0 ? '+' : ''}
                                  {agentNum(item.delta)}
                                </span>
                                <span className={`font-mono w-12 text-right ${item.contribution > 0 ? 'text-emerald-300' : item.contribution < 0 ? 'text-rose-300' : 'text-slate-500'}`}>
                                  {item.contribution > 0 ? '+' : ''}{item.contribution}%
                                </span>
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {msg.agentRun.finalSummary && (
              <div className="text-[11px] text-fuchsia-200/90 leading-relaxed border-t border-fuchsia-500/20 pt-2">
                {msg.agentRun.finalSummary}
              </div>
            )}
          </div>
        )}

        {/* v0.5.0 报告卡片：报告模式生成的完整报告摘要，点击跳转报告中心查看详情 */}
        {!isUser && msg.reportCard && (
          <div className="p-4 bg-emerald-950/30 border border-emerald-500/30 rounded-2xl space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5 font-bold text-emerald-300 text-xs">
                <FileText className="w-4 h-4" />
                <span>分析报告已生成（模板：{msg.reportCard.templateName}）</span>
              </div>
            </div>
            <div className="text-sm font-bold text-slate-100">{msg.reportCard.title}</div>
            {msg.reportCard.summary && (
              <div className="text-xs text-slate-400 leading-relaxed line-clamp-2">{msg.reportCard.summary}…</div>
            )}
            <div className="flex items-center space-x-3 text-[11px] text-slate-400">
              <span>KPI {msg.reportCard.kpiCount} 项</span>
              <span>图表 {msg.reportCard.chartCount} 张</span>
              <span>洞察 {msg.reportCard.insightCount} 条</span>
            </div>
            <button
              onClick={() => onOpenReport(msg.reportCard!.reportId)}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
            >
              查看完整报告
            </button>
          </div>
        )}

        {/* 用户提问操作条：复制问题 / 再次编辑 */}
        {isUser && (
          <div className="flex items-center justify-end space-x-2 pt-1.5 mt-0.5 border-t border-white/15">
            <button
              onClick={() => onCopyQuestion(msg.content)}
              title="复制问题到剪贴板"
              className="flex items-center space-x-1 px-2 py-1 rounded-md text-indigo-100/80 hover:text-white hover:bg-white/10 text-[11px] font-medium transition-colors"
            >
              <Copy className="w-3 h-3" />
              <span>复制</span>
            </button>
            <button
              onClick={() => onEditQuestion(msg.content)}
              title="回填到输入框，修改后重新发送"
              className="flex items-center space-x-1 px-2 py-1 rounded-md text-indigo-100/80 hover:text-white hover:bg-white/10 text-[11px] font-medium transition-colors"
            >
              <Pencil className="w-3 h-3" />
              <span>再次编辑</span>
            </button>
          </div>
        )}

        {/* Query Result Analysis Dashboard Block（v0.9.38：头部工具条含全屏入口，主体两态复用 renderResultBody） */}
        {msg.queryResult && (
          <div className="space-y-4 pt-2 border-t border-slate-800">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                分析结果 · 共 {msg.queryResult.totalCount} 行
              </span>
              <button
                onClick={() => setResultFull(true)}
                title="全屏查看，图表与明细数据完整呈现（Esc 退出）"
                className="flex items-center space-x-1 px-2 py-1 rounded-md bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-cyan-300 text-[11px] font-medium transition-colors"
              >
                <Maximize2 className="w-3 h-3" />
                <span>全屏</span>
              </button>
            </div>
            {renderResultBody(false)}
          </div>
        )}

        {/* 全屏叠层：完整呈现 KPI/洞察/图表/明细，Esc 或按钮退出 */}
        {resultFull && msg.queryResult && (
          <div className="fixed inset-0 z-50 bg-slate-950 overflow-y-auto">
            <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm font-bold text-slate-100 truncate" title={msg.question || undefined}>
                {msg.question || '分析结果'}
              </div>
              <button
                onClick={() => setResultFull(false)}
                title="退出全屏（Esc）"
                className="shrink-0 flex items-center space-x-1 px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                <span>退出全屏</span>
              </button>
            </div>
            <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-4">
              {renderResultBody(true)}
            </div>
          </div>
        )}

        {/* Suggested Follow-up Questions（欢迎语的追问推荐已由真实 Schema pills 取代，跳过渲染） */}
        {!msg.id.startsWith('welcome-') && msg.suggestedQuestions && msg.suggestedQuestions.length > 0 && (
          <div className="pt-2 border-t border-slate-800/60 space-y-1.5">
            <div className="text-[11px] text-slate-400 flex items-center space-x-1">
              <Sparkles className="w-3 h-3 text-cyan-400" />
              <span>推荐后续追问方向:</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {msg.suggestedQuestions.map((sq, idx) => (
                <button
                  key={idx}
                  onClick={() => onSendQuery(sq)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-indigo-300 hover:text-indigo-200 border border-slate-700/80 text-xs text-left transition-colors"
                >
                  {sq}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

};
