// P0-1 拆分：问数输入框上方的模式选项行——M2 计划模式 / P1-7 Agent 编排 / M3 深度分析 /
// v0.5.0 报告模式（含模板选择）/ 金额单位 / 模型自选；AI 开关关闭时整行隐藏
import React from 'react';
import { Bot, Cpu, Database, FileText, ListChecks } from 'lucide-react';
import { ReportTemplate } from '../../types/analytics';
import { ModelOption } from '../../hooks/useModelCatalog';
import { AmountUnitSelect } from '../common/AmountUnitSelect';

export interface QueryModeBarProps {
  /** L7 AI 开关：数据源被停用时整行隐藏 */
  aiSwitchOff: boolean;
  /** 计划/深度/报告模式仅数据库型数据源可用（与服务端 canPlan 判定一致） */
  canPlanMode: boolean;
  planMode: boolean;
  onTogglePlanMode: () => void;
  /** P1-7 Agent 编排：多能力计划（问数→预测→归因），批准后逐步执行 */
  agentMode: boolean;
  onToggleAgentMode: () => void;
  deepMode: boolean;
  onToggleDeepMode: () => void;
  reportMode: boolean;
  onToggleReportMode: () => void;
  reportTemplates: ReportTemplate[];
  selectedTemplateId: number | null;
  onSelectTemplate: (id: number | null) => void;
  isQueryLoading: boolean;
  /** 模型目录由服务端按实际部署给出 */
  modelCatalog: ModelOption[];
  selectedModel: string;
  onSelectModel: (value: string) => void;
}

export const QueryModeBar: React.FC<QueryModeBarProps> = ({
  aiSwitchOff,
  canPlanMode,
  planMode,
  onTogglePlanMode,
  agentMode,
  onToggleAgentMode,
  deepMode,
  onToggleDeepMode,
  reportMode,
  onToggleReportMode,
  reportTemplates,
  selectedTemplateId,
  onSelectTemplate,
  isQueryLoading,
  modelCatalog,
  selectedModel,
  onSelectModel,
}) => {
  if (aiSwitchOff) return null;
  return (
    <div className="mb-2 flex items-center space-x-1.5 overflow-x-auto pb-0.5">
      {/* M2 计划模式：先制定分析计划，批准后执行（持久化，仅数据库型数据源展示） */}
      {canPlanMode && (
        <button
          type="button"
          onClick={onTogglePlanMode}
          title={planMode ? '已开启：提问后先制定分析计划，确认后执行' : '已关闭：提问后直接执行查询'}
          className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
            planMode
              ? 'bg-violet-950/60 border-violet-500 text-violet-300'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-violet-500/60 hover:text-violet-300'
          }`}
        >
          <ListChecks className="w-3 h-3" />
          <span>{planMode ? '先制定计划：开' : '先制定计划：关'}</span>
        </button>
      )}

      {/* P1-7 Agent 编排：提问后先规划多能力步骤（问数→时序预测→多维归因），确认后逐步执行（与计划模式互斥） */}
      {canPlanMode && (
        <button
          type="button"
          onClick={onToggleAgentMode}
          title={agentMode ? '已开启：提问后先规划编排步骤，确认后逐步执行取数与统计' : '已关闭：提问后按所选模式直接执行'}
          className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
            agentMode
              ? 'bg-fuchsia-950/60 border-fuchsia-500 text-fuchsia-300'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-fuchsia-500/60 hover:text-fuchsia-300'
          }`}
        >
          <Bot className="w-3 h-3" />
          <span>{agentMode ? 'Agent 编排：开' : 'Agent 编排：关'}</span>
        </button>
      )}

      {/* M3 深度分析：强制启用中间表清洗链（关闭时服务端复杂度评估自动判定） */}
      {canPlanMode && (
        <button
          type="button"
          onClick={onToggleDeepMode}
          title={deepMode ? '已开启：强制通过中间表清洗链完成复杂分析' : '已关闭：由系统自动判断是否需要中间表清洗'}
          className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
            deepMode
              ? 'bg-cyan-950/60 border-cyan-500 text-cyan-300'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-cyan-500/60 hover:text-cyan-300'
          }`}
        >
          <Database className="w-3 h-3" />
          <span>{deepMode ? '深度分析：开' : '深度分析：关'}</span>
        </button>
      )}

      {/* v0.5.0 报告模式：开启后提问直接生成完整报告（支持模板选择或智能推断） */}
      {canPlanMode && (
        <button
          type="button"
          onClick={onToggleReportMode}
          title={reportMode ? '已开启：提问后直接生成完整分析报告' : '已关闭：提问后返回单条分析结果'}
          className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
            reportMode
              ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-emerald-500/60 hover:text-emerald-300'
          }`}
        >
          <FileText className="w-3 h-3" />
          <span>{reportMode ? '报告模式：开' : '报告模式：关'}</span>
        </button>
      )}

      {/* 报告模式模板选择：开启后显示 */}
      {reportMode && reportTemplates.length > 0 && (
        <span className="shrink-0 flex items-center space-x-1 pl-2 border-l border-slate-800">
          <FileText className="w-3 h-3 text-emerald-400" />
          <select
            value={selectedTemplateId ?? ''}
            onChange={(e) => onSelectTemplate(e.target.value ? Number(e.target.value) : null)}
            disabled={isQueryLoading}
            title="选择报告模板：选中后按模板结构生成报告；留空则根据提问智能推断"
            className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-emerald-500 cursor-pointer disabled:opacity-50"
          >
            <option value="">智能推断</option>
            {reportTemplates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}{tpl.isPreset ? '（预设）' : ''}
              </option>
            ))}
          </select>
        </span>
      )}

      {/* 金额单位：默认跟随全局，可单独选择本模块口径（优先于全局设置） */}
      <AmountUnitSelect module="query" disabled={isQueryLoading} className="ml-auto pl-2 border-l border-slate-800" />

      {/* 模型自选：目录由服务端按实际部署给出，选择随提问生效并持久化 */}
      {modelCatalog.length > 0 && (
        <span className="shrink-0 flex items-center space-x-1 pl-2 border-l border-slate-800">
          <Cpu className="w-3 h-3 text-violet-400" />
          <select
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
            disabled={isQueryLoading}
            title="选择本次问数使用的 AI 模型"
            className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-violet-500 cursor-pointer disabled:opacity-50 max-w-[180px]"
          >
            <option value="">
              默认模型{modelCatalog.find((m) => m.isDefault) ? `（${modelCatalog.find((m) => m.isDefault)!.label}）` : ''}
            </option>
            {modelCatalog.map((m) => (
              <option key={`${m.engine}::${m.model}`} value={`${m.engine}::${m.model}`}>
                {m.label}
              </option>
            ))}
          </select>
        </span>
      )}
    </div>

  );
};
