// P0-1 拆分：问数范围配置弹窗——勾选允许 AI 智能问数使用的数据表与字段
// （未勾选内容不进入 AI 的 Schema 上下文；ds 为 null 时不渲染）
import React from 'react';
import { ChevronDown, ChevronRight, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { DataSource, TableSchema } from '../../types/analytics';

export interface ScopeConfigModalProps {
  /** 目标数据源；null 时不渲染 */
  ds: DataSource | null;
  /** 已勾选表 id 集合 */
  scopeTables: Set<string>;
  /** 各表已勾选字段集合（tableId → 字段名集合） */
  scopeCols: Record<string, Set<string>>;
  /** 当前展开字段清单的表 id */
  expandedTableId: string | null;
  onToggleExpand: (tableId: string | null) => void;
  onToggleTable: (table: TableSchema) => void;
  onToggleColumn: (tableId: string, colName: string) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

export const ScopeConfigModal: React.FC<ScopeConfigModalProps> = ({
  ds,
  scopeTables,
  scopeCols,
  expandedTableId,
  onToggleExpand,
  onToggleTable,
  onToggleColumn,
  saving,
  onSave,
  onClose,
}) => {
  if (!ds) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-amber-500/40 rounded-2xl shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="space-y-0.5">
            <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
              <SlidersHorizontal className="w-4 h-4 text-amber-400" />
              <span>问数范围配置：{ds.name}</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              勾选允许 AI 智能问数使用的数据表与字段，未勾选内容不会进入 AI 的 Schema 上下文。
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
          {ds.tables.map((table) => {
            const tableChecked = scopeTables.has(table.id);
            const checkedCols = scopeCols[table.id] || new Set<string>();
            const expanded = expandedTableId === table.id;
            return (
              <div
                key={table.id}
                className={`rounded-xl border transition-colors ${
                  tableChecked ? 'border-amber-500/30 bg-amber-950/10' : 'border-slate-800 bg-slate-950/50'
                }`}
              >
                <div className="flex items-center space-x-2.5 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={tableChecked}
                    onChange={() => onToggleTable(table)}
                    className="w-3.5 h-3.5 accent-amber-500 cursor-pointer"
                  />
                  <button
                    onClick={() => onToggleExpand(expanded ? null : table.id)}
                    className="flex-1 flex items-center justify-between min-w-0 text-left"
                  >
                    <div className="min-w-0">
                      <span className="text-xs font-semibold text-slate-200">{table.displayName}</span>
                      <span className="ml-2 text-[10px] text-slate-500 font-mono">{table.name}</span>
                    </div>
                    <div className="flex items-center space-x-2 shrink-0">
                      <span className="text-[10px] text-slate-400">
                        字段 {tableChecked ? checkedCols.size : 0}/{table.columns.length}
                      </span>
                      {expanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                      )}
                    </div>
                  </button>
                </div>

                {expanded && (
                  <div className="px-4 pb-3 pt-1 border-t border-slate-800/60 grid grid-cols-2 md:grid-cols-3 gap-1">
                    {table.columns.map((col) => (
                      <label
                        key={col.name}
                        className={`flex items-center space-x-1.5 px-2 py-1 rounded-lg text-[11px] cursor-pointer transition-colors ${
                          !tableChecked
                            ? 'opacity-40 pointer-events-none'
                            : checkedCols.has(col.name)
                              ? 'text-slate-200 bg-amber-950/30'
                              : 'text-slate-400 hover:bg-slate-800/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={tableChecked && checkedCols.has(col.name)}
                          disabled={!tableChecked}
                          onChange={() => onToggleColumn(table.id, col.name)}
                          className="w-3 h-3 accent-amber-500"
                        />
                        <span className="font-mono truncate">{col.name}</span>
                        <span className="text-slate-500 text-[9px]">{col.type}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800">
          <div className="text-[11px] text-slate-400">
            已选 <span className="text-amber-300 font-bold">{scopeTables.size}</span> / {ds.tables.length} 张表
            {scopeTables.size === 0 && <span className="ml-2 text-rose-400">至少保留一张表</span>}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
            >
              取消
            </button>
            <button
              onClick={onSave}
              disabled={saving || scopeTables.size === 0}
              className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
            >
              {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              <span>{saving ? '保存中...' : '保存问数范围'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

  );
};
