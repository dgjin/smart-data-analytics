import React from 'react';
import { History, Download, Trash2 } from 'lucide-react';

/** 问数上下文摘要（与服务端 /api/query/context 下发结构对齐） */
export interface QueryContextSummary {
  status: string | null;
  dsType: string | null;
  /** v0.9.34 文件数据源已落应用库物理表（服务端摘要下发），真实执行入口判定与库型源对齐 */
  fileBacked?: boolean;
  tableCount: number;
  tables: { name: string; displayName: string }[];
  sensitiveFiltered: number;
  maxTablesInPrompt: number;
  /** v0.9.65 组织数据范围：当前用户档位的人类可读描述（未配置范围时不下发，为 null） */
  dataScope?: string | null;
  /** 数据范围是否已在本数据源生效（服务端已生成行级谓词）；false 表示数据源未配置组织隔离列 */
  dataScopeApplied?: boolean;
}

interface ChatTopBarProps {
  aiSwitchOff: boolean;
  activeDSName: string | undefined;
  queryContext: QueryContextSummary | null;
  isAdmin: boolean;
  historyOpen: boolean;
  onExportConversation: () => void;
  onToggleHistoryPanel: () => void;
  onClearChat: () => void;
}

/**
 * 问数顶部状态条（P0 上帝组件拆分：自 QueryChat 提取的纯展示组件）。
 * 含当前数据源上下文、问数范围徽标（scope 白名单 + 敏感列过滤后）、
 * 管理员表名清单悬停、导出/历史/重置操作按钮。
 */
export const ChatTopBar: React.FC<ChatTopBarProps> = ({
  aiSwitchOff,
  activeDSName,
  queryContext,
  isAdmin,
  historyOpen,
  onExportConversation,
  onToggleHistoryPanel,
  onClearChat,
}) => {
  return (
    <div className="px-6 py-2.5 bg-slate-900/60 border-b border-slate-800/80 flex items-center justify-between text-xs shrink-0">
      <div className="flex items-center space-x-2">
        <span className={`w-2 h-2 rounded-full ${aiSwitchOff ? 'bg-rose-400' : 'bg-emerald-400 animate-ping'}`} />
        <span className="text-slate-300 font-medium">
          当前智能问答数据上下文: <strong className="text-indigo-300">{activeDSName}</strong>
        </span>
        {aiSwitchOff && (
          <span className="px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-500/40 text-rose-300 text-[10px] font-semibold">
            问数已停用
          </span>
        )}
        {/* 问数表范围：以服务端上下文摘要（scope 白名单 + 敏感列过滤后）为单一事实源，
            与实际参与问数的范围保持一致；未落库数据源（演示模式）无服务端范围 */}
        {queryContext && queryContext.status !== null && (
          queryContext.tableCount > 0 ? (
            <span
              className="px-1.5 py-0.5 rounded bg-indigo-950/40 border border-indigo-500/30 text-indigo-300 text-[10px] font-semibold"
              title={
                isAdmin && queryContext.tables.length > 0
                  ? `实际参与问数的数据表（已按问数范围与敏感策略过滤）:\n${queryContext.tables.map((t) => `- ${t.displayName} (${t.name})`).join('\n')}`
                  : '实际参与问数的数据表数量（已按问数范围与敏感策略过滤）'
              }
            >
              问数范围 {queryContext.tableCount} 张表
              {queryContext.tableCount > queryContext.maxTablesInPrompt && '（提问时自动圈选最相关表）'}
            </span>
          ) : (
            <span
              className="px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-500/40 text-rose-300 text-[10px] font-semibold"
              title="请管理员在「数据源管理 → 问数范围配置」中勾选允许问数的数据表"
            >
              问数范围为空
            </span>
          )
        )}
        {/* v0.9.65 组织数据范围：用户档位（本机构/本项目团队/仅本人）对应的行级隔离说明，
            与执行层 AST 注入的谓词同源；数据源未配置组织隔离列时以告警色提示未生效 */}
        {queryContext && queryContext.status !== null && queryContext.dataScope && (
          <span
            className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
              queryContext.dataScopeApplied
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                : 'bg-amber-950/40 border-amber-500/30 text-amber-300'
            }`}
            title={
              queryContext.dataScopeApplied
                ? `行级数据范围已生效：${queryContext.dataScope}（执行层已自动对相关表注入机构/团队过滤，无法查看范围外数据）`
                : `数据范围「${queryContext.dataScope}」在当前数据源未生效：该数据源尚未配置组织隔离列，请联系管理员在「数据源管理 → 组织隔离」中配置`
            }
          >
            数据范围 {queryContext.dataScope}
            {queryContext.dataScopeApplied ? '' : '（未生效）'}
          </span>
        )}
        {/* 管理员可悬停查看实际参与问数的表名清单（来自服务端上下文摘要） */}
        {isAdmin && queryContext && queryContext.tables.length > 0 && (
          <span className="text-slate-500 font-mono truncate max-w-[420px]" title={queryContext.tables.map((t) => t.name).join(', ')}>
            ({queryContext.tables.map((t) => t.displayName || t.name).join(', ')})
          </span>
        )}
      </div>

      <div className="flex items-center space-x-3">
        <button
          onClick={onExportConversation}
          className="flex items-center space-x-1 text-slate-400 hover:text-indigo-400 transition-colors"
          title="将当前数据源的对话导出为 Markdown 文件"
        >
          <Download className="w-3.5 h-3.5" />
          <span>导出</span>
        </button>
        <button
          onClick={onToggleHistoryPanel}
          className={`flex items-center space-x-1 transition-colors ${historyOpen ? 'text-indigo-400' : 'text-slate-400 hover:text-indigo-400'}`}
          title="查看服务端落库的对话历史（搜索 / 重问 / 删除，跨设备共享）"
        >
          <History className="w-3.5 h-3.5" />
          <span>历史对话</span>
        </button>
        <button
          onClick={onClearChat}
          className="flex items-center space-x-1 text-slate-400 hover:text-rose-400 transition-colors"
          title="清空当前数据源的对话记录（不影响其他数据源）"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>重置对话</span>
        </button>
      </div>
    </div>
  );
};
