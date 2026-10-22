import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Plus, Trash2, Pencil, X, History, Route, Search,
  Power, PowerOff, ArrowLeftRight, Sparkles,
} from 'lucide-react';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaInput, SchemaColumnsInput, useEscapeKey, listFromText } from '../ontologyUi';
import type { TableSchema } from '../../../types/analytics';
import {
  ONTOLOGY_STATUS_META,
  type OntologyJoinType, type OntologyCardinality,
  type OntologyRelationItem, type OntologyRelationPath,
} from '../../../types/ontology';
import { callApi, type SectionProps } from './shared';

const JOIN_TYPES: OntologyJoinType[] = ['LEFT', 'INNER', 'RIGHT'];
const CARDINALITIES: OntologyCardinality[] = ['1:1', '1:N', 'N:1', 'N:N'];

// ============ 关联路径 ============

interface RelationFormState {
  fromTable: string;
  fromColumns: string;
  toTable: string;
  toColumns: string;
  joinType: OntologyJoinType;
  cardinality: OntologyCardinality;
  purpose: string;
}

const EMPTY_RELATION_FORM: RelationFormState = {
  fromTable: '',
  fromColumns: '',
  toTable: '',
  toColumns: '',
  joinType: 'LEFT',
  cardinality: 'N:1',
  purpose: '',
};

/** 表单即时校验（与服务端 sanitizeRelationInput 对齐，提交前就给出可读原因） */
function relationFormError(f: RelationFormState): string | null {
  const fromCols = listFromText(f.fromColumns);
  const toCols = listFromText(f.toColumns);
  if (!f.fromTable.trim()) return '请填写起点表';
  if (!f.toTable.trim()) return '请填写终点表';
  if (fromCols.length === 0 || toCols.length === 0) return '起止关联列均为必填';
  if (fromCols.length !== toCols.length) return `两侧关联列数量需一致（当前 ${fromCols.length} vs ${toCols.length}）`;
  return null;
}

/**
 * 关系表单字段（创建与编辑复用）：
 * 表/列带 Schema 联想；列支持「已选 chips + 下拉追加」，两侧列数不一致时即时提示；
 * 一键交换起点/终点（列同步交换），避免手工对调出错。
 */
const RelationFields: React.FC<{
  value: RelationFormState;
  onChange: (next: RelationFormState) => void;
  tables: TableSchema[];
  idPrefix: string;
}> = ({ value, onChange, tables, idPrefix }) => {
  const fromCols = listFromText(value.fromColumns);
  const toCols = listFromText(value.toColumns);
  const mismatch = fromCols.length !== toCols.length;

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-slate-300 font-medium">起点表:</label>
          <SchemaInput
            kind="table"
            value={value.fromTable}
            onChange={(v) => onChange({ ...value, fromTable: v })}
            tables={tables}
            listId={`${idPrefix}-from-table`}
            placeholder="例如: JGXX"
            accent="emerald"
            ariaLabel="起点表"
          />
        </div>
        <div className="space-y-1">
          <label className="text-slate-300 font-medium">起点列（必填，多列按顺序对应）:</label>
          <SchemaColumnsInput
            value={value.fromColumns}
            onChange={(v) => onChange({ ...value, fromColumns: v })}
            tables={tables}
            tableName={value.fromTable}
            listId={`${idPrefix}-from-cols`}
            placeholder="例如: JGDM，或 JGDM,JGBH"
            ariaLabel="起点列"
          />
        </div>
        <div className="space-y-1">
          <label className="text-slate-300 font-medium">终点表:</label>
          <SchemaInput
            kind="table"
            value={value.toTable}
            onChange={(v) => onChange({ ...value, toTable: v })}
            tables={tables}
            listId={`${idPrefix}-to-table`}
            placeholder="例如: XMXX"
            accent="emerald"
            ariaLabel="终点表"
          />
        </div>
        <div className="space-y-1">
          <label className="text-slate-300 font-medium">终点列（必填，与起点列一一对应）:</label>
          <SchemaColumnsInput
            value={value.toColumns}
            onChange={(v) => onChange({ ...value, toColumns: v })}
            tables={tables}
            tableName={value.toTable}
            listId={`${idPrefix}-to-cols`}
            placeholder="例如: JGDM"
            ariaLabel="终点列"
          />
        </div>
        <div className="space-y-1">
          <label className="text-slate-300 font-medium">JOIN 类型:</label>
          <select
            value={value.joinType}
            onChange={(e) => onChange({ ...value, joinType: e.target.value as OntologyJoinType })}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-emerald-500"
          >
            {JOIN_TYPES.map((j) => <option key={j} value={j}>{j} JOIN</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-slate-300 font-medium">基数（起点 → 终点）:</label>
          <select
            value={value.cardinality}
            onChange={(e) => onChange({ ...value, cardinality: e.target.value as OntologyCardinality })}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-emerald-500"
          >
            {CARDINALITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="space-y-1 md:col-span-2">
          <label className="text-slate-300 font-medium">业务用途（≤300 字，注入提示词时随路径展示）:</label>
          <input
            value={value.purpose}
            onChange={(e) => onChange({ ...value, purpose: e.target.value })}
            maxLength={300}
            placeholder="例如: 资产归属机构，按机构名称关联"
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-[10px] ${mismatch ? 'text-rose-300' : 'text-slate-500'}`}>
          {fromCols.length === 0 || toCols.length === 0
            ? '起止列均为必填（服务端要求两侧列一一对应）'
            : mismatch
              ? `两侧关联列数量需一致（当前 ${fromCols.length} vs ${toCols.length}）`
              : `已配置 ${fromCols.length} 组关联列：${fromCols.map((c, i) => `${c}=${toCols[i]}`).join('，')}`}
        </span>
        <button
          type="button"
          onClick={() => onChange({
            ...value,
            fromTable: value.toTable,
            fromColumns: value.toColumns,
            toTable: value.fromTable,
            toColumns: value.fromColumns,
          })}
          className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px]"
        >
          <ArrowLeftRight className="w-3 h-3" /><span>交换起点 / 终点</span>
        </button>
      </div>
    </div>
  );
};

export const RelationSection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged, openVersions }) => {
  const [relations, setRelations] = useState<OntologyRelationItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<RelationFormState>(EMPTY_RELATION_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editing, setEditing] = useState<OntologyRelationItem | null>(null);
  const [editForm, setEditForm] = useState<RelationFormState>(EMPTY_RELATION_FORM);
  const [isSaving, setIsSaving] = useState(false);
  // 最短路预览（GET /api/ontology/path，内存 BFS 最多 3 跳）
  const [previewFrom, setPreviewFrom] = useState('');
  const [previewTo, setPreviewTo] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ from: string; to: string; paths: OntologyRelationPath[] } | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    if (!dataSourceId) return;
    setIsLoading(true);
    try {
      const data = await callApi<{ relations: OntologyRelationItem[] }>(
        `/api/ontology/relations?dataSourceId=${encodeURIComponent(dataSourceId)}`
      );
      setRelations(data.relations || []);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载关联路径失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEscapeKey(editing !== null && !isSaving, () => setEditing(null));

  /** 关联路径检索：起止表 / 列 / 用途，客户端即时过滤 */
  const visibleRelations = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return relations;
    return relations.filter((r) =>
      [r.fromTable, r.toTable, r.purpose, ...r.fromColumns, ...r.toColumns]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q))
    );
  }, [relations, query]);

  const payloadOf = (f: RelationFormState) => ({
    dataSourceId,
    fromTable: f.fromTable.trim(),
    fromColumns: listFromText(f.fromColumns),
    toTable: f.toTable.trim(),
    toColumns: listFromText(f.toColumns),
    joinType: f.joinType,
    cardinality: f.cardinality,
    purpose: f.purpose.trim(),
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const invalid = relationFormError(form);
    if (invalid) {
      showNotice('error', invalid);
      return;
    }
    setIsSubmitting(true);
    try {
      await callApi<{ ok: boolean; id: number }>('/api/ontology/relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadOf(form)),
      });
      showNotice('success', `关联路径 ${form.fromTable.trim()} → ${form.toTable.trim()} 已登记（问数作为候选 JOIN 路径注入）`);
      setIsCreating(false);
      setForm(EMPTY_RELATION_FORM);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEdit = (rel: OntologyRelationItem) => {
    setEditing(rel);
    setEditForm({
      fromTable: rel.fromTable,
      fromColumns: rel.fromColumns.join(','),
      toTable: rel.toTable,
      toColumns: rel.toColumns.join(','),
      joinType: rel.joinType,
      cardinality: rel.cardinality,
      purpose: rel.purpose || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editing || isSaving) return;
    const invalid = relationFormError(editForm);
    if (invalid) {
      showNotice('error', invalid);
      return;
    }
    setIsSaving(true);
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/relations/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadOf(editForm)),
      });
      showNotice('success', '关联路径已更新（版本 +1，可在版本历史回滚）');
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (rel: OntologyRelationItem) => {
    if (!window.confirm(`确认删除关联路径 ${rel.fromTable} → ${rel.toTable}？（保留删除快照）`)) return;
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/relations/${rel.id}`, { method: 'DELETE' });
      showNotice('success', '已删除关联路径');
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  /** 停用/启用关联路径：PUT 全量字段并翻转 status */
  const handleToggleStatus = async (rel: OntologyRelationItem) => {
    const nextStatus = rel.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/relations/${rel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId,
          fromTable: rel.fromTable,
          fromColumns: rel.fromColumns,
          toTable: rel.toTable,
          toColumns: rel.toColumns,
          joinType: rel.joinType,
          cardinality: rel.cardinality,
          purpose: rel.purpose || '',
          status: nextStatus,
        }),
      });
      showNotice('success', `关联路径 ${rel.fromTable} → ${rel.toTable} 已${nextStatus === 'ACTIVE' ? '启用' : '停用'}`);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  const handlePreview = async (fromArg?: string, toArg?: string) => {
    const from = (fromArg ?? previewFrom).trim();
    const to = (toArg ?? previewTo).trim();
    if (!from || !to) {
      showNotice('error', '请先填写起点表与终点表');
      return;
    }
    setPreviewFrom(from);
    setPreviewTo(to);
    setPreviewing(true);
    try {
      const data = await callApi<{ from: string; to: string; paths: OntologyRelationPath[] }>(
        `/api/ontology/path?dataSourceId=${encodeURIComponent(dataSourceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      setPreview({ from: data.from, to: data.to, paths: data.paths || [] });
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2 shadow-xl">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Search className="w-3.5 h-3.5 text-emerald-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按表名 / 列名 / 用途筛选"
            aria-label="筛选关联路径"
            className="w-64 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-emerald-500"
          />
          <span className="text-[10px] text-slate-500">共 {relations.length} 条 · 当前显示 {visibleRelations.length} 条</span>
          {query && (
            <button onClick={() => setQuery('')} className="text-[10px] text-emerald-300 hover:text-emerald-200 underline underline-offset-2">清除筛选</button>
          )}
          <button onClick={() => void load()} disabled={isLoading} className="flex items-center space-x-1 text-slate-400 hover:text-slate-200 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /><span>刷新</span>
          </button>
          <button
            onClick={() => setIsCreating((v) => !v)}
            className="ml-auto flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-600/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>登记路径</span>
          </button>
        </div>
        <div className="text-[11px] text-slate-400">
          已登记 JOIN 路径 = 表间关联的权威口径（含基数与用途）；问数命中表之间存在路径时作为候选 JOIN 注入，仅推荐、不强制。
        </div>
      </div>

      {isCreating && (
        <form onSubmit={handleCreate} className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
          <h3 className="font-bold text-slate-100 text-sm border-b border-slate-800 pb-2">登记关联路径（创建即生效）</h3>
          <RelationFields value={form} onChange={setForm} tables={tables} idPrefix="ont-rel-create" />
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => setForm({ ...EMPTY_RELATION_FORM, fromTable: 'JGXX', fromColumns: 'JGDM', toTable: 'XMXX', toColumns: 'JGDM', purpose: '项目归属机构，按机构代码关联' })}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-xl border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-[11px]"
            >
              <Sparkles className="w-3 h-3" /><span>填入示例</span>
            </button>
            <div className="flex items-center space-x-2">
              <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700">取消</button>
              <button type="submit" disabled={isSubmitting || Boolean(relationFormError(form))} title={relationFormError(form) || undefined} className="px-5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold shadow">
                {isSubmitting ? '登记中…' : '确认登记'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* 最短路预览 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Route className="w-4 h-4 text-emerald-400" />
          <span className="font-bold text-slate-300">路径预览</span>
          <input value={previewFrom} onChange={(e) => setPreviewFrom(e.target.value)} list="ont-rel-preview-tables" placeholder="起点表" aria-label="路径预览起点表" className="w-32 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-emerald-500" />
          <span className="text-slate-500">→</span>
          <input value={previewTo} onChange={(e) => setPreviewTo(e.target.value)} list="ont-rel-preview-tables" placeholder="终点表" aria-label="路径预览终点表" className="w-32 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-emerald-500" />
          <datalist id="ont-rel-preview-tables">
            {tables.map((t) => <option key={t.name} value={t.name} />)}
          </datalist>
          <button
            onClick={() => void handlePreview()}
            disabled={previewing}
            className="px-3 py-1.5 rounded-lg border border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-50 text-[11px] font-semibold"
          >
            {previewing ? '检索中…' : '检索最短路'}
          </button>
          <span className="text-[10px] text-slate-500">内存 BFS，最多 3 跳；与问数注入的路径检索同源</span>
        </div>
        {preview && (
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-1.5">
            {preview.paths.length === 0 ? (
              <div className="text-[11px] text-slate-500">「{preview.from} → {preview.to}」之间暂无已登记路径，可上方登记后重试</div>
            ) : (
              preview.paths.map((p, i) => (
                <div key={i} className="text-[11px] text-slate-300">
                  <span className="text-emerald-300 font-semibold">路径 {i + 1}（{p.hops} 跳）：</span>
                  <span className="font-mono">{p.tables.join(' → ')}</span>
                  <div className="text-[10px] text-slate-500 font-mono">
                    {p.edges.map((e) => `${e.fromTable}.${e.fromColumns.join('/') || '*'} -[${e.joinType}${e.reversed ? '·反向' : ''}, ${e.cardinality}]-> ${e.toTable}.${e.toColumns.join('/') || '*'}`).join('；')}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-4 py-3 font-medium w-8">#</th>
                <th className="px-4 py-3 font-medium">起点（表/列）</th>
                <th className="px-4 py-3 font-medium">终点（表/列）</th>
                <th className="px-4 py-3 font-medium">JOIN / 基数</th>
                <th className="px-4 py-3 font-medium">用途</th>
                <th className="px-4 py-3 font-medium">状态/版本</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleRelations.map((rel, idx) => {
                const statusMeta = ONTOLOGY_STATUS_META[rel.status] || ONTOLOGY_STATUS_META.ACTIVE;
                return (
                  <tr key={rel.id} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-slate-500">{idx + 1}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-200">
                      {rel.fromTable}{rel.fromColumns.length > 0 ? `（${rel.fromColumns.join(',')}）` : ''}
                      <div className="text-[10px] text-slate-500">反向：{rel.toTable}（{rel.toColumns.join(',') || '*'}）→ {rel.fromTable}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-200">
                      {rel.toTable}{rel.toColumns.length > 0 ? `（${rel.toColumns.join(',')}）` : ''}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-slate-600/50 text-slate-300">{rel.joinType}</span>
                      <span className="ml-1.5 text-[10px] px-2 py-0.5 rounded-full border border-emerald-600/40 text-emerald-300">{rel.cardinality}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 max-w-[200px] truncate" title={rel.purpose}>{rel.purpose || '-'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusMeta.cls}`}>{statusMeta.label}</span>
                      <span className="ml-1.5 text-[10px] text-slate-500">v{rel.version}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button onClick={() => void handlePreview(rel.fromTable, rel.toTable)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <Route className="w-3 h-3" /><span>路径</span>
                        </button>
                        <button onClick={() => openEdit(rel)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <Pencil className="w-3 h-3" /><span>编辑</span>
                        </button>
                        <button onClick={() => openVersions('relation', rel.id, `${rel.fromTable} → ${rel.toTable}`)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <History className="w-3 h-3" /><span>版本</span>
                        </button>
                        <button
                          onClick={() => void handleToggleStatus(rel)}
                          aria-label={rel.status === 'ACTIVE' ? `停用关联路径 ${rel.fromTable} 到 ${rel.toTable}` : `启用关联路径 ${rel.fromTable} 到 ${rel.toTable}`}
                          title={rel.status === 'ACTIVE' ? '停用后不再作为候选 JOIN 注入' : '重新启用'}
                          className={`p-1.5 rounded-lg border transition-colors ${
                            rel.status === 'ACTIVE'
                              ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-amber-300'
                              : 'border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40'
                          }`}
                        >
                          {rel.status === 'ACTIVE' ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                        </button>
                        <button onClick={() => void handleDelete(rel)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                          <Trash2 className="w-3 h-3" /><span>删除</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {isLoading && relations.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">加载中…</td>
                </tr>
              )}
              {!isLoading && relations.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">该数据源暂无关联路径，点击「登记路径」维护表间 JOIN 的权威口径</td>
                </tr>
              )}
              {!isLoading && relations.length > 0 && visibleRelations.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">没有匹配的关联路径（共 {relations.length} 条）</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !isSaving && setEditing(null)}>
          <div role="dialog" aria-modal="true" aria-label="编辑关联路径" className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">编辑关联路径「{editing.fromTable} → {editing.toTable}」</h3>
              <button onClick={() => !isSaving && setEditing(null)} className="text-slate-400 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <RelationFields value={editForm} onChange={setEditForm} tables={tables} idPrefix="ont-rel-edit" />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-500">保存后版本 +1，可在「版本」中回滚</span>
              <div className="flex justify-end space-x-2">
                <button onClick={() => setEditing(null)} disabled={isSaving} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold">取消</button>
                <button onClick={() => void handleSaveEdit()} disabled={isSaving || Boolean(relationFormError(editForm))} title={relationFormError(editForm) || undefined} className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1">
                  {isSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{isSaving ? '保存中…' : '保存'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
