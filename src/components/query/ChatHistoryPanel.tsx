/**
 * P1-6 QueryChat 拆分：对话历史面板（服务端落库）——关键词搜索 / 一键重问 / 单条删除。
 * 纯展示组件，数据与操作由 useConversationHistory 提供。
 */
import React from 'react';
import { History, Search, RefreshCw, Trash2 } from 'lucide-react';
import { ConversationItem } from '../../hooks/useConversationHistory';

interface ChatHistoryPanelProps {
  items: ConversationItem[];
  loading: boolean;
  keyword: string;
  onKeywordChange: (kw: string) => void;
  onSearch: (kw: string) => void;
  onClose: () => void;
  /** 回填输入框重新提问 */
  onReuse: (question: string) => void;
  onDelete: (id: number) => void;
}

export const ChatHistoryPanel: React.FC<ChatHistoryPanelProps> = ({
  items,
  loading,
  keyword,
  onKeywordChange,
  onSearch,
  onClose,
  onReuse,
  onDelete,
}) => {
  return (
    <div className="mx-4 md:mx-6 mt-3 rounded-2xl border border-indigo-500/30 bg-slate-900/80 shadow-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
        <span className="text-xs font-bold text-indigo-300 flex items-center space-x-1.5">
          <History className="w-3.5 h-3.5" />
          <span>历史对话（服务端落库，跨设备共享，成功问答自动沉淀为个人经验）</span>
        </span>
        <div className="flex items-center space-x-2">
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={keyword}
              onChange={(e) => onKeywordChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSearch(keyword);
              }}
              placeholder="搜索问题 / 结论，回车检索"
              className="pl-6 pr-2 py-1 text-[11px] rounded-lg bg-slate-800 border border-slate-700 text-slate-200 focus:outline-none focus:border-indigo-500 w-48"
            />
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xs transition-colors">
            关闭
          </button>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/60">
        {loading ? (
          <div className="px-4 py-6 text-center text-xs text-slate-500">加载中…</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-slate-500">该数据源暂无对话历史（问数完成后自动落库）</div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="px-4 py-2.5 hover:bg-slate-800/40 transition-colors group">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center space-x-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border shrink-0 ${
                        item.status === 'SUCCESS'
                          ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                          : 'bg-amber-950/60 border-amber-500/40 text-amber-300'
                      }`}
                    >
                      {item.status === 'SUCCESS' ? '成功' : '降级'}
                    </span>
                    {item.provenance === 'simulated' && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold border bg-slate-800 border-slate-700 text-slate-400 shrink-0">演示</span>
                    )}
                    <span className="text-[10px] text-slate-500 shrink-0">
                      {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''}
                    </span>
                  </div>
                  <p className="text-xs text-slate-200 mt-1 truncate" title={item.question}>
                    {item.question}
                  </p>
                  {item.answerSummary && (
                    <p className="text-[11px] text-slate-500 mt-0.5 truncate" title={item.answerSummary}>
                      {item.answerSummary}
                    </p>
                  )}
                </div>
                <div className="flex items-center space-x-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => onReuse(item.question)}
                    title="回填输入框重新提问"
                    className="p-1.5 rounded-lg text-indigo-400 hover:bg-indigo-950/60 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDelete(item.id)}
                    title="删除该条对话记录"
                    className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-950/60 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
