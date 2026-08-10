import React, { useState } from 'react';
import { ListChecks, ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { ColumnSchema, DataSource, TableSchema } from '../../types/analytics';

type ColRole = 'metric' | 'dimension' | 'none';

interface ColMeta {
  role: ColRole;
  description: string;
}

interface SchemaMetaEditorProps {
  ds: DataSource;
  onClose: () => void;
  onSaved: (ds: DataSource, touched: number) => void;
  onError: (msg: string) => void;
}

const ROLE_OPTIONS: { value: ColRole; label: string; className: string }[] = [
  { value: 'metric', label: '指标', className: 'text-cyan-300' },
  { value: 'dimension', label: '维度', className: 'text-indigo-300' },
  { value: 'none', label: '不参与', className: 'text-slate-500' },
];

function initialRole(c: ColumnSchema): ColRole {
  if (c.isMetric) return 'metric';
  if (c.isDimension) return 'dimension';
  return 'none';
}

/**
 * 指标/维度维护弹窗：展示导入时自动推导的列角色，管理员可逐列调整并修正描述，
 * 保存后即时生效于智能问数与报告生成的 Schema 上下文。
 */
export const SchemaMetaEditor: React.FC<SchemaMetaEditorProps> = ({ ds, onClose, onSaved, onError }) => {
  const [meta, setMeta] = useState<Record<string, Record<string, ColMeta>>>(() => {
    const init: Record<string, Record<string, ColMeta>> = {};
    for (const t of ds.tables) {
      init[t.id] = {};
      for (const c of t.columns) {
        init[t.id][c.name] = { role: initialRole(c), description: c.description || '' };
      }
    }
    return init;
  });
  const [expanded, setExpanded] = useState<string | null>(ds.tables[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  // 表级业务口径说明（P2）：随 schema-meta 保存，注入 AI 问数/报表 prompt
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const t of ds.tables) {
      init[t.id] = t.businessNote || '';
    }
    return init;
  });

  // 问数范围内的表排在前面并加徽标，便于管理员聚焦会进入 AI 上下文的表
  const scopedIds = new Set(ds.scope?.tables?.length ? ds.scope.tables : ds.tables.map((t) => t.id));
  const orderedTables = [...ds.tables].sort(
    (a, b) => Number(scopedIds.has(b.id)) - Number(scopedIds.has(a.id))
  );

  const setRole = (tableId: string, colName: string, role: ColRole) => {
    setMeta((prev) => ({
      ...prev,
      [tableId]: { ...prev[tableId], [colName]: { ...prev[tableId][colName], role } },
    }));
  };

  const setDescription = (tableId: string, colName: string, description: string) => {
    setMeta((prev) => ({
      ...prev,
      [tableId]: { ...prev[tableId], [colName]: { ...prev[tableId][colName], description } },
    }));
  };

  const countRole = (t: TableSchema, role: ColRole) =>
    t.columns.filter((c) => meta[t.id]?.[c.name]?.role === role).length;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const payload = {
        tables: ds.tables.map((t) => ({
          id: t.id,
          businessNote: notes[t.id] ?? '',
          columns: t.columns.map((c) => {
            const m = meta[t.id][c.name];
            return {
              name: c.name,
              isMetric: m.role === 'metric',
              isDimension: m.role === 'dimension',
              description: m.description,
            };
          }),
        })),
      };
      const res = await apiFetch(`/api/datasources/${ds.id}/schema-meta`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '保存失败');
      onSaved(data.dataSource as DataSource, data.touched ?? 0);
    } catch (err: any) {
      onError(err.message || '指标维度维护保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-slate-900 border border-cyan-500/40 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="space-y-0.5">
            <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
              <ListChecks className="w-4 h-4 text-cyan-400" />
              <span>指标与维度维护：{ds.name}</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              列角色由系统按表结构自动推导，可逐列修正。AI 问数与报告生成仅将「指标」列作为度量、「维度」列作为分组依据。
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
          {orderedTables.map((table) => {
            const inScope = scopedIds.has(table.id);
            const isOpen = expanded === table.id;
            return (
              <div
                key={table.id}
                className={`rounded-xl border transition-colors ${
                  inScope ? 'border-cyan-500/30 bg-cyan-950/10' : 'border-slate-800 bg-slate-950/50'
                }`}
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : table.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                >
                  <div className="min-w-0 flex items-center space-x-2">
                    <span className="text-xs font-semibold text-slate-200">{table.displayName}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{table.name}</span>
                    {inScope && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        问数范围内
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    <span className="text-[10px] text-cyan-300">指标 {countRole(table, 'metric')}</span>
                    <span className="text-[10px] text-indigo-300">维度 {countRole(table, 'dimension')}</span>
                    {isOpen ? (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 pt-1 border-t border-slate-800/60 space-y-1">
                    {/* 表级业务口径说明：约束 AI 生成 SQL 的计算口径 */}
                    <div className="px-2 py-1.5">
                      <input
                        type="text"
                        value={notes[table.id] ?? ''}
                        maxLength={500}
                        placeholder="业务口径说明（可选，如：复购率=90天内≥2单客户/总客户；将注入 AI 问数上下文）"
                        onChange={(e) => setNotes((prev) => ({ ...prev, [table.id]: e.target.value }))}
                        className="w-full bg-slate-950 border border-amber-500/30 rounded-lg px-2 py-1 text-[11px] text-amber-200 placeholder-slate-500 focus:outline-none focus:border-amber-400"
                      />
                    </div>
                    {table.columns.map((col) => {
                      const m = meta[table.id]?.[col.name];
                      if (!m) return null;
                      return (
                        <div
                          key={col.name}
                          className="grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1.2fr)] items-center gap-2 px-2 py-1 rounded-lg hover:bg-slate-800/40"
                        >
                          <div className="min-w-0 flex items-center space-x-1.5">
                            <span className="font-mono text-[11px] text-slate-200 truncate">{col.name}</span>
                            <span className="text-slate-500 text-[9px] shrink-0">{col.type}</span>
                            {col.isPrimaryKey && (
                              <span className="text-[9px] text-slate-500 shrink-0">PK</span>
                            )}
                          </div>
                          <select
                            value={m.role}
                            onChange={(e) => setRole(table.id, col.name, e.target.value as ColRole)}
                            className={`bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] focus:outline-none focus:border-cyan-500 cursor-pointer ${
                              ROLE_OPTIONS.find((o) => o.value === m.role)?.className || ''
                            }`}
                          >
                            {ROLE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={m.description}
                            placeholder="列业务含义（可选，帮助 AI 理解）"
                            onChange={(e) => setDescription(table.id, col.name, e.target.value)}
                            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800">
          <div className="text-[11px] text-slate-400">
            共 {ds.tables.length} 张表，调整后对智能问数与报告生成即时生效
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
            >
              {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              <span>{saving ? '保存中...' : '保存指标维度配置'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
