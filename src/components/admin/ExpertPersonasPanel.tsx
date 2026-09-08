import React, { useCallback, useEffect, useState } from 'react';
import {
  UserCog,
  RefreshCw,
  Plus,
  CheckCircle2,
  AlertCircle,
  Trash2,
  X,
  Pencil,
  Lock,
} from 'lucide-react';
import { apiFetch } from '../../api/client';

/**
 * 问数专家角色面板（v0.9.40）：维护阶段二解读的 persona 路由配置（角色标签/触发关键词/rolePrompt）。
 * 问数时按问题文本对生效中角色按「优先级升序」做关键词包含匹配，首个命中生效；
 * 均未命中时使用「默认角色」（default，不参与匹配，不可禁用/删除）。
 * 仅 ADMIN 可见可维护（本面板挂载于系统管理内），保存即生效（服务端缓存即时失效）；
 * 内置角色可编辑但不可删除，防止误删导致路由缺口。
 */

type PersonaStatus = 'ACTIVE' | 'DISABLED';

interface PersonaItem {
  id: number;
  personaKey: string;
  label: string;
  keywords: string[];
  rolePrompt: string;
  sortOrder: number;
  status: PersonaStatus;
  isBuiltin: boolean;
  createdBy?: string;
}

interface PersonaForm {
  label: string;
  keywordsText: string;
  rolePrompt: string;
  sortOrder: string;
  status: PersonaStatus;
}

const EMPTY_FORM: PersonaForm = { label: '', keywordsText: '', rolePrompt: '', sortOrder: '100', status: 'ACTIVE' };

const STATUS_META: Record<PersonaStatus, { label: string; cls: string }> = {
  ACTIVE: { label: '生效中', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  DISABLED: { label: '已停用', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

/** 关键词文本 ↔ 数组：支持逗号/顿号/空格分隔，去重去空 */
function parseKeywords(text: string): string[] {
  const out: string[] = [];
  for (const k of text.split(/[,，、\s]+/)) {
    const t = k.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export const ExpertPersonasPanel: React.FC = () => {
  const [personas, setPersonas] = useState<PersonaItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 新建/编辑共用弹窗（editing=null 表示新建）
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PersonaItem | null>(null);
  const [form, setForm] = useState<PersonaForm>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadPersonas = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/expert-personas');
      const data = await res.json();
      if (res.ok && data.personas) {
        setPersonas(data.personas);
      } else {
        showNotice('error', data.error || '加载专家角色失败');
      }
    } catch (err: any) {
      showNotice('error', err.message || '加载专家角色失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadPersonas(), 0);
    return () => clearTimeout(timer);
  }, [loadPersonas]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (p: PersonaItem) => {
    setEditing(p);
    setForm({
      label: p.label,
      keywordsText: p.keywords.join('，'),
      rolePrompt: p.rolePrompt,
      sortOrder: String(p.sortOrder),
      status: p.status,
    });
    setShowForm(true);
  };

  const isDefaultRole = editing?.personaKey === 'default';

  const handleSave = async () => {
    if (isSaving) return;
    const payload = {
      label: form.label.trim(),
      keywords: isDefaultRole ? [] : parseKeywords(form.keywordsText),
      rolePrompt: form.rolePrompt.trim(),
      sortOrder: Number(form.sortOrder) || 100,
      status: isDefaultRole ? 'ACTIVE' : form.status,
    };
    if (!payload.label || !payload.rolePrompt) {
      showNotice('error', '角色标签与角色提示词必填');
      return;
    }
    setIsSaving(true);
    try {
      const res = editing
        ? await apiFetch(`/api/expert-personas/${editing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await apiFetch('/api/expert-personas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');
      showNotice('success', editing ? `角色「${payload.label}」已更新，即刻生效` : `角色「${payload.label}」已创建并生效`);
      setShowForm(false);
      setEditing(null);
      loadPersonas();
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (p: PersonaItem) => {
    const next: PersonaStatus = p.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      const res = await apiFetch(`/api/expert-personas/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: p.label, keywords: p.keywords, rolePrompt: p.rolePrompt, sortOrder: p.sortOrder, status: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '操作失败');
      showNotice('success', next === 'ACTIVE' ? `已启用「${p.label}」` : `已停用「${p.label}」（不再参与问数角色匹配）`);
      loadPersonas();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleDelete = async (p: PersonaItem) => {
    if (!window.confirm(`确认删除角色「${p.label}」？删除后问数将不再路由到该角色。`)) return;
    try {
      const res = await apiFetch(`/api/expert-personas/${p.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败');
      showNotice('success', `已删除「${p.label}」`);
      loadPersonas();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const activeCount = personas.filter((p) => p.status === 'ACTIVE').length;

  return (
    <div className="space-y-4">
      {/* 工具条 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-3">
          <UserCog className="w-4 h-4 text-violet-400" />
          <span className="text-xs font-bold text-slate-300">问数专家角色</span>
          {activeCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30 font-semibold">
              {activeCount} 个生效中
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => loadPersonas()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
          <button
            onClick={openCreate}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold shadow-lg shadow-violet-600/30 transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建角色</span>
          </button>
        </div>
      </div>

      {/* 说明条 */}
      <div className="bg-violet-950/30 border border-violet-800/40 rounded-xl px-4 py-2.5 text-[11px] text-violet-200/80 leading-relaxed">
        专家角色决定智能问数「AI 解读」的分析视角：提问命中某角色的触发关键词时，按该角色的提示词生成解读（如财务问题走财务分析师口径）。按优先级升序匹配、首个命中生效；均未命中时使用默认角色。默认角色不可停用，内置角色不可删除。
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

      {/* 角色列表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-4 py-2.5 text-left font-medium w-16">优先级</th>
                <th className="px-4 py-2.5 text-left font-medium">角色标签</th>
                <th className="px-4 py-2.5 text-left font-medium">触发关键词</th>
                <th className="px-4 py-2.5 text-left font-medium">角色提示词（rolePrompt）</th>
                <th className="px-4 py-2.5 text-left font-medium w-20">状态</th>
                <th className="px-4 py-2.5 text-right font-medium w-48">操作</th>
              </tr>
            </thead>
            <tbody>
              {personas.map((p) => {
                const meta = STATUS_META[p.status];
                const isDefault = p.personaKey === 'default';
                return (
                  <tr key={p.id} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-slate-500">{isDefault ? '兜底' : p.sortOrder}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center space-x-1.5">
                        <span className="font-semibold text-slate-200">{p.label}</span>
                        {p.isBuiltin && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">内置</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-[220px]">
                      {isDefault ? (
                        <span className="text-slate-500 text-[10px]">不参与匹配（无命中时兜底）</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {p.keywords.map((k) => (
                            <span key={k} className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[10px]">{k}</span>
                          ))}
                          {p.keywords.length === 0 && <span className="text-slate-500 text-[10px]">（无关键词，永不命中）</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-md">
                      <div className="text-slate-400 line-clamp-2 whitespace-pre-wrap" title={p.rolePrompt}>{p.rolePrompt}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button onClick={() => openEdit(p)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors">
                          <Pencil className="w-3 h-3" /><span>编辑</span>
                        </button>
                        {!isDefault && (
                          <button onClick={() => handleToggleStatus(p)} className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors ${p.status === 'ACTIVE' ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40'}`}>
                            {p.status === 'ACTIVE' ? '停用' : '启用'}
                          </button>
                        )}
                        {p.isBuiltin ? (
                          <span className="flex items-center space-x-1 px-2.5 py-1 text-slate-600 text-[11px]" title="内置角色不可删除（可编辑或停用）">
                            <Lock className="w-3 h-3" />
                          </span>
                        ) : (
                          <button onClick={() => handleDelete(p)} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors">
                            <Trash2 className="w-3 h-3" /><span>删除</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && personas.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">暂无专家角色配置（服务启动时会自动播种内置角色；异常时问数使用内置常量兜底）</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 新建/编辑弹窗 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !isSaving && setShowForm(false)}>
          <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100">{editing ? `编辑角色「${editing.label}」` : '新建专家角色'}</h3>
              <button onClick={() => !isSaving && setShowForm(false)} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">角色标签（≤50字，显示在回答卡片角标）:</label>
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  maxLength={50}
                  placeholder="如：税务分析专家"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500"
                />
              </div>
              {!isDefaultRole && (
                <>
                  <div className="space-y-1">
                    <label className="text-slate-300 font-medium">触发关键词（逗号/顿号分隔，单个 ≤30 字，最多 20 个）:</label>
                    <textarea
                      value={form.keywordsText}
                      onChange={(e) => setForm({ ...form, keywordsText: e.target.value })}
                      rows={2}
                      placeholder="如：税务，税筹，纳税，发票"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500 resize-y"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-slate-300 font-medium">匹配优先级（数字小的先匹配，0-9999）:</label>
                      <input
                        type="number"
                        value={form.sortOrder}
                        onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                        min={0}
                        max={9999}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-slate-300 font-medium">状态:</label>
                      <select
                        value={form.status}
                        onChange={(e) => setForm({ ...form, status: e.target.value as PersonaStatus })}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500"
                      >
                        <option value="ACTIVE">生效中</option>
                        <option value="DISABLED">已停用</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
              {isDefaultRole && (
                <div className="text-[10px] text-slate-500 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
                  默认角色在无关键词命中时兜底，不参与匹配，仅可修改标签与提示词。
                </div>
              )}
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">角色提示词 rolePrompt（≤500字，作为 AI 解读的身份设定）:</label>
                <textarea
                  value={form.rolePrompt}
                  onChange={(e) => setForm({ ...form, rolePrompt: e.target.value })}
                  rows={4}
                  maxLength={500}
                  placeholder="如：你是资深税务分析师。解读时聚焦税负结构、优惠政策适配与合规风险，给出税务视角的专业建议。"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-violet-500 resize-y"
                />
                <div className="text-right text-[10px] text-slate-500">{form.rolePrompt.length}/500</div>
              </div>
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setShowForm(false)} disabled={isSaving} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold">取消</button>
              <button
                onClick={handleSave}
                disabled={isSaving || !form.label.trim() || !form.rolePrompt.trim()}
                className="px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
              >
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
