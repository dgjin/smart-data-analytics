import React, { useCallback, useEffect, useState } from 'react';
import {
  Gavel,
  RefreshCw,
  Plus,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Download,
  Upload,
  X,
  Pencil,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';

/**
 * 铁律规则库面板（v0.9.35）：按数据源维护问数强制规则（口径红线/禁区/固定约束）。
 * 全部 ACTIVE 铁律恒注入问数与报表的阶段一 prompt（最高优先级，所有问数必须逐条遵守）；
 * 仅 ADMIN 可见可维护（本面板挂载于系统管理内），创建即生效、无审批流；支持 JSON 备份导入导出。
 */

type RuleStatus = 'ACTIVE' | 'DISABLED';

interface IronRuleItem {
  id: number;
  dataSourceId: string;
  title: string;
  content: string;
  status: RuleStatus;
  createdBy?: string;
}

const STATUS_META: Record<RuleStatus, { label: string; cls: string }> = {
  ACTIVE: { label: '生效中', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  DISABLED: { label: '已停用', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

export const IronRulesPanel: React.FC = () => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);

  const [dataSourceId, setDataSourceId] = useState('');
  const [rules, setRules] = useState<IronRuleItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 新建表单
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState({ title: '', content: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 编辑弹窗
  const [editing, setEditing] = useState<IronRuleItem | null>(null);
  const [editForm, setEditForm] = useState({ title: '', content: '' });
  const [isSaving, setIsSaving] = useState(false);

  // 导入导出：JSON 备份文件的导出下载与导入恢复
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStrategy, setImportStrategy] = useState<'skip' | 'overwrite'>('skip');
  const [importDryRun, setImportDryRun] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 默认选中第一个数据源
  useEffect(() => {
    if (!dataSourceId && dataSources.length > 0) setDataSourceId(dataSources[0].id);
  }, [dataSources, dataSourceId]);

  const loadRules = useCallback(async () => {
    if (!dataSourceId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/iron-rules?dataSourceId=${encodeURIComponent(dataSourceId)}`);
      const data = await res.json();
      if (res.ok && data.rules) {
        setRules(data.rules);
      } else {
        showNotice('error', data.error || '加载铁律失败');
      }
    } catch (err: any) {
      showNotice('error', err.message || '加载铁律失败');
    } finally {
      setIsLoading(false);
    }
  }, [dataSourceId]);

  useEffect(() => {
    const timer = setTimeout(() => loadRules(), 0);
    return () => clearTimeout(timer);
  }, [loadRules]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/iron-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId, title: form.title.trim(), content: form.content.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '创建失败');
      showNotice('success', `铁律「${form.title.trim()}」已创建并生效（该数据源所有问数与报表将逐条遵守）`);
      setIsCreating(false);
      setForm({ title: '', content: '' });
      loadRules();
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEdit = (r: IronRuleItem) => {
    setEditing(r);
    setEditForm({ title: r.title, content: r.content });
  };

  const handleSaveEdit = async () => {
    if (!editing || isSaving) return;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/iron-rules/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editForm.title.trim(), content: editForm.content.trim(), status: editing.status }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');
      showNotice('success', `铁律「${editForm.title.trim()}」已更新`);
      setEditing(null);
      loadRules();
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (r: IronRuleItem) => {
    const next: RuleStatus = r.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      const res = await apiFetch(`/api/iron-rules/${r.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: r.title, content: r.content, status: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '操作失败');
      showNotice('success', next === 'ACTIVE' ? `已启用「${r.title}」（即刻对问数生效）` : `已停用「${r.title}」`);
      loadRules();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleDelete = async (r: IronRuleItem) => {
    if (!window.confirm(`确认删除铁律「${r.title}」？删除后该数据源问数将不再受此规则约束。`)) return;
    try {
      const res = await apiFetch(`/api/iron-rules/${r.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败');
      showNotice('success', `已删除「${r.title}」`);
      loadRules();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  // 导出当前数据源的全部铁律为 JSON 备份文件
  const handleExport = async () => {
    if (!dataSourceId || exporting) return;
    setExporting(true);
    try {
      const res = await apiFetch(`/api/iron-rules/export?dataSourceId=${encodeURIComponent(dataSourceId)}`);
      if (!res.ok) {
        const d: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(d.error || '导出失败');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      const dsName = dataSources.find((d) => d.id === dataSourceId)?.name || dataSourceId;
      a.href = url;
      a.download = `铁律规则库-${dsName}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showNotice('success', `铁律规则库已导出（${dsName}，共 ${rules.length} 条）。`);
    } catch (err: any) {
      showNotice('error', err.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  // 从 JSON 备份文件导入铁律到当前选中的数据源
  const handleImport = async () => {
    if (!importFile || importing) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await importFile.text();
      let fileData: any;
      try {
        fileData = JSON.parse(text);
      } catch {
        throw new Error('文件不是有效的 JSON，请选择铁律规则库导出文件');
      }
      const res = await apiFetch('/api/iron-rules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileData,
          dataSourceId,
          mergeStrategy: importStrategy,
          dryRun: importDryRun,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      setImportResult(data);
      if (!importDryRun && data.success) {
        showNotice('success', `导入完成：新增 ${data.importedCount} 条，覆盖更新 ${data.updatedCount} 条，跳过 ${data.skippedCount} 条。`);
        setShowImport(false);
        loadRules();
      }
    } catch (err: any) {
      showNotice('error', err.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const activeCount = rules.filter((r) => r.status === 'ACTIVE').length;

  return (
    <div className="space-y-4">
      {/* 工具条：数据源选择 + 新建/导入导出 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-3">
          <Gavel className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-bold text-slate-300">铁律规则库</span>
          <select
            value={dataSourceId}
            onChange={(e) => setDataSourceId(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
          >
            {dataSources.map((ds) => (
              <option key={ds.id} value={ds.id}>{ds.name}</option>
            ))}
          </select>
          {activeCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold">
              {activeCount} 条生效中
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => loadRules()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || !dataSourceId}
            title="导出当前数据源的全部铁律为 JSON 备份文件"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold transition-colors"
          >
            <Download className={`w-3.5 h-3.5 ${exporting ? 'animate-pulse' : ''}`} />
            <span>{exporting ? '导出中…' : '导出'}</span>
          </button>
          <button
            onClick={() => {
              setShowImport(true);
              setImportFile(null);
              setImportResult(null);
              setImportStrategy('skip');
              setImportDryRun(true);
            }}
            disabled={!dataSourceId}
            title="从 JSON 备份文件导入铁律到当前数据源"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>导入</span>
          </button>
          <button
            onClick={() => setIsCreating((v) => !v)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold shadow-lg shadow-amber-600/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建铁律</span>
          </button>
        </div>
      </div>

      {/* 说明条 */}
      <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl px-4 py-2.5 text-[11px] text-amber-200/80 leading-relaxed">
        铁律是本数据源的强制规则：所有生效中的铁律会逐条注入每次智能问数与报表生成的 SQL 约束，优先级高于样例与知识库。适用于口径红线、统计禁区、固定过滤等「任何情况下都必须遵守」的规则。
      </div>

      {/* Notice */}
      {notice && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* 新建表单 */}
      {isCreating && (
        <form onSubmit={handleCreate} className="bg-slate-900 border border-amber-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
          <h3 className="font-bold text-slate-100 text-sm border-b border-slate-800 pb-2">新建铁律（创建即生效）</h3>
          <div className="space-y-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">规则标题（≤100字，数据源内唯一）:</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="例如: 禁止跨法人机构统计"
                maxLength={100}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">规则正文（≤2000字，自然语言描述，将原样注入 SQL 生成约束）:</label>
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="例如: 任何统计查询都必须限定报表日期为最新一期（BBRQ = (SELECT MAX(BBRQ) FROM 表)），禁止跨期汇总。"
                rows={4}
                maxLength={2000}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500 resize-y"
              />
              <div className="text-right text-[10px] text-slate-500">{form.content.length}/2000</div>
            </div>
          </div>
          <div className="flex items-center justify-end space-x-2 pt-1">
            <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700">取消</button>
            <button type="submit" disabled={isSubmitting || !form.title.trim() || !form.content.trim()} className="px-5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow">
              {isSubmitting ? '创建中…' : '确认创建'}
            </button>
          </div>
        </form>
      )}

      {/* 铁律列表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-4 py-3 font-medium w-8">#</th>
                <th className="px-4 py-3 font-medium">规则标题</th>
                <th className="px-4 py-3 font-medium">规则正文</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">创建人</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, idx) => {
                const meta = STATUS_META[r.status] || STATUS_META.ACTIVE;
                return (
                  <tr key={r.id} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-slate-500">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-200">{r.title}</div>
                    </td>
                    <td className="px-4 py-3 max-w-md">
                      <div className="text-slate-400 line-clamp-2 whitespace-pre-wrap" title={r.content}>{r.content}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-[10px]">{r.createdBy || '-'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button onClick={() => openEdit(r)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <Pencil className="w-3 h-3" /><span>编辑</span>
                        </button>
                        <button onClick={() => handleToggleStatus(r)} className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors ${r.status === 'ACTIVE' ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40'}`}>
                          {r.status === 'ACTIVE' ? '停用' : '启用'}
                        </button>
                        <button onClick={() => handleDelete(r)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                          <Trash2 className="w-3 h-3" /><span>删除</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && rules.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">该数据源暂无铁律，点击「新建铁律」定义本数据源的问数强制规则</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !isSaving && setEditing(null)}>
          <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">编辑铁律</h3>
              <button onClick={() => !isSaving && setEditing(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">规则标题（≤100字，数据源内唯一）:</label>
                <input
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  maxLength={100}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">规则正文（≤2000字）:</label>
                <textarea
                  value={editForm.content}
                  onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                  rows={5}
                  maxLength={2000}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500 resize-y"
                />
                <div className="text-right text-[10px] text-slate-500">{editForm.content.length}/2000</div>
              </div>
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setEditing(null)} disabled={isSaving} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold">取消</button>
              <button
                onClick={handleSaveEdit}
                disabled={isSaving || !editForm.title.trim() || !editForm.content.trim()}
                className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
              >
                {isSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{isSaving ? '保存中…' : '保存'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导入弹窗 */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !importing && setShowImport(false)}>
          <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">
                导入铁律规则库 · {dataSources.find((d) => d.id === dataSourceId)?.name || ''}
              </h3>
              <button onClick={() => !importing && setShowImport(false)} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 文件选择 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">备份文件（铁律规则库导出 JSON）</label>
              <input
                type="file"
                accept=".json,application/json"
                disabled={importing}
                onChange={(e) => {
                  setImportFile(e.target.files?.[0] || null);
                  setImportResult(null);
                }}
                className="w-full text-xs text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-amber-600 file:text-white file:text-xs file:font-semibold hover:file:bg-amber-500 file:cursor-pointer"
              />
            </div>

            {/* 冲突策略 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">同标题铁律冲突处理</label>
              <select
                value={importStrategy}
                onChange={(e) => setImportStrategy(e.target.value as 'skip' | 'overwrite')}
                disabled={importing}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
              >
                <option value="skip">跳过：保留现有铁律，忽略文件中的同标题条目</option>
                <option value="overwrite">覆盖：用文件内容替换现有同标题铁律</option>
              </select>
            </div>

            {/* 预检开关 */}
            <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={importDryRun}
                onChange={(e) => setImportDryRun(e.target.checked)}
                disabled={importing}
                className="rounded border-slate-600 bg-slate-950 text-amber-500 focus:ring-amber-500"
              />
              <span>仅预检（Dry Run）：只统计将发生的变更，不实际写入</span>
            </label>

            {/* 导入结果 */}
            {importResult && (
              <div className={`p-3 rounded-xl border text-xs space-y-1 ${
                importResult.success
                  ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                  : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
              }`}>
                <div className="font-semibold">
                  {importResult.dryRun ? '预检结果（未写入）' : importResult.success ? '导入完成' : '导入完成（部分失败）'}
                </div>
                <div>
                  文件共 {importResult.summary.totalItems} 条：
                  {importResult.dryRun ? '将' : ''}新增 {importResult.importedCount} 条，
                  {importResult.dryRun ? '将' : ''}覆盖更新 {importResult.updatedCount} 条，
                  跳过 {importResult.skippedCount} 条
                  {importResult.errorCount > 0 && `，失败 ${importResult.errorCount} 条`}
                </div>
                {importResult.summary.invalidItems > 0 && (
                  <div className="text-amber-300">另有 {importResult.summary.invalidItems} 条未通过校验被拒绝</div>
                )}
                {importResult.errors?.length > 0 && (
                  <ul className="list-disc list-inside text-rose-300 mt-1">
                    {importResult.errors.slice(0, 5).map((e: any, i: number) => (
                      <li key={i}>{e.title}：{e.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end space-x-2">
              <button
                onClick={() => setShowImport(false)}
                disabled={importing}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold"
              >
                关闭
              </button>
              <button
                onClick={handleImport}
                disabled={!importFile || importing}
                className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
              >
                {importing && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{importing ? '处理中...' : importDryRun ? '开始预检' : '开始导入'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
