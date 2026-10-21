import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  X,
  CheckCircle2,
  AlertCircle,
  History,
  Route,
  Tag,
  Layers3,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Search,
  Power,
  PowerOff,
  ArrowLeftRight,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { getErrorMessage } from '../../utils/errorUtils';
import { SectionTabs, type SectionTabItem } from './SectionTabs';
import { OntologyAutoBuildModal } from './OntologyAutoBuildModal';
import {
  SchemaInput,
  SchemaColumnsInput,
  LevelEditor,
  useEscapeKey,
  columnsOf,
  listFromText,
} from './ontologyUi';
import type { TableSchema } from '../../types/analytics';
import {
  ENTITY_TYPE_META,
  BINDING_ROLE_META,
  ONTOLOGY_STATUS_META,
  type OntologyAssetType,
  type OntologyBindingItem,
  type OntologyBindingRole,
  type OntologyEntityItem,
  type OntologyEntityType,
  type OntologyHierarchyItem,
  type OntologyJoinType,
  type OntologyCardinality,
  type OntologyRelationItem,
  type OntologyRelationPath,
  type OntologySummaryCounts,
  type OntologyValueNoteItem,
  type OntologyVersionItem,
} from '../../types/ontology';

/**
 * 业务本体治理面板（v0.9.110 M1/M2）：
 * 实体与绑定 / 值域释义 / 关联路径 / 业务层级四类资产的手工治理入口（仅 ADMIN 可写）。
 * 本体只作问数软注入上下文（命中实体加权圈表 + 提示词四段），执行层 Schema 白名单不变；
 * 全部写操作走 /api/ontology，创建即 ACTIVE 并留版本快照，支持历史回滚。
 */

type OntologyTab = 'entities' | 'value-notes' | 'relations' | 'hierarchies';

const TABS: SectionTabItem<OntologyTab>[] = [
  { id: 'entities', label: '实体与绑定', icon: Boxes, color: 'text-cyan-400' },
  { id: 'value-notes', label: '值域释义', icon: Tag, color: 'text-amber-400' },
  { id: 'relations', label: '关联路径', icon: GitBranch, color: 'text-emerald-400' },
  { id: 'hierarchies', label: '业务层级', icon: Layers3, color: 'text-violet-400' },
];

const ENTITY_TYPES: OntologyEntityType[] = ['SUBJECT', 'OBJECT', 'TIME', 'GEO'];
const BINDING_ROLES: OntologyBindingRole[] = ['IDENTITY', 'RELATION_KEY', 'ATTRIBUTE'];
const JOIN_TYPES: OntologyJoinType[] = ['LEFT', 'INNER', 'RIGHT'];
const CARDINALITIES: OntologyCardinality[] = ['1:1', '1:N', 'N:1', 'N:N'];

const ACTION_LABELS: Record<string, string> = {
  CREATE: '创建',
  UPDATE: '更新',
  DELETE: '删除',
  RESTORE: '回滚',
};

/** 版本快照 → 一行可读摘要（替代原始 JSON 截断；完整快照仍在 title 中可查看） */
function summarizeSnapshot(assetType: OntologyAssetType, snapshot: Record<string, unknown>): string {
  const s = snapshot || {};
  const status = typeof s.status === 'string' ? s.status : '';
  const text = (v: unknown, max = 40) => (typeof v === 'string' && v ? v.slice(0, max) : '');

  if (assetType === 'entity') {
    return [
      text(s.name),
      text(s.entityType),
      Array.isArray(s.aliases) && s.aliases.length > 0 ? `别名 ${s.aliases.join('、')}` : '',
      status ? `状态 ${status}` : '',
      text(s.description),
    ].filter(Boolean).join(' · ');
  }

  if (assetType === 'relation') {
    const fromCols = Array.isArray(s.fromColumns) ? s.fromColumns.join(',') : '';
    const toCols = Array.isArray(s.toColumns) ? s.toColumns.join(',') : '';
    return [
      `${text(s.fromTable) || '?'}(${fromCols}) → ${text(s.toTable) || '?'}(${toCols})`,
      text(s.cardinality) ? `基数 ${s.cardinality}` : '',
      text(s.purpose),
      status ? `状态 ${status}` : '',
    ].filter(Boolean).join(' · ');
  }

  return [
    text(s.name),
    Array.isArray(s.levels) ? s.levels.join(' > ') : '',
    status ? `状态 ${status}` : '',
  ].filter(Boolean).join(' · ');
}

/** 统一 API 调用：非 2xx 抛带服务端 error 的异常 */
async function callApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string })?.error;
    throw new Error(msg || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

interface SectionProps {
  dataSourceId: string;
  tables: TableSchema[];
  showNotice: (type: 'success' | 'error', text: string) => void;
  onChanged: () => void;
  openVersions: (assetType: OntologyAssetType, id: number, title: string) => void;
}

// ============ 实体与绑定 ============

const EntitySection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged, openVersions }) => {
  const [entities, setEntities] = useState<OntologyEntityItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', entityType: 'SUBJECT' as OntologyEntityType, aliases: '', description: '' });
  const [editing, setEditing] = useState<OntologyEntityItem | null>(null);
  const [editForm, setEditForm] = useState({ name: '', entityType: 'SUBJECT' as OntologyEntityType, aliases: '', description: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [bindingDraft, setBindingDraft] = useState<OntologyBindingItem[]>([]);
  const [savingBindings, setSavingBindings] = useState(false);
  // 易用性（v0.9.111）：列表检索、仅看未绑定、绑定草稿脏标记
  const [query, setQuery] = useState('');
  const [onlyUnbound, setOnlyUnbound] = useState(false);
  const [bindingsDirty, setBindingsDirty] = useState(false);

  const load = useCallback(async () => {
    if (!dataSourceId) return;
    setIsLoading(true);
    try {
      const data = await callApi<{ entities: OntologyEntityItem[] }>(
        `/api/ontology/entities?dataSourceId=${encodeURIComponent(dataSourceId)}`
      );
      setEntities(data.entities || []);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载业务实体失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const boundCount = useMemo(() => entities.filter((e) => (e.bindings?.length || 0) > 0).length, [entities]);

  /** 列表检索：名称 / 别名 / 说明 / 绑定表列，全部客户端过滤，输入即得 */
  const visibleEntities = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entities.filter((e) => {
      if (onlyUnbound && (e.bindings?.length || 0) > 0) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q) ||
        e.aliases.some((a) => a.toLowerCase().includes(q)) ||
        (e.bindings || []).some((b) => b.tableName.toLowerCase().includes(q) || b.columnName.toLowerCase().includes(q))
      );
    });
  }, [entities, onlyUnbound, query]);

  useEscapeKey(editing !== null && !isSaving, () => setEditing(null));

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await callApi<{ ok: boolean; id: number }>('/api/ontology/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId,
          name: form.name.trim(),
          entityType: form.entityType,
          aliases: listFromText(form.aliases),
          description: form.description.trim(),
        }),
      });
      showNotice('success', `实体「${form.name.trim()}」已创建并生效（问数命中后参与圈表加权与提示词注入）`);
      setIsCreating(false);
      setForm({ name: '', entityType: 'SUBJECT', aliases: '', description: '' });
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEdit = (ent: OntologyEntityItem) => {
    setEditing(ent);
    setEditForm({ name: ent.name, entityType: ent.entityType, aliases: ent.aliases.join('、'), description: ent.description || '' });
  };

  const handleSaveEdit = async () => {
    if (!editing || isSaving) return;
    setIsSaving(true);
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/entities/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name.trim(),
          entityType: editForm.entityType,
          aliases: listFromText(editForm.aliases),
          description: editForm.description.trim(),
        }),
      });
      showNotice('success', `实体「${editForm.name.trim()}」已更新（版本 +1，可在版本历史回滚）`);
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (ent: OntologyEntityItem) => {
    if (!window.confirm(`确认删除实体「${ent.name}」？其表/列绑定将一并删除（保留删除快照）。`)) return;
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/entities/${ent.id}`, { method: 'DELETE' });
      showNotice('success', `已删除实体「${ent.name}」`);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  const draftOf = (ent: OntologyEntityItem): OntologyBindingItem[] =>
    (ent.bindings || []).map((b) => ({
      entityId: ent.id,
      dataSourceId,
      tableName: b.tableName,
      columnName: b.columnName,
      role: b.role,
    }));

  const toggleExpand = (ent: OntologyEntityItem) => {
    if (expandedId === ent.id) {
      if (bindingsDirty && !window.confirm('当前实体的绑定有未保存改动，确认收起并放弃？')) return;
      setExpandedId(null);
      setBindingsDirty(false);
      return;
    }
    if (bindingsDirty && !window.confirm('切换实体将丢弃当前未保存的绑定改动，确认继续？')) return;
    setExpandedId(ent.id);
    setBindingsDirty(false);
    setBindingDraft(draftOf(ent));
  };

  /** 绑定草稿的任何编辑都标记为脏，保存/重置后清除 */
  const updateDraft = (next: OntologyBindingItem[]) => {
    setBindingDraft(next);
    setBindingsDirty(true);
  };

  const addBindingRow = (ent: OntologyEntityItem) => {
    updateDraft([...bindingDraft, { entityId: ent.id, dataSourceId, tableName: '', columnName: '', role: 'ATTRIBUTE' }]);
  };

  const resetBindings = () => {
    const ent = entities.find((e) => e.id === expandedId);
    if (!ent) return;
    setBindingDraft(draftOf(ent));
    setBindingsDirty(false);
  };

  const handleSaveBindings = async (entityId: number) => {
    if (savingBindings || !bindingsDirty) return;
    setSavingBindings(true);
    try {
      const bindings = bindingDraft
        .map((b) => ({ tableName: b.tableName.trim(), columnName: b.columnName.trim(), role: b.role }))
        .filter((b) => b.tableName);
      await callApi<{ ok: boolean; count: number }>(`/api/ontology/entities/${entityId}/bindings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId, bindings }),
      });
      showNotice('success', `绑定已整组保存（${bindings.length} 条，IDENTITY 加权最高）`);
      setBindingsDirty(false);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setSavingBindings(false);
    }
  };

  /** 停用/启用：PUT 全量字段并翻转 status（不跳版本历史，version+1 留快照） */
  const handleToggleStatus = async (ent: OntologyEntityItem) => {
    const nextStatus = ent.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/entities/${ent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ent.name,
          entityType: ent.entityType,
          aliases: ent.aliases,
          description: ent.description || '',
          status: nextStatus,
        }),
      });
      showNotice(
        'success',
        nextStatus === 'ACTIVE'
          ? `实体「${ent.name}」已启用，恢复参与圈表加权与提示词注入`
          : `实体「${ent.name}」已停用，不再参与圈表加权与提示词注入（绑定保留）`
      );
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2 shadow-xl">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Search className="w-3.5 h-3.5 text-cyan-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索实体 / 别名 / 说明 / 绑定表列"
            aria-label="搜索业务实体"
            className="w-64 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
          />
          <label className="flex items-center space-x-1.5 text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyUnbound}
              onChange={(e) => setOnlyUnbound(e.target.checked)}
              className="accent-cyan-500"
            />
            <span>仅看未绑定</span>
          </label>
          <span className="text-[10px] text-slate-500">
            共 {entities.length} 个 · 已绑定 {boundCount} 个 · 当前显示 {visibleEntities.length} 个
          </span>
          <button onClick={() => void load()} disabled={isLoading} className="flex items-center space-x-1 text-slate-400 hover:text-slate-200 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /><span>刷新</span>
          </button>
          <button
            onClick={() => setIsCreating((v) => !v)}
            className="ml-auto flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-lg shadow-cyan-600/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建实体</span>
          </button>
        </div>
        <div className="text-[11px] text-slate-400">
          实体 = 业务概念（机构/客户/项目…）+ 别名 + 表列绑定；问数命中实体名或别名时，绑定表获得圈表加权。
        </div>
      </div>

      {isCreating && (
        <form onSubmit={handleCreate} className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
          <h3 className="font-bold text-slate-100 text-sm border-b border-slate-800 pb-2">新建业务实体（创建即生效）</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">实体名称（≤50 字，数据源内唯一）:</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如: 机构"
                maxLength={50}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">实体类型:</label>
              <select
                value={form.entityType}
                onChange={(e) => setForm({ ...form, entityType: e.target.value as OntologyEntityType })}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>{ENTITY_TYPE_META[t].label}（{t}）</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">业务别名（逗号分隔，参与问数命中）:</label>
              <input
                value={form.aliases}
                onChange={(e) => setForm({ ...form, aliases: e.target.value })}
                placeholder="例如: 机构名称、JGMC、组织"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">说明（≤300 字，可选）:</label>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="例如: 机构主数据，覆盖集团/分公司/项目三级"
                maxLength={300}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => setForm({ name: '机构', entityType: 'SUBJECT', aliases: '机构名称、JGMC、组织', description: '机构主数据，覆盖集团/分公司/项目三级' })}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-xl border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-[11px]"
            >
              <Sparkles className="w-3 h-3" /><span>填入示例</span>
            </button>
            <div className="flex items-center space-x-2">
              <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700">取消</button>
              <button type="submit" disabled={isSubmitting || !form.name.trim()} className="px-5 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow">
                {isSubmitting ? '创建中…' : '确认创建'}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-4 py-3 font-medium w-8">#</th>
                <th className="px-4 py-3 font-medium">实体</th>
                <th className="px-4 py-3 font-medium">类型</th>
                <th className="px-4 py-3 font-medium">别名</th>
                <th className="px-4 py-3 font-medium">绑定</th>
                <th className="px-4 py-3 font-medium">状态/版本</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntities.map((ent, idx) => {
                const typeMeta = ENTITY_TYPE_META[ent.entityType] || ENTITY_TYPE_META.SUBJECT;
                const statusMeta = ONTOLOGY_STATUS_META[ent.status] || ONTOLOGY_STATUS_META.ACTIVE;
                const expanded = expandedId === ent.id;
                return (
                  <React.Fragment key={ent.id}>
                    <tr className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 text-slate-500">{idx + 1}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleExpand(ent)} className="flex items-center space-x-1 font-semibold text-slate-200 hover:text-cyan-300">
                          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          <span>{ent.name}</span>
                        </button>
                        {ent.description && <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-1" title={ent.description}>{ent.description}</div>}
                      </td>
                      <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${typeMeta.cls}`}>{typeMeta.label}</span></td>
                      <td className="px-4 py-3 text-slate-400 max-w-[180px] truncate" title={ent.aliases.join('、')}>{ent.aliases.length > 0 ? ent.aliases.join('、') : '-'}</td>
                      <td className="px-4 py-3 text-slate-400">{ent.bindings?.length || 0} 条</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusMeta.cls}`}>{statusMeta.label}</span>
                        <span className="ml-1.5 text-[10px] text-slate-500">v{ent.version}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end space-x-1.5">
                          <button onClick={() => toggleExpand(ent)} className="px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                            {expanded ? '收起绑定' : '维护绑定'}
                          </button>
                          <button onClick={() => openEdit(ent)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                            <Pencil className="w-3 h-3" /><span>编辑</span>
                          </button>
                          <button onClick={() => openVersions('entity', ent.id, ent.name)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                            <History className="w-3 h-3" /><span>版本</span>
                          </button>
                          <button
                            onClick={() => void handleToggleStatus(ent)}
                            aria-label={ent.status === 'ACTIVE' ? `停用实体 ${ent.name}` : `启用实体 ${ent.name}`}
                            title={ent.status === 'ACTIVE' ? '停用后不再参与圈表加权与提示词注入' : '重新启用'}
                            className={`p-1.5 rounded-lg border text-[11px] transition-colors ${
                              ent.status === 'ACTIVE'
                                ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-amber-300'
                                : 'border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40'
                            }`}
                          >
                            {ent.status === 'ACTIVE' ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                          </button>
                          <button onClick={() => handleDelete(ent)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                            <Trash2 className="w-3 h-3" /><span>删除</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-slate-800/60 bg-slate-950/40">
                        <td
                          colSpan={7}
                          className="px-4 py-3 space-y-2"
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                              e.preventDefault();
                              void handleSaveBindings(ent.id);
                            }
                          }}
                        >
                          <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="text-slate-400">表/列绑定（整组替换；列名留空 = 表级绑定）：</span>
                            {bindingsDirty ? (
                              <span className="px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] font-semibold">有未保存改动</span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full border border-slate-700 text-slate-500 text-[10px]">与库内一致</span>
                            )}
                            <span className="text-[10px] text-slate-500">表/列支持联想，未命中 Schema 仅提示不阻断</span>
                          </div>
                          {bindingDraft.length === 0 && (
                            <div className="text-[11px] text-slate-500">暂无绑定，点击「添加绑定」登记该实体对应的表列</div>
                          )}
                          {bindingDraft.map((b, i) => (
                            <div
                              key={i}
                              className="flex flex-wrap items-start gap-2"
                              onKeyDown={(e) => {
                                const isInput = (e.target as HTMLElement).tagName === 'INPUT';
                                if (e.key === 'Enter' && isInput && i === bindingDraft.length - 1) {
                                  e.preventDefault();
                                  addBindingRow(ent);
                                }
                              }}
                            >
                              <div className="w-44">
                                <SchemaInput
                                  kind="table"
                                  value={b.tableName}
                                  onChange={(v) => {
                                    const next = [...bindingDraft];
                                    next[i] = { ...b, tableName: v };
                                    updateDraft(next);
                                  }}
                                  tables={tables}
                                  listId={`ont-entity-${ent.id}-tables-${i}`}
                                  placeholder="表名，如 JGXX"
                                  ariaLabel={`绑定表 ${i + 1}`}
                                />
                              </div>
                              <div className="w-44">
                                <SchemaInput
                                  kind="column"
                                  value={b.columnName}
                                  onChange={(v) => {
                                    const next = [...bindingDraft];
                                    next[i] = { ...b, columnName: v };
                                    updateDraft(next);
                                  }}
                                  tables={tables}
                                  tableName={b.tableName}
                                  listId={`ont-entity-${ent.id}-cols-${i}`}
                                  placeholder="列名（可空）"
                                  ariaLabel={`绑定列 ${i + 1}`}
                                />
                              </div>
                              <select
                                value={b.role}
                                onChange={(e) => {
                                  const next = [...bindingDraft];
                                  next[i] = { ...b, role: e.target.value as OntologyBindingRole };
                                  updateDraft(next);
                                }}
                                aria-label={`绑定角色 ${i + 1}`}
                                className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                              >
                                {BINDING_ROLES.map((r) => (
                                  <option key={r} value={r}>{BINDING_ROLE_META[r].label}（{r}）</option>
                                ))}
                              </select>
                              <button
                                onClick={() => updateDraft(bindingDraft.filter((_, j) => j !== i))}
                                className="p-1 rounded-lg text-rose-300 hover:bg-rose-950/40"
                                title="移除该绑定"
                                aria-label={`移除绑定 ${i + 1}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <button
                              onClick={() => addBindingRow(ent)}
                              className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px]"
                            >
                              <Plus className="w-3 h-3" /><span>添加绑定</span>
                            </button>
                            <button
                              onClick={resetBindings}
                              disabled={!bindingsDirty || savingBindings}
                              className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 text-[11px]"
                            >
                              <RotateCcw className="w-3 h-3" /><span>重置</span>
                            </button>
                            <button
                              onClick={() => void handleSaveBindings(ent.id)}
                              disabled={savingBindings || !bindingsDirty}
                              className="px-3 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[11px] font-bold"
                            >
                              {savingBindings ? '保存中…' : bindingsDirty ? '保存绑定' : '已保存'}
                            </button>
                            <span className="text-[10px] text-slate-500">Enter 新增一行 · Ctrl/Cmd + Enter 保存</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {isLoading && entities.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">加载中…</td>
                </tr>
              )}
              {!isLoading && entities.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">该数据源暂无业务实体，点击「新建实体」登记机构/客户/项目等业务概念</td>
                </tr>
              )}
              {!isLoading && entities.length > 0 && visibleEntities.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    没有匹配的实体（共 {entities.length} 个）
                    <button
                      onClick={() => { setQuery(''); setOnlyUnbound(false); }}
                      className="ml-2 text-cyan-300 hover:text-cyan-200 underline underline-offset-2"
                    >
                      清除筛选
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !isSaving && setEditing(null)}>
          <div role="dialog" aria-modal="true" aria-label="编辑实体" className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">编辑实体「{editing.name}」</h3>
              <button onClick={() => !isSaving && setEditing(null)} className="text-slate-400 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">实体名称:</label>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} maxLength={50} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500" />
              </div>
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">实体类型:</label>
                <select value={editForm.entityType} onChange={(e) => setEditForm({ ...editForm, entityType: e.target.value as OntologyEntityType })} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500">
                  {ENTITY_TYPES.map((t) => <option key={t} value={t}>{ENTITY_TYPE_META[t].label}（{t}）</option>)}
                </select>
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-slate-300 font-medium">业务别名（逗号分隔）:</label>
                <input value={editForm.aliases} onChange={(e) => setEditForm({ ...editForm, aliases: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500" />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-slate-300 font-medium">说明:</label>
                <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={2} maxLength={300} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500 resize-y" />
              </div>
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setEditing(null)} disabled={isSaving} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold">取消</button>
              <button onClick={() => void handleSaveEdit()} disabled={isSaving || !editForm.name.trim()} className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1">
                {isSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{isSaving ? '保存中…' : '保存'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

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

const ValueNoteSection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged }) => {
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

const RelationSection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged, openVersions }) => {
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

// ============ 业务层级 ============

const HierarchySection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged, openVersions }) => {
  const [hierarchies, setHierarchies] = useState<OntologyHierarchyItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<{ name: string; levels: string[] }>({ name: '', levels: ['', ''] });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editing, setEditing] = useState<OntologyHierarchyItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editLevels, setEditLevels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    if (!dataSourceId) return;
    setIsLoading(true);
    try {
      const data = await callApi<{ hierarchies: OntologyHierarchyItem[] }>(
        `/api/ontology/hierarchies?dataSourceId=${encodeURIComponent(dataSourceId)}`
      );
      setHierarchies(data.hierarchies || []);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载业务层级失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEscapeKey(editing !== null && !isSaving, () => setEditing(null));

  /** 层级列名建议：取当前数据源所有表的列名去重（层级通常来自同一张维度表） */
  const columnOptions = useMemo(
    () => [...new Set(tables.flatMap((t) => t.columns.map((c) => c.name)))].slice(0, 300),
    [tables]
  );

  const visibleHierarchies = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hierarchies;
    return hierarchies.filter((h) => h.name.toLowerCase().includes(q) || h.levels.some((lv) => lv.toLowerCase().includes(q)));
  }, [hierarchies, query]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const levels = form.levels.map((s) => s.trim()).filter(Boolean);
    if (levels.length < 2) {
      showNotice('error', '业务层级至少需要两级（由粗到细，如 集团、分公司、项目）');
      return;
    }
    setIsSubmitting(true);
    try {
      await callApi<{ ok: boolean; id: number }>('/api/ontology/hierarchies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId, name: form.name.trim(), levels }),
      });
      showNotice('success', `业务层级「${form.name.trim()}」已创建（${levels.join(' > ')}）`);
      setIsCreating(false);
      setForm({ name: '', levels: ['', ''] });
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEdit = (h: OntologyHierarchyItem) => {
    setEditing(h);
    setEditName(h.name);
    setEditLevels(h.levels.length > 0 ? [...h.levels] : ['']);
  };

  const handleSaveEdit = async () => {
    if (!editing || isSaving) return;
    const levels = editLevels.map((s) => s.trim()).filter(Boolean);
    if (levels.length < 2) {
      showNotice('error', '业务层级至少需要两级');
      return;
    }
    setIsSaving(true);
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/hierarchies/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), levels }),
      });
      showNotice('success', '业务层级已更新（版本 +1，可在版本历史回滚）');
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (h: OntologyHierarchyItem) => {
    if (!window.confirm(`确认删除业务层级「${h.name}」？（保留删除快照）`)) return;
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/hierarchies/${h.id}`, { method: 'DELETE' });
      showNotice('success', `已删除业务层级「${h.name}」`);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  /** 停用/启用业务层级：PUT 全量字段并翻转 status */
  const handleToggleStatus = async (h: OntologyHierarchyItem) => {
    const nextStatus = h.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      await callApi<{ ok: boolean }>(`/api/ontology/hierarchies/${h.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: h.name, levels: h.levels, status: nextStatus }),
      });
      showNotice('success', `业务层级「${h.name}」已${nextStatus === 'ACTIVE' ? '启用' : '停用'}`);
      await load();
      onChanged();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">
          业务层级 = 同一分析维度的下钻顺序（由粗到细）；问数命中相关表时注入，供「按机构层级汇总」等口径参考。
        </span>
        <div className="flex items-center space-x-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索层级名称或列名"
              aria-label="搜索业务层级"
              className="w-52 bg-slate-950 border border-slate-700 rounded-lg pl-7 pr-6 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="清除搜索" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <span className="text-[10px] text-slate-500">{visibleHierarchies.length}/{hierarchies.length} 条</span>
          <button
            onClick={() => setIsCreating((v) => !v)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold shadow-lg shadow-violet-600/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建层级</span>
          </button>
        </div>
      </div>

      {isCreating && (
        <form onSubmit={handleCreate} className="bg-slate-900 border border-violet-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 className="font-bold text-slate-100 text-sm">新建业务层级（创建即生效）</h3>
            <button
              type="button"
              onClick={() => setForm({ name: '机构层级', levels: ['集团', '分公司', '项目'] })}
              className="flex items-center space-x-1 text-[11px] text-violet-300 hover:text-violet-200"
            >
              <Sparkles className="w-3 h-3" /><span>填入示例</span>
            </button>
          </div>
          <div className="space-y-1 text-xs">
            <label className="text-slate-300 font-medium">层级名称（≤50 字，数据源内唯一）:</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={50}
              placeholder="例如: 机构层级"
              aria-label="层级名称"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500"
            />
          </div>
          <div className="space-y-1 text-xs">
            <label className="text-slate-300 font-medium">层级序列（由粗到细，至少两级；可按表结构联想列名）:</label>
            <LevelEditor
              levels={form.levels}
              onChange={(levels) => setForm({ ...form, levels })}
              columnOptions={columnOptions}
              listId="ont-hier-create-levels"
            />
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-slate-500">保存后参与「按层级汇总」口径注入；停用后保留数据但不再注入</span>
            <div className="flex items-center space-x-2">
              <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700">取消</button>
              <button type="submit" disabled={isSubmitting || !form.name.trim() || form.levels.filter((s) => s.trim()).length < 2} className="px-5 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold shadow">
                {isSubmitting ? '创建中…' : '确认创建'}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-4 py-3 font-medium w-8">#</th>
                <th className="px-4 py-3 font-medium">层级名称</th>
                <th className="px-4 py-3 font-medium">层级序列（由粗到细）</th>
                <th className="px-4 py-3 font-medium">状态/版本</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleHierarchies.map((h, idx) => {
                const statusMeta = ONTOLOGY_STATUS_META[h.status] || ONTOLOGY_STATUS_META.ACTIVE;
                return (
                  <tr key={h.id} className={`border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors ${h.status === 'DISABLED' ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-3 text-slate-500">{idx + 1}</td>
                    <td className="px-4 py-3 font-semibold text-slate-200">{h.name}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        {h.levels.map((lv, i) => (
                          <React.Fragment key={`${h.id}-${i}`}>
                            <span className="px-2 py-0.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-200 text-[10px] font-semibold">{lv}</span>
                            {i < h.levels.length - 1 && <ChevronRight className="w-3 h-3 text-slate-600" />}
                          </React.Fragment>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusMeta.cls}`}>{statusMeta.label}</span>
                      <span className="ml-1.5 text-[10px] text-slate-500">v{h.version}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button onClick={() => openEdit(h)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <Pencil className="w-3 h-3" /><span>编辑</span>
                        </button>
                        <button onClick={() => openVersions('hierarchy', h.id, h.name)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <History className="w-3 h-3" /><span>版本</span>
                        </button>
                        <button
                          onClick={() => void handleToggleStatus(h)}
                          aria-label={`${h.status === 'ACTIVE' ? '停用' : '启用'}业务层级 ${h.name}`}
                          title={h.status === 'ACTIVE' ? '停用：保留数据，但不再参与问数注入' : '启用：恢复参与问数注入'}
                          className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors ${
                            h.status === 'ACTIVE'
                              ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                              : 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40'
                          }`}
                        >
                          {h.status === 'ACTIVE' ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                          <span>{h.status === 'ACTIVE' ? '停用' : '启用'}</span>
                        </button>
                        <button onClick={() => void handleDelete(h)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                          <Trash2 className="w-3 h-3" /><span>删除</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    <RefreshCw className="inline w-3.5 h-3.5 mr-1 animate-spin" />加载中…
                  </td>
                </tr>
              )}
              {!isLoading && hierarchies.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">该数据源暂无业务层级，可登记「集团、分公司、项目」等下钻顺序</td>
                </tr>
              )}
              {!isLoading && hierarchies.length > 0 && visibleHierarchies.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    没有匹配「{query}」的业务层级
                    <button onClick={() => setQuery('')} className="ml-2 text-violet-300 hover:underline">清除搜索</button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !isSaving && setEditing(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="编辑业务层级"
            className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">编辑业务层级「{editing.name}」</h3>
              <button onClick={() => !isSaving && setEditing(null)} aria-label="关闭" className="text-slate-400 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-1 text-xs">
              <label className="text-slate-300 font-medium">层级名称:</label>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={50} aria-label="层级名称" className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500" />
            </div>
            <div className="space-y-1 text-xs">
              <label className="text-slate-300 font-medium">层级序列（由粗到细，可上下调整顺序）:</label>
              <LevelEditor
                levels={editLevels}
                onChange={setEditLevels}
                columnOptions={columnOptions}
                listId="ont-hier-edit-levels"
              />
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setEditing(null)} disabled={isSaving} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold">取消</button>
              <button onClick={() => void handleSaveEdit()} disabled={isSaving || !editName.trim()} className="px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1">
                {isSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{isSaving ? '保存中…' : '保存'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============ 版本历史与回滚 ============

interface VersionTarget {
  assetType: OntologyAssetType;
  id: number;
  title: string;
}

const VERSION_SEGMENTS: Record<OntologyAssetType, string> = {
  entity: 'entities',
  relation: 'relations',
  hierarchy: 'hierarchies',
};

const VersionHistoryModal: React.FC<{
  target: VersionTarget;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onClose: () => void;
  onRestored: () => void;
}> = ({ target, showNotice, onClose, onRestored }) => {
  const [versions, setVersions] = useState<OntologyVersionItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  const baseUrl = `/api/ontology/${VERSION_SEGMENTS[target.assetType]}/${target.id}`;

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await callApi<{ versions: OntologyVersionItem[] }>(`${baseUrl}/versions`);
      setVersions(data.versions || []);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '版本查询失败');
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEscapeKey(restoringVersion === null, onClose);

  const handleRestore = async (v: OntologyVersionItem) => {
    if (restoringVersion !== null) return;
    if (!window.confirm(`确认将「${target.title}」回滚到 v${v.version}？当前内容会作为新版本保留，可再次回滚。`)) return;
    setRestoringVersion(v.version);
    try {
      await callApi<{ ok: boolean }>(`${baseUrl}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v.version }),
      });
      showNotice('success', `已将「${target.title}」回滚到 v${v.version}（回滚动作记入版本历史）`);
      onRestored();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
      setRestoringVersion(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => restoringVersion === null && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="版本历史"
        className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-1.5">
            <History className="w-4 h-4 text-cyan-400" />
            <span>版本历史 · {target.title}</span>
            {!isLoading && <span className="text-[10px] font-normal text-slate-500">共 {versions.length} 个版本 · Esc 关闭</span>}
          </h3>
          <button onClick={onClose} disabled={restoringVersion !== null} aria-label="关闭" className="text-slate-400 hover:text-slate-200 disabled:opacity-50"><X className="w-4 h-4" /></button>
        </div>
        <div className="max-h-[420px] overflow-y-auto space-y-1.5">
          {versions.map((v, idx) => {
            const isLatest = idx === 0;
            return (
              <div key={`${v.version}-${v.createdAt}-${v.action}`} className={`flex items-center justify-between gap-2 bg-slate-950/60 border rounded-xl px-3 py-2 text-xs ${isLatest ? 'border-cyan-700/50' : 'border-slate-800'}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-bold text-slate-200">v{v.version}</span>
                    {isLatest && <span className="px-1.5 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-[10px] text-cyan-200">最新</span>}
                    <span className="px-1.5 py-0.5 rounded-full border border-slate-600/50 text-[10px] text-slate-300">{ACTION_LABELS[v.action] || v.action || '变更'}</span>
                    <span className="text-[10px] text-slate-500">{v.actor || '-'} · {v.createdAt || '-'}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate" title={JSON.stringify(v.snapshot)}>
                    {summarizeSnapshot(target.assetType, v.snapshot) || '（空快照）'}
                  </div>
                </div>
                <button
                  onClick={() => void handleRestore(v)}
                  disabled={restoringVersion !== null || isLatest}
                  title={isLatest ? '已是最新版本' : `回滚到 v${v.version}`}
                  className="shrink-0 px-2.5 py-1 rounded-lg border border-cyan-700/60 text-cyan-300 hover:bg-cyan-950/40 disabled:opacity-40 text-[11px] font-semibold"
                >
                  {restoringVersion === v.version ? '回滚中…' : isLatest ? '当前版本' : '回滚到此版本'}
                </button>
              </div>
            );
          })}
          {!isLoading && versions.length === 0 && (
            <div className="py-8 text-center text-xs text-slate-500">暂无版本记录（创建/更新/删除/回滚均会留快照）</div>
          )}
          {isLoading && (
            <div className="py-8 text-center text-xs text-slate-500"><RefreshCw className="inline w-3.5 h-3.5 mr-1 animate-spin" />加载中…</div>
          )}
        </div>
        <div className="text-[10px] text-slate-500">回滚仅作用于治理元数据（实体/关系/层级），不改变执行层 Schema 与已生成 SQL。</div>
      </div>
    </div>
  );
};

// ============ 业务本体主面板 ============

export const OntologyPanel: React.FC = () => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);

  const [dataSourceId, setDataSourceId] = useState('');
  const [tab, setTab] = useState<OntologyTab>('entities');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [summary, setSummary] = useState<OntologySummaryCounts | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [versionTarget, setVersionTarget] = useState<VersionTarget | null>(null);
  // 版本回滚后强制重挂载四个子面板，使其重新拉取最新资产
  const [refreshToken, setRefreshToken] = useState(0);
  const [autoBuildOpen, setAutoBuildOpen] = useState(false);

  const showNotice = useCallback((type: 'success' | 'error', text: string) => setNotice({ type, text }), []);
  const openVersions = useCallback(
    (assetType: OntologyAssetType, id: number, title: string) => setVersionTarget({ assetType, id, title }),
    []
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 默认选中第一个数据源（与 IronRulesPanel 一致）
  useEffect(() => {
    if (!dataSourceId && dataSources.length > 0) setDataSourceId(dataSources[0].id);
  }, [dataSources, dataSourceId]);

  const tables = useMemo(
    () => dataSources.find((ds) => ds.id === dataSourceId)?.tables || [],
    [dataSources, dataSourceId]
  );
  const dataSourceName = useMemo(
    () => dataSources.find((ds) => ds.id === dataSourceId)?.name || '',
    [dataSources, dataSourceId]
  );

  const loadSummary = useCallback(async () => {
    if (!dataSourceId) return;
    setIsSummaryLoading(true);
    try {
      const data = await callApi<{ summary: OntologySummaryCounts }>(
        `/api/ontology/summary?dataSourceId=${encodeURIComponent(dataSourceId)}`
      );
      setSummary(data.summary || null);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载本体概览失败');
    } finally {
      setIsSummaryLoading(false);
    }
  }, [dataSourceId, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void loadSummary(), 0);
    return () => clearTimeout(timer);
  }, [loadSummary]);

  const onChanged = useCallback(() => { void loadSummary(); }, [loadSummary]);
  const handleRestored = useCallback(() => {
    setVersionTarget(null);
    setRefreshToken((n) => n + 1);
    void loadSummary();
  }, [loadSummary]);

  // 可点击的计数卡直接切到对应 Tab（表列绑定依附实体，不单独跳转）
  const counters: { label: string; value: number; cls: string; tab?: OntologyTab; hint?: string }[] = [
    { label: '业务实体', value: summary?.entities ?? 0, cls: 'text-cyan-300', tab: 'entities' },
    { label: '表列绑定', value: summary?.bindings ?? 0, cls: 'text-slate-200', hint: '在「实体与绑定」中按实体维护' },
    { label: '值域释义', value: summary?.valueNotes ?? 0, cls: 'text-amber-300', tab: 'value-notes' },
    { label: '关联路径', value: summary?.relations ?? 0, cls: 'text-emerald-300', tab: 'relations' },
    { label: '业务层级', value: summary?.hierarchies ?? 0, cls: 'text-violet-300', tab: 'hierarchies' },
  ];

  return (
    <div className="space-y-4">
      {/* 数据源选择 + 概览计数条 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Boxes className="w-4 h-4 text-cyan-400" />
          <span className="font-bold text-slate-200">业务本体</span>
          <select
            value={dataSourceId}
            onChange={(e) => setDataSourceId(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            {dataSources.length === 0 && <option value="">暂无数据源</option>}
            {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
          </select>
          <button
            onClick={() => setAutoBuildOpen(true)}
            disabled={!dataSourceId}
            title="根据数据源 Schema 的中文描述与命名规则自动生成四类本体资产"
            className="flex items-center space-x-1 rounded-lg border border-cyan-700/60 bg-cyan-950/30 px-2.5 py-1.5 text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-40"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>智能预填</span>
          </button>
          <button onClick={() => void loadSummary()} disabled={isSummaryLoading} className="flex items-center space-x-1 text-slate-400 hover:text-slate-200 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isSummaryLoading ? 'animate-spin' : ''}`} />
            <span>刷新概览</span>
          </button>
          <span className="text-[10px] text-slate-500">命中实体 → 圈表加权 + 四段提示词软注入；执行层 Schema 白名单不变</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {counters.map((c) => {
            const activeTab = c.tab !== undefined && c.tab === tab;
            return (
              <button
                key={c.label}
                type="button"
                onClick={() => c.tab && setTab(c.tab)}
                disabled={!c.tab}
                title={c.hint || `查看${c.label}`}
                aria-label={c.tab ? `查看${c.label}` : c.hint}
                className={`text-left bg-slate-950/60 border rounded-xl px-3 py-2 transition-colors ${
                  activeTab ? 'border-cyan-500/60 ring-1 ring-cyan-500/30' : 'border-slate-800'
                } ${c.tab ? 'hover:border-slate-600 cursor-pointer' : 'cursor-default'}`}
              >
                <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
                <div className="text-[10px] text-slate-500">{c.label}（ACTIVE）{c.tab ? ' ›' : ''}</div>
              </button>
            );
          })}
        </div>
      </div>

      {notice && (
        <div className={`flex items-center justify-between rounded-xl border px-3 py-2 text-xs ${notice.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' : 'bg-rose-500/10 border-rose-500/30 text-rose-200'}`}>
          <div className="flex items-center space-x-2">
            {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span>{notice.text}</span>
          </div>
          <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-slate-200"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <SectionTabs<OntologyTab> tabs={TABS} active={tab} onChange={setTab} accent="cyan" />

      {dataSourceId ? (
        <>
          {tab === 'entities' && (
            <EntitySection
              key={`entities-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
          {tab === 'value-notes' && (
            <ValueNoteSection
              key={`value-notes-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
          {tab === 'relations' && (
            <RelationSection
              key={`relations-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
          {tab === 'hierarchies' && (
            <HierarchySection
              key={`hierarchies-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
        </>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-10 text-center text-xs text-slate-500">
          暂无可用数据源，请先在「数据源与 Schema」接入后再维护业务本体
        </div>
      )}

      {autoBuildOpen && dataSourceId && (
        <OntologyAutoBuildModal
          dataSourceId={dataSourceId}
          dataSourceName={dataSourceName}
          showNotice={showNotice}
          onClose={() => setAutoBuildOpen(false)}
          onApplied={handleRestored}
        />
      )}

      {versionTarget && (
        <VersionHistoryModal
          target={versionTarget}
          showNotice={showNotice}
          onClose={() => setVersionTarget(null)}
          onRestored={handleRestored}
        />
      )}
    </div>
  );
};

export default OntologyPanel;
