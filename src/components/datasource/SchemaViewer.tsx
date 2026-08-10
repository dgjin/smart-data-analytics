import React from 'react';
import { TableSchema } from '../../types/analytics';
import {
  Table as TableIcon,
  Columns,
  Hash,
  Calendar,
  Tag,
  Key,
  Layers,
  Sparkles,
} from 'lucide-react';

interface SchemaViewerProps {
  table: TableSchema;
}

export const SchemaViewer: React.FC<SchemaViewerProps> = ({ table }) => {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm">
      {/* Table Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <TableIcon className="w-4 h-4 text-indigo-400" />
            <h3 className="font-bold text-slate-100 text-sm">{table.displayName}</h3>
            <span className="font-mono text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
              {table.name}
            </span>
          </div>
          <p className="text-xs text-slate-400">{table.description}</p>
        </div>

        <div className="flex items-center space-x-2 text-xs font-mono text-slate-300 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 shrink-0">
          <Layers className="w-3.5 h-3.5 text-cyan-400" />
          <span>总记录行数: {table.rowCount.toLocaleString()} 行</span>
        </div>
      </div>

      {/* Columns Table */}
      <div className="overflow-x-auto border border-slate-800 rounded-xl">
        <table className="w-full text-left text-xs text-slate-300 divide-y divide-slate-800">
          <thead className="bg-slate-950 text-slate-400 font-semibold uppercase text-[11px]">
            <tr>
              <th className="px-3.5 py-2.5">列名 (Column)</th>
              <th className="px-3.5 py-2.5">数据类型</th>
              <th className="px-3.5 py-2.5">业务属性 (Tag)</th>
              <th className="px-3.5 py-2.5">含义描述</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
            {table.columns.map((col, idx) => {
              const getTypeIcon = () => {
                switch (col.type) {
                  case 'number':
                    return <Hash className="w-3.5 h-3.5 text-indigo-400" />;
                  case 'date':
                    return <Calendar className="w-3.5 h-3.5 text-cyan-400" />;
                  case 'category':
                    return <Tag className="w-3.5 h-3.5 text-emerald-400" />;
                  default:
                    return <Columns className="w-3.5 h-3.5 text-amber-400" />;
                }
              };

              return (
                <tr key={idx} className="hover:bg-slate-800/50 transition-colors">
                  <td className="px-3.5 py-2.5 font-mono text-indigo-300 font-medium flex items-center space-x-1.5">
                    {col.isPrimaryKey && <Key className="w-3 h-3 text-amber-400 shrink-0" />}
                    <span>{col.name}</span>
                  </td>

                  <td className="px-3.5 py-2.5">
                    <span className="flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 w-fit">
                      {getTypeIcon()}
                      <span>{col.type}</span>
                    </span>
                  </td>

                  <td className="px-3.5 py-2.5">
                    {col.isMetric ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        数值指标 (Metric)
                      </span>
                    ) : col.isDimension ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                        分组维度 (Dimension)
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[10px]">通用属性</span>
                    )}
                  </td>

                  <td className="px-3.5 py-2.5 text-slate-400">{col.description || '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
