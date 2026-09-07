// P0-1 拆分：v0.4.13 固定报表与最近查询历史并排面板（全宽时左右两列；v0.9.24 起服务端持久化）
import React from 'react';
import { Bookmark, History, Pin, Trash2 } from 'lucide-react';
import { ChartType } from '../../types/analytics';
import { FlexQueryConfig } from '../../utils/flexQueryBuilder';

/** 已保存的固定报表（灵活查询定义），v0.9.24 起服务端 flex_queries 表持久化 */
export interface SavedFlexQuery {
  id: string;
  name: string;
  dataSourceId: string;
  config: FlexQueryConfig;
  chartType: ChartType;
  createdAt: string;
}

/** 最近执行查询历史，v0.9.24 起服务端 flex_query_history 表持久化（仅本人可见） */
export interface FlexHistoryItem {
  id: string;
  name: string;
  dataSourceId: string;
  config: FlexQueryConfig;
  chartType: ChartType;
  ranAt: string;
}

export interface FlexQueryLibraryProps {
  savedQueries: SavedFlexQuery[];
  history: FlexHistoryItem[];
  onLoadSaved: (item: SavedFlexQuery) => void;
  onDeleteSaved: (id: string) => void;
  /** 「前往决策数据看板查看固化图表」 */
  onGoDashboard: () => void;
  onClearHistory: () => void;
  onRestoreHistory: (item: FlexHistoryItem) => void;
}

export const FlexQueryLibrary: React.FC<FlexQueryLibraryProps> = ({
  savedQueries,
  history,
  onLoadSaved,
  onDeleteSaved,
  onGoDashboard,
  onClearHistory,
  onRestoreHistory,
}) => {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
    {/* 已保存固定报表 */}
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5 shadow-lg">
      <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
        <Bookmark className="w-3.5 h-3.5 text-indigo-400" />
        <span>我的固定报表（{savedQueries.length}）</span>
      </span>
      {savedQueries.length === 0 ? (
        <p className="text-[11px] text-slate-500 py-3 text-center">
          暂无保存的报表。配置查询后点击「保存为固定报表」，下次一键载入执行。
        </p>
      ) : (
        <div className="space-y-1.5">
          {savedQueries.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs text-slate-200 font-semibold truncate">{item.name}</p>
                <p className="text-[10px] text-slate-500">
                  {item.config.table} · {item.createdAt}
                </p>
              </div>
              <div className="flex items-center space-x-1.5 shrink-0">
                <button
                  onClick={() => onLoadSaved(item)}
                  className="text-[10px] px-2 py-1 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/50"
                >
                  载入
                </button>
                <button
                  onClick={() => onDeleteSaved(item.id)}
                  className="p-1 text-slate-500 hover:text-rose-400"
                  title="删除该固定报表"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {savedQueries.length > 0 && (
        <button
          onClick={onGoDashboard}
          className="w-full text-[10px] text-slate-400 hover:text-slate-200 flex items-center justify-center space-x-1"
        >
          <Pin className="w-3 h-3" />
          <span>前往决策数据看板查看固化图表</span>
        </button>
      )}
    </div>

    {/* 最近查询历史（v0.4.10，参照 Agile Query 查询历史） */}
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
          <History className="w-3.5 h-3.5 text-indigo-400" />
          <span>最近查询历史（{history.length}）</span>
        </span>
        {history.length > 0 && (
          <button onClick={onClearHistory} className="text-[10px] text-slate-500 hover:text-rose-400">
            清空
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <p className="text-[11px] text-slate-500 py-2 text-center">
          执行成功的查询会自动记录在此，点击还原配置后可重新执行。
        </p>
      ) : (
        <div className="space-y-1.5">
          {history.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-1.5"
            >
              <div className="min-w-0">
                <p className="text-[11px] text-slate-200 truncate">{h.name}</p>
                <p className="text-[10px] text-slate-500">{h.config.table} · {h.ranAt}</p>
              </div>
              <button
                onClick={() => onRestoreHistory(h)}
                className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:border-indigo-500"
              >
                还原
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
    </div>

  );
};
