import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, Pencil, X, Power, PowerOff, Sparkles, Tag } from 'lucide-react';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaInput } from '../ontologyUi';
import { useEscapeKey } from '../ontologyHelpers';
import { ONTOLOGY_STATUS_META, type OntologyValueNoteItem } from '../../../types/ontology';
import { callApi, type SectionProps } from './shared';

// ============ 值域释义 ============

/**
 * 批量粘贴解析（v0.9.111）：
 * 以「值=含义」为主，兼容 Excel 粘贴的制表符、中文冒号，以及仅一个逗号的行；
 * 同一个值重复出现时后者覆盖前者（与单条 upsert 的覆盖语义一致）。
 */
function parseValuePairs(text: string): {
  pairs: { valueCode: string; meaning: string }[];
  invalid: number;
  duplicates: number;
} {
  const rawPairs: { valueCode: string; meaning: string }[] = [];
  let invalid = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const candidates = [line.search(/[=＝]/), line.indexOf('\t'), line.search(/[:：]/)].filter((i) => i > 0);
    let idx = candidates.length > 0 ? Math.min(...candidates) : -1;
    if (idx < 0) {
      const first = line.indexOf(',');
      if (first > 0 && line.indexOf(',', first + 1) < 0) idx = first;
    }
    if (idx <= 0) {
      invalid += 1;
      continue;
    }
    const valueCode = line.slice(0, idx).trim();
    const meaning = line.slice(idx + 1).trim();
    if (!valueCode || !meaning) {
      invalid += 1;
      continue;
    }
    rawPairs.push({ valueCode, meaning });
  }
  const byValue = new Map<string, string>();
  for (const p of rawPairs) byValue.set(p.valueCode, p.meaning);
  return {
    pairs: [...byValue.entries()].map(([valueCode, meaning]) => ({ valueCode, meaning })),
    invalid,
    duplicates: rawPairs.length - byValue.size,
  };
}

export const ValueNoteSection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged }) => {
  const [notes, setNotes] = useState<OntologyValueNoteItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterTable, setFilterTable] = useState('');
  const [filterColumn, setFilterColumn] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ tableName: '', columnName: '', valueCode: '', meaning: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [editing, setEditing] = useState<OntologyValueNoteItem | null>(null);
  const [editMeaning, setEditMeaning] = useState('');
  const [editStatus, setEditStatus] = useState<'ACTIVE' | 'DISABLED'>('ACTIVE');

  const load = useCallback(async () => {
    if (!dataSourceId) return;
    setIsLoading(true);
    try {
      // 筛选全部在前端完成：输入不再逐字触发请求，大表也保持即时响应
      const params = new URLSearchParams({ dataSourceId });
      const data = await callApi<{ valueNotes: OntologyValueNoteItem[] }>(`/api/ontology/value-notes?${params.toString()}`);
      setNotes(data.valueNotes || []);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载值域释义失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEscapeKey(editing !== null, () => setEditing(null));

  const visibleNotes = useMemo(() => {
    const tableKey = filterTable.trim().toLowerCase();
    const columnKey = filterColumn.trim().toLowerCase();
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (tableKey && !n.tableName.toLowerCase().includes(tableKey)) return false;
      if (columnKey && !n.columnName.toLowerCase().includes(columnKey)) return false;
      if (!q) return true;
      return (
        n.valueCode.toLowerCase().includes(q) ||
        n.meaning.toLowerCase().includes(q) ||
        `${n.tableName}.${n.columnName}`.toLowerCase().includes(q)
      );
    });
  }, [notes, filterTable, filterColumn, query]);

  const bulkParsed = useMemo(() => parseValuePairs(bulkText), [bulkText]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await callApi<{ ok: boolean; id: number }>('/api/ontology/value-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId,
          tableName: form.tableName.trim(),
          columnName: form.columnName.trim(),
          valueCode: form.valueCode.trim(),
          meaning: form.meaning.trim(),
        }),
      });
      showNotice('success', `值域释义 ${form.tableName.trim()}.${form.columnName.trim()} = ${form.valueCode.trim()} → ${form.meaning.trim()} 已保存`);
      setForm({ ...form, valueCode: '', meaning: '' });
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBulk = async () => {
    if (bulkSubmitting) return;
    const tableName = form.tableName.trim();
    const columnName = form.columnName.trim();
    if (!tableName || !columnName) {
      showNotice('error', '批量粘贴前请先填写表名与列名');
      return;
    }
    if (bulkParsed.pairs.length === 0) {
      showNotice('error', '未解析到有效行，请按「值=含义」每行一条');
      return;
    }
    if (bulkParsed.pairs.length > 200) {
      showNotice('error', `单次最多批量保存 200 条（当前 ${bulkParsed.pairs.length} 条），请分批粘贴`);
      return;
    }
    setBulkSubmitting(true);
    try {
      // 单请求批量写入：服务端逐条 upsert 并返回成功/失败明细，避免逐行走网络
      const data = await callApi<{
        ok: boolean;
        saved: number;
        failed: number;
        failures?: { index: number; error: string }[];
      }>('/api/ontology/value-notes/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId, tableName, columnName, items: bulkParsed.pairs }),
      });
      if (data.failed > 0) {
        showNotice('error', `批量保存：成功 ${data.saved} 条，失败 ${data.failed} 条（${data.failures?.[0]?.error || '详见服务端日志'}）`);
      } else {
        showNotice('success', `批量保存完成：成功 ${data.saved} 条${bulkParsed.duplicates > 0 ? `，重复值已按后者覆盖 ${bulkParsed.duplicates} 条` : ''}`);
      }
      if (data.saved > 0) {
        setBulkText('');
        await load();
        onChanged();
      }
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setBulkSubmitting(false);
    }
  };

  const handleSaveMeaning = async () => {
    if (!editing) return;
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/value-notes/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meaning: editMeaning.trim(), status: editStatus }),
      });
      showNotice('success', editStatus === 'DISABLED' ? '值域含义已更新并停用（不再注入问数提示词）' : '值域含义已更新');
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  /** 行内停用/启用：只切换 status，不改变含义 */
  const handleToggleStatus = async (note: OntologyValueNoteItem) => {
    const nextStatus = note.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/value-notes/${note.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meaning: note.meaning, status: nextStatus }),
      });
      showNotice('success', `${note.tableName}.${note.columnName} = ${note.valueCode} 已${nextStatus === 'ACTIVE' ? '启用' : '停用'}`);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  const handleDelete = async (note: OntologyValueNoteItem) => {
    if (!window.confirm(`确认删除 ${note.tableName}.${note.columnName} = ${note.valueCode} 的释义？`)) return;
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/value-notes/${note.id}`, { method: 'DELETE' });
      showNotice('success', '已删除值域释义');
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Tag className="w-4 h-4 text-amber-400" />
          <span className="font-bold text-slate-300">值域释义</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索值 / 含义"
            aria-label="搜索值域释义"
            className="w-40 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-amber-500"
          />
          <input value={filterTable} onChange={(e) => setFilterTable(e.target.value)} list="ont-vn-filter-tables" placeholder="按表名筛选" aria-label="按表名筛选" className="w-36 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-amber-500" />
          <input value={filterColumn} onChange={(e) => setFilterColumn(e.target.value)} placeholder="按列名筛选" aria-label="按列名筛选" className="w-36 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-amber-500" />
          <datalist id="ont-vn-filter-tables">
            {tables.map((t) => <option key={t.name} value={t.name} />)}
          </datalist>
          <button onClick={() => void load()} disabled={isLoading} className="flex items-center space-x-1 text-slate-400 hover:text-slate-200">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /><span>刷新</span>
          </button>
          <span className="text-[10px] text-slate-500">
            共 {notes.length} 条 · 当前显示 {visibleNotes.length} 条（问数仅注入命中表相关列）
          </span>
          {(query || filterTable || filterColumn) && (
            <button onClick={() => { setQuery(''); setFilterTable(''); setFilterColumn(''); }} className="text-[10px] text-amber-300 hover:text-amber-200 underline underline-offset-2">
              清除筛选
            </button>
          )}
        </div>
        <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-5 gap-2 text-xs items-start">
          <SchemaInput
            kind="table"
            value={form.tableName}
            onChange={(v) => setForm({ ...form, tableName: v })}
            tables={tables}
            listId="ont-vn-create-tables"
            placeholder="表名，如 JGXX"
            accent="amber"
            ariaLabel="值域表名"
          />
          <SchemaInput
            kind="column"
            value={form.columnName}
            onChange={(v) => setForm({ ...form, columnName: v })}
            tables={tables}
            tableName={form.tableName}
            listId="ont-vn-create-columns"
            placeholder="列名，如 BB"
            accent="amber"
            ariaLabel="值域列名"
          />
          <input value={form.valueCode} onChange={(e) => setForm({ ...form, valueCode: e.target.value })} placeholder="值，如 1" maxLength={100} aria-label="值编码" className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-amber-500" />
          <input value={form.meaning} onChange={(e) => setForm({ ...form, meaning: e.target.value })} placeholder="含义，如 本期" maxLength={200} aria-label="业务含义" className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-amber-500" />
          <button type="submit" disabled={isSubmitting || !form.tableName.trim() || !form.columnName.trim() || !form.valueCode.trim() || !form.meaning.trim()} className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-bold">
            {isSubmitting ? '保存中…' : '新增/覆盖'}
          </button>
        </form>
        <div className="space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-slate-400 text-[11px]">批量粘贴（每行一条，写入上方所选表.列）:</label>
            <span className="text-[10px] text-slate-500">支持「值=含义」「值:含义」及 Excel 两列粘贴</span>
            <button
              type="button"
              onClick={() => setBulkText('1=本期\n2=同期\n9=其他')}
              className="ml-auto flex items-center space-x-1 px-2 py-0.5 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-[10px]"
            >
              <Sparkles className="w-2.5 h-2.5" /><span>填入示例</span>
            </button>
          </div>
          <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={3} placeholder={'1=本期\n2=同期\n9=其他'} aria-label="批量粘贴值域释义" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500 resize-y font-mono" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {bulkText.trim() && (
              <span className={`text-[10px] ${bulkParsed.pairs.length === 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                将写入 {bulkParsed.pairs.length} 条
                {bulkParsed.duplicates > 0 ? ` · 重复 ${bulkParsed.duplicates} 条按后者覆盖` : ''}
                {bulkParsed.invalid > 0 ? ` · ${bulkParsed.invalid} 行无法解析` : ''}
              </span>
            )}
            <button onClick={() => void handleBulk()} disabled={bulkSubmitting || bulkParsed.pairs.length === 0} className="px-3 py-1.5 rounded-lg border border-amber-700/60 text-amber-300 hover:bg-amber-950/40 disabled:opacity-50 text-[11px] font-semibold">
              {bulkSubmitting ? '批量保存中…' : '批量保存'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-4 py-3 font-medium w-8">#</th>
                <th className="px-4 py-3 font-medium">表.列</th>
                <th className="px-4 py-3 font-medium">值</th>
                <th className="px-4 py-3 font-medium">含义</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleNotes.map((n, idx) => (
                <tr key={n.id} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                  <td className="px-4 py-3 text-slate-500">{idx + 1}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-300">{n.tableName}.{n.columnName}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-amber-300">{n.valueCode}</td>
                  <td className="px-4 py-3">{n.meaning}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${(ONTOLOGY_STATUS_META[n.status] || ONTOLOGY_STATUS_META.ACTIVE).cls}`}>
                      {(ONTOLOGY_STATUS_META[n.status] || ONTOLOGY_STATUS_META.ACTIVE).label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end space-x-1.5">
                      <button
                        onClick={() => { setEditing(n); setEditMeaning(n.meaning); setEditStatus(n.status); }}
                        className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium"
                      >
                        <Pencil className="w-3 h-3" /><span>编辑</span>
                      </button>
                      <button
                        onClick={() => void handleToggleStatus(n)}
                        aria-label={n.status === 'ACTIVE' ? `停用值域释义 ${n.tableName}.${n.columnName}` : `启用值域释义 ${n.tableName}.${n.columnName}`}
                        title={n.status === 'ACTIVE' ? '停用后不再注入提示词' : '重新启用'}
                        className={`p-1.5 rounded-lg border transition-colors ${
                          n.status === 'ACTIVE'
                            ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-amber-300'
                            : 'border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40'
                        }`}
                      >
                        {n.status === 'ACTIVE' ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                      </button>
                      <button onClick={() => void handleDelete(n)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium">
                        <Trash2 className="w-3 h-3" /><span>删除</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {isLoading && notes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">加载中…</td>
                </tr>
              )}
              {!isLoading && notes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">暂无值域释义，可上方单条新增或批量粘贴「值=含义」</td>
                </tr>
              )}
              {!isLoading && notes.length > 0 && visibleNotes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">没有匹配的值域释义（共 {notes.length} 条）</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setEditing(null)}>
          <div role="dialog" aria-modal="true" aria-label="编辑值域释义" className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">编辑释义 · {editing.tableName}.{editing.columnName} = {editing.valueCode}</h3>
              <button onClick={() => setEditing(null)} className="text-slate-400 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1 md:col-span-2">
                <label className="text-slate-300 font-medium">业务含义:</label>
                <input value={editMeaning} onChange={(e) => setEditMeaning(e.target.value)} maxLength={200} aria-label="编辑业务含义" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500" />
              </div>
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">状态:</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as 'ACTIVE' | 'DISABLED')}
                  aria-label="编辑状态"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500"
                >
                  <option value="ACTIVE">生效中（参与提示词注入）</option>
                  <option value="DISABLED">已停用（不注入）</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold">取消</button>
              <button onClick={() => void handleSaveMeaning()} disabled={!editMeaning.trim()} className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

