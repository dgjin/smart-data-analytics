/**
 * P2-2 报表图表点击下钻弹层：展示维度明细数据表。
 */
import React, { useState, useEffect } from 'react';
import { X, Loader2, Database } from 'lucide-react';
import { apiFetch } from '../../api/client';

interface DrillModalProps {
  open: boolean;
  onClose: () => void;
  dataSourceId: string;
  originalSql: string;
  dimensionKey: string;
  dimensionValue: string | number;
  dimensionLabel?: string;
}

export const DrillModal: React.FC<DrillModalProps> = ({
  open,
  onClose,
  dataSourceId,
  originalSql,
  dimensionKey,
  dimensionValue,
  dimensionLabel,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [columnNames, setColumnNames] = useState<Record<string, string>>({});
  const [finalSql, setFinalSql] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setRows([]);
    setColumns([]);
    setColumnNames({});
    setFinalSql('');

    apiFetch('/api/query/drill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataSourceId, originalSql, dimensionKey, dimensionValue }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || '下钻查询失败');
        }
        const list = data.rows || [];
        setRows(list);
        setFinalSql(data.finalSql || '');
        if (data.columnNames && typeof data.columnNames === 'object') {
          setColumnNames(data.columnNames);
        }
        if (list.length > 0) {
          setColumns(Object.keys(list[0]));
        }
      })
      .catch((err) => setError(err?.message || '网络异常'))
      .finally(() => setLoading(false));
  }, [open, dataSourceId, originalSql, dimensionKey, dimensionValue]);

  if (!open) return null;

  const label = dimensionLabel || String(dimensionValue);

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-5xl w-full max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center space-x-2">
            <Database className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-bold text-slate-100">
              下钻明细：{label}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              {dimensionKey} = {String(dimensionValue)}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12 space-x-2 text-slate-400 text-xs">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>正在执行下钻查询...</span>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs">
              {error}
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="text-center text-slate-500 text-xs py-12">暂无明细数据</div>
          )}

          {rows.length > 0 && (
            <div className="overflow-auto rounded-xl border border-slate-800">
              <table className="w-full text-[11px] text-left">
                <thead className="bg-slate-950 text-slate-300 sticky top-0">
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c}
                        title={columnNames[c] ? c : undefined}
                        className="px-3 py-2 font-semibold border-b border-slate-800 whitespace-nowrap"
                      >
                        {columnNames[c] || c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {rows.map((row, ri) => (
                    <tr key={ri} className="hover:bg-slate-800/50 transition-colors">
                      {columns.map((c) => (
                        <td key={c} className="px-3 py-2 text-slate-300 whitespace-nowrap">
                          {row[c] === null || row[c] === undefined ? (
                            <span className="text-slate-600">-</span>
                          ) : typeof row[c] === 'number' ? (
                            row[c].toLocaleString()
                          ) : (
                            String(row[c])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {finalSql && (
            <div className="text-[10px] text-slate-500 font-mono bg-slate-950 p-2 rounded-lg border border-slate-800 overflow-x-auto">
              {finalSql}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
