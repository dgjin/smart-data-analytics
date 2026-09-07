// P0-1 拆分：单条对话消息卡片（用户提问 / 助手回答）——从 QueryChat.tsx 抽出的纯展示组件，
// 涵盖反馈点赞、数据来源徽标、语义缓存、DLP 提示、歧义澄清、M2 计划卡片、报告卡片、
// KPI/图表/明细表结果区与推荐追问；一切状态变更通过回调 props 回传父组件
import React from 'react';
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
  Pencil,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
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
  onInspectSql: (result: QueryResultData) => void;
  onFeedback: (msg: ChatMessage, verdict: 'UP' | 'DOWN') => void;
  onSendQuery: (queryText?: string, approvedPlanId?: string, options?: { refreshCache?: boolean }) => void;
  onCopyQuestion: (content: string) => void;
  onEditQuestion: (content: string) => void;
  onSelectClarification: (msg: ChatMessage, query: string) => void;
  onApprovePlan: (msg: ChatMessage) => void;
  onEditPlanQuestion: (msg: ChatMessage) => void;
  onDismissPlan: (msgId: string) => void;
  onUpdateChartConfig: (msgId: string, config: ChartConfig) => void;
  onPinChart: (msg: ChatMessage) => void;
  onOpenReport: (reportId: string) => void;
}

export const ChatMessageItem: React.FC<ChatMessageItemProps> = ({
  msg,
  welcomeContent,
  isQueryLoading,
  clarificationResolved,
  planResolved,
  onInspectSql,
  onFeedback,
  onSendQuery,
  onCopyQuestion,
  onEditQuestion,
  onSelectClarification,
  onApprovePlan,
  onEditPlanQuestion,
  onDismissPlan,
  onUpdateChartConfig,
  onPinChart,
  onOpenReport,
}) => {
  const isUser = msg.role === 'user';

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

        {/* M1 推导回放：按需拉取本次问数的全链路步骤时间线 */}
        {!isUser && msg.traceId && <TraceReplay traceId={msg.traceId} />}

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

        {/* Query Result Analysis Dashboard Block */}
        {msg.queryResult && (
          <div className="space-y-4 pt-2 border-t border-slate-800">
            {/* KPI Cards */}
            {msg.queryResult.kpiMetrics && (
              <KPIStats metrics={msg.queryResult.kpiMetrics} />
            )}

            {/* AI Key Insights Box */}
            {msg.queryResult.keyInsights && msg.queryResult.keyInsights.length > 0 && (
              <div className="p-3.5 bg-indigo-950/40 border border-indigo-500/30 rounded-2xl space-y-2">
                <div className="flex items-center space-x-1.5 font-bold text-indigo-300 text-xs">
                  <Lightbulb className="w-4 h-4 text-amber-400" />
                  <span>AI 归因分析与决策提示:</span>
                </div>
                <ul className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-slate-200">
                  {msg.queryResult.keyInsights.map((insight, idx) => (
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
            {msg.queryResult.chartConfig && (
              <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <BarChart3 className="w-4 h-4 text-cyan-400" />
                    <h4 className="font-bold text-slate-100 text-sm">
                      {msg.queryResult.chartConfig.title}
                    </h4>
                  </div>
                </div>

                {/* Chart Customizer Toolbar */}
                <ChartCustomizer
                  config={msg.queryResult.chartConfig}
                  onChange={(newConfig) => onUpdateChartConfig(msg.id, newConfig)}
                  onPinToDashboard={() => onPinChart(msg)}
                />

                {/* Render Chart */}
                <DynamicChart
                  config={msg.queryResult.chartConfig}
                  data={msg.queryResult.rows}
                />
              </div>
            )}

            {/* Data Table */}
            {msg.queryResult.rows && (
              <DataTable
                data={msg.queryResult.rows}
                columnNames={msg.queryResult.columnNames}
                title="明细数据集"
              />
            )}
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
