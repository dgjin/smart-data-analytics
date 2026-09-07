// P0-1 拆分：v0.4.14 关联表配置（可选多表 JOIN；v0.4.15 JOIN 条件下拉化：主表字段/关联表字段）
// ——未选择主表时整区隐藏
import React from 'react';
import { Database, Trash2 } from 'lucide-react';
import { TableSchema } from '../../types/analytics';
import { FlexJoin } from '../../utils/flexQueryBuilder';

export interface JoinConfigPanelProps {
  /** 主表 Schema（未选表时整区隐藏） */
  tableSchema: TableSchema | undefined;
  joins: FlexJoin[];
  onChange: (joins: FlexJoin[]) => void;
  /** 全部表（关联表下拉排除主表） */
  tables: TableSchema[];
  selectedTable: string;
}

export const JoinConfigPanel: React.FC<JoinConfigPanelProps> = ({
  tableSchema,
  joins,
  onChange,
  tables,
  selectedTable,
}) => {
  if (!tableSchema) return null;
  return (
    <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-slate-400 uppercase flex items-center space-x-1">
          <Database className="w-3 h-3 text-cyan-400" />
          <span>关联表（可选）</span>
        </span>
        <button
          onClick={() => onChange([...joins, { table: '', type: 'INNER', on: { left: '', right: '' } }])}
          className="text-[10px] px-2 py-0.5 rounded bg-indigo-600/40 text-indigo-200 hover:bg-indigo-600/60 transition-colors"
        >
          + 添加关联
        </button>
      </div>
      {joins.length > 0 && (
        <div className="space-y-1.5">
          {joins.map((j, idx) => (
            <div key={idx} className="flex items-center space-x-1.5 text-[10px] bg-slate-900/60 rounded-lg p-1.5">
              <select
                value={j.table}
                onChange={(e) => {
                  const next = [...joins];
                  next[idx] = { ...j, table: e.target.value };
                  onChange(next);
                }}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200"
              >
                <option value="">选表…</option>
                {tables.filter((t) => t.name !== selectedTable).map((t) => (
                  <option key={t.id} value={t.name}>{t.displayName || t.name}</option>
                ))}
              </select>
              <select
                value={j.type}
                onChange={(e) => {
                  const next = [...joins];
                  next[idx] = { ...j, type: e.target.value as 'INNER' | 'LEFT' };
                  onChange(next);
                }}
                className="bg-slate-800 border border-slate-700 rounded px-1 py-1 text-slate-200"
              >
                <option value="INNER">INNER</option>
                <option value="LEFT">LEFT</option>
              </select>
              {/* v0.4.15：JOIN 条件下拉化（主表字段/关联表字段） */}
              <select
                value={j.on.left}
                onChange={(e) => {
                  const next = [...joins];
                  next[idx] = { ...j, on: { ...j.on, left: e.target.value } };
                  onChange(next);
                }}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200"
              >
                <option value="">主表字段…</option>
                {tableSchema?.columns.map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              <span className="text-slate-500">=</span>
              <select
                value={j.on.right}
                onChange={(e) => {
                  const next = [...joins];
                  next[idx] = { ...j, on: { ...j.on, right: e.target.value } };
                  onChange(next);
                }}
                disabled={!j.table}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 disabled:opacity-50"
              >
                <option value="">关联表字段…</option>
                {j.table && tables.find((t) => t.name === j.table)?.columns.map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              <button
                onClick={() => onChange(joins.filter((_, i) => i !== idx))}
                className="p-1 text-rose-400 hover:text-rose-300"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>

  );
};
