import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Plus, Trash2, Pencil, X, History, ChevronRight, Search, Power, PowerOff, Sparkles,
} from 'lucide-react';
import { getErrorMessage } from '../../../utils/errorUtils';
import { LevelEditor, useEscapeKey } from '../ontologyUi';
import { ONTOLOGY_STATUS_META, type OntologyHierarchyItem } from '../../../types/ontology';
import { callApi, type SectionProps } from './shared';

export const HierarchySection: React.FC<SectionProps> = ({ dataSourceId, tables, showNotice, onChanged, openVersions }) => {
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

