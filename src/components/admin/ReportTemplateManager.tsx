import React, { useCallback, useEffect, useState } from 'react';
import {
  FileText,
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  Lock,
  X,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { ReportTemplate } from '../../types/analytics';

/**
 * v0.5.0 报告模板管理（系统管理 · 报告模板页签）
 * 预设模板（isPreset=true）不可编辑/删除；自定义模板支持新增/编辑/删除。
 * 模板内容结构：{ sections: [{ title, prompt, chartType }] }
 */

interface TemplateSection {
  title: string;
  prompt: string;
  chartType: string;
}

const CHART_TYPE_CHOICES = ['bar', 'line', 'pie', 'table', 'number'] as const;

const emptySection = (): TemplateSection => ({ title: '', prompt: '', chartType: 'bar' });

export const ReportTemplateManager: React.FC = () => {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 编辑状态：null=不编辑；'new'=新增；数字=编辑对应 id
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formSections, setFormSections] = useState<TemplateSection[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await apiFetch('/api/report-templates');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '加载失败');
      setTemplates(data.templates);
    } catch (err: any) {
      showNotice('error', err?.message || '模板列表加载失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const resetForm = () => {
    setEditing(null);
    setFormName('');
    setFormDescription('');
    setFormSections([]);
  };

  const startCreate = () => {
    setEditing('new');
    setFormName('');
    setFormDescription('');
    setFormSections([emptySection()]);
  };

  const startEdit = (tpl: ReportTemplate) => {
    if (tpl.isPreset) return;
    setEditing(tpl.id);
    setFormName(tpl.name);
    setFormDescription(tpl.description);
    try {
      const parsed = JSON.parse(tpl.templateContent);
      const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
      setFormSections(
        sections.map((s: any) => ({
          title: typeof s?.title === 'string' ? s.title : '',
          prompt: typeof s?.prompt === 'string' ? s.prompt : '',
          chartType: typeof s?.chartType === 'string' ? s.chartType : 'bar',
        }))
      );
    } catch {
      setFormSections([emptySection()]);
    }
  };

  const updateSection = (idx: number, patch: Partial<TemplateSection>) => {
    setFormSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const removeSection = (idx: number) => {
    setFormSections((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      showNotice('error', '模板名称不能为空');
      return;
    }
    const validSections = formSections.filter((s) => s.title.trim() && s.prompt.trim());
    if (validSections.length === 0) {
      showNotice('error', '至少需要一个包含标题与提示词的章节');
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = {
        name: formName.trim(),
        description: formDescription.trim(),
        templateContent: JSON.stringify({ sections: validSections }),
      };
      const isNew = editing === 'new';
      const res = await apiFetch(isNew ? '/api/report-templates' : `/api/report-templates/${editing}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || (isNew ? '创建失败' : '保存失败'));
      showNotice('success', isNew ? `模板「${formName}」已创建` : `模板「${formName}」已更新`);
      resetForm();
      loadTemplates();
    } catch (err: any) {
      showNotice('error', err?.message || '操作失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (tpl: ReportTemplate) => {
    if (tpl.isPreset) return;
    if (!window.confirm(`确认删除模板「${tpl.name}」？此操作不可恢复。`)) return;
    try {
      const res = await apiFetch(`/api/report-templates/${tpl.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败');
      showNotice('success', `模板「${tpl.name}」已删除`);
      loadTemplates();
    } catch (err: any) {
      showNotice('error', err?.message || '删除失败');
    }
  };

  return (
    <div className="space-y-4">
      {/* Notice */}
      {notice && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400">
          共 {templates.length} 个模板（{templates.filter((t) => t.isPreset).length} 个系统预设）
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => {
              setIsLoading(true);
              loadTemplates();
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>刷新</span>
          </button>
          <button
            onClick={startCreate}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增模板</span>
          </button>
        </div>
      </div>

      {/* 模板列表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="text-left px-5 py-3 font-semibold">模板名称</th>
              <th className="text-left px-5 py-3 font-semibold">描述</th>
              <th className="text-left px-5 py-3 font-semibold">类型</th>
              <th className="text-left px-5 py-3 font-semibold">创建人</th>
              <th className="text-left px-5 py-3 font-semibold">创建时间</th>
              <th className="text-right px-5 py-3 font-semibold">操作</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((tpl) => (
              <tr key={tpl.id} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                <td className="px-5 py-3 min-w-[160px]">
                  <div className="flex items-center space-x-2">
                    <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="font-semibold text-slate-200 whitespace-nowrap">{tpl.name}</span>
                  </div>
                </td>
                <td className="px-5 py-3 text-slate-400 max-w-xs truncate" title={tpl.description}>
                  {tpl.description || '—'}
                </td>
                <td className="px-5 py-3">
                  {tpl.isPreset ? (
                    <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px]">
                      <Lock className="w-2.5 h-2.5" />
                      <span>系统预设</span>
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[10px]">
                      自定义
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-slate-400">{tpl.createdBy || '—'}</td>
                <td className="px-5 py-3 text-slate-400">{new Date(tpl.createdAt).toLocaleString('zh-CN')}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end space-x-1.5">
                    <button
                      onClick={() => startEdit(tpl)}
                      disabled={tpl.isPreset}
                      title={tpl.isPreset ? '预设模板不可编辑' : '编辑模板'}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-300 hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(tpl)}
                      disabled={tpl.isPreset}
                      title={tpl.isPreset ? '预设模板不可删除' : '删除模板'}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!isLoading && templates.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-slate-500">
                  暂无模板数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 编辑弹窗 */}
      {editing !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 shrink-0">
              <h3 className="text-sm font-bold text-slate-100">
                {editing === 'new' ? '新增报告模板' : '编辑报告模板'}
              </h3>
              <button
                onClick={resetForm}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">模板名称 *</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  maxLength={100}
                  placeholder="例如：区域经营分析"
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">模板描述</label>
                <input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  maxLength={500}
                  placeholder="模板适用场景说明（可选）"
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-300">报告章节 *</label>
                  <button
                    onClick={() => setFormSections((prev) => [...prev, emptySection()])}
                    className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[11px] transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    <span>添加章节</span>
                  </button>
                </div>
                {formSections.map((sec, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/80 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-400">章节 {idx + 1}</span>
                      <button
                        onClick={() => removeSection(idx)}
                        disabled={formSections.length <= 1}
                        className="p-1 rounded text-slate-500 hover:text-rose-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <input
                      value={sec.title}
                      onChange={(e) => updateSection(idx, { title: e.target.value })}
                      placeholder="章节标题（例如：核心指标概览）"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                    />
                    <textarea
                      value={sec.prompt}
                      onChange={(e) => updateSection(idx, { prompt: e.target.value })}
                      placeholder="分析提示词（例如：统计各机构当年投放金额与回现金额，按金额降序排列）"
                      rows={2}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-indigo-500 resize-y"
                    />
                    <select
                      value={sec.chartType}
                      onChange={(e) => updateSection(idx, { chartType: e.target.value })}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                    >
                      {CHART_TYPE_CHOICES.map((ct) => (
                        <option key={ct} value={ct}>
                          图表类型：{ct}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end space-x-2 px-5 py-3.5 border-t border-slate-800 shrink-0">
              <button
                onClick={resetForm}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {isSubmitting ? '提交中…' : editing === 'new' ? '创建模板' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
