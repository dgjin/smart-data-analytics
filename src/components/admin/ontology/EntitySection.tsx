import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Plus, Trash2, Pencil, X, History,
  ChevronDown, ChevronRight, Search, Power, PowerOff, RotateCcw, Sparkles,
} from 'lucide-react';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaInput } from '../ontologyUi';
import { useEscapeKey, listFromText } from '../ontologyHelpers';
import {
  ENTITY_TYPE_META, BINDING_ROLE_META, ONTOLOGY_STATUS_META,
  type OntologyBindingItem, type OntologyBindingRole,
  type OntologyEntityItem, type OntologyEntityType,
} from '../../../types/ontology';
import { callApi, type SectionProps } from './shared';

const ENTITY_TYPES: OntologyEntityType[] = ['SUBJECT', 'OBJECT', 'TIME', 'GEO'];
const BINDING_ROLES: OntologyBindingRole[] = ['IDENTITY', 'RELATION_KEY', 'ATTRIBUTE'];

export const EntitySection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged, openVersions }) => {
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

