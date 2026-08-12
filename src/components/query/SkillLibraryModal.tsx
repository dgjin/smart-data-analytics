/**
 * 技能库管理弹窗（P2-A Skills 增强）。
 * - 我的技能库：所有用户可维护自己的技能（新增/编辑/删除），并可发起分享至系统库
 * - 系统技能库：全员只读浏览；管理员可新增/编辑/删除
 * - 待审核分享（管理员）：批准（复制进系统库）或拒绝（退回私有）
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Library, Plus, Pencil, Trash2, X, RefreshCw, Share2, Check, Ban, Undo2, Globe, User as UserIcon } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';

interface SkillItem {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  placeholders: string[];
  scope: 'USER' | 'SYSTEM';
  status: 'ACTIVE' | 'PENDING_SHARE';
  createdBy: string;
}

type TabKey = 'my' | 'system' | 'pending';

/** 与服务端 extractPlaceholders 一致的 {{占位符}} 提取（表单实时预览用） */
function extractPlaceholders(template: string): string[] {
  const out: string[] = [];
  const re = /{{\s*([^}]+?)\s*}}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template || '')) !== null) {
    const key = m[1].trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export const SkillLibraryModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const [tab, setTab] = useState<TabKey>('my');
  const [mySkills, setMySkills] = useState<SkillItem[]>([]);
  const [systemSkills, setSystemSkills] = useState<SkillItem[]>([]);
  const [pendingShares, setPendingShares] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 表单态：null = 收起；'new' = 新增；否则为编辑中的技能 id
  const [formTarget, setFormTarget] = useState<string | null>(null);
  const [formScope, setFormScope] = useState<'USER' | 'SYSTEM'>('USER');
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formTemplate, setFormTemplate] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/skills/manage');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载技能库失败');
      setMySkills(data.mySkills || []);
      setSystemSkills(data.systemSkills || []);
      setPendingShares(data.pendingShares || []);
    } catch (err: any) {
      setError(err.message || '加载技能库失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  if (!isOpen) return null;

  const closeForm = () => {
    setFormTarget(null);
    setFormName('');
    setFormDesc('');
    setFormTemplate('');
  };

  const openCreate = (scope: 'USER' | 'SYSTEM') => {
    closeForm();
    setFormScope(scope);
    setFormTarget('new');
  };

  const openEdit = (sk: SkillItem) => {
    setFormScope(sk.scope);
    setFormName(sk.name);
    setFormDesc(sk.description);
    setFormTemplate(sk.promptTemplate);
    setFormTarget(sk.id);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ name: formName, description: formDesc, promptTemplate: formTemplate });
      const isEdit = formTarget !== 'new';
      const res = await apiFetch(isEdit ? `/api/skills/${formTarget}` : '/api/skills', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      setNotice(isEdit ? '技能已更新' : '技能已创建');
      closeForm();
      await load();
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (sk: SkillItem) => {
    if (!window.confirm(`确定删除技能「${sk.name}」吗？`)) return;
    setBusyId(sk.id);
    try {
      const res = await apiFetch(`/api/skills/${sk.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '删除失败');
      setNotice('技能已删除');
      await load();
    } catch (err: any) {
      setError(err.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const postAction = async (sk: SkillItem, path: string, okMsg: string) => {
    setBusyId(sk.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/skills/${sk.id}${path}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      setNotice(okMsg);
      await load();
    } catch (err: any) {
      setError(err.message || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const formPlaceholders = extractPlaceholders(formTemplate);

  const renderSkillRow = (sk: SkillItem, actions: React.ReactNode) => (
    <div key={sk.id} className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center space-x-2 min-w-0">
          <span className="font-semibold text-slate-100 text-sm truncate">{sk.name}</span>
          {sk.scope === 'SYSTEM' ? (
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-300 text-[10px] flex items-center space-x-0.5">
              <Globe className="w-2.5 h-2.5" />
              <span>系统</span>
            </span>
          ) : (
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-indigo-950/60 border border-indigo-600/40 text-indigo-300 text-[10px] flex items-center space-x-0.5">
              <UserIcon className="w-2.5 h-2.5" />
              <span>个人</span>
            </span>
          )}
          {sk.status === 'PENDING_SHARE' && (
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-600/40 text-amber-300 text-[10px]">
              分享审核中
            </span>
          )}
        </div>
        <div className="flex items-center space-x-1 shrink-0">{actions}</div>
      </div>
      {sk.description && <div className="text-xs text-slate-400">{sk.description}</div>}
      <div className="text-[11px] text-slate-500 font-mono bg-slate-950/60 rounded-lg px-2 py-1.5 border border-slate-800/60 whitespace-pre-wrap">
        {sk.promptTemplate}
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>
          {sk.placeholders.length > 0 ? `占位符: ${sk.placeholders.map((p) => `{{${p}}}`).join(' ')}` : '无占位符'}
        </span>
        <span>维护人: {sk.createdBy}</span>
      </div>
    </div>
  );

  const iconBtn = 'p-1.5 rounded-lg border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-slate-950 border border-slate-700 rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center space-x-2">
            <Library className="w-5 h-5 text-indigo-400" />
            <h3 className="font-bold text-slate-100">技能库管理</h3>
            <span className="text-[11px] text-slate-500">个人技能可分享至系统默认库（管理员审核）</span>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => load()}
              title="刷新"
              className={`${iconBtn} border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className={`${iconBtn} border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Tab 切换 */}
        <div className="flex items-center space-x-1 px-5 pt-3">
          {(
            [
              { key: 'my', label: `我的技能库 (${mySkills.length})` },
              { key: 'system', label: `系统技能库 (${systemSkills.length})` },
              ...(isAdmin ? [{ key: 'pending', label: `待审核分享 (${pendingShares.length})` }] : []),
            ] as { key: TabKey; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-t-lg text-xs font-medium transition-colors ${
                tab === t.key
                  ? 'bg-slate-900 text-indigo-300 border border-b-0 border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 提示条 */}
        {error && (
          <div className="mx-5 mt-2 p-2 rounded-lg bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs">{error}</div>
        )}
        {notice && (
          <div className="mx-5 mt-2 p-2 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-xs">{notice}</div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* 新增/编辑表单 */}
          {formTarget && (
            <form onSubmit={handleSubmit} className="p-3 rounded-xl bg-indigo-950/30 border border-indigo-600/40 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-indigo-300">
                  {formTarget === 'new'
                    ? formScope === 'SYSTEM'
                      ? '新增系统技能'
                      : '新增个人技能'
                    : `编辑技能（${formScope === 'SYSTEM' ? '系统' : '个人'}）`}
                </span>
                <button type="button" onClick={closeForm} className="text-slate-400 hover:text-slate-200">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="技能名称（如：按人员拜访量排名）"
                maxLength={100}
                required
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <input
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="技能描述（一句话说明适用场景）"
                maxLength={500}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <textarea
                value={formTemplate}
                onChange={(e) => setFormTemplate(e.target.value)}
                placeholder="提问模板，用 {{占位符}} 标记需要替换的部分，如：请统计各{{人员}}的客户拜访次数"
                maxLength={1000}
                required
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
              />
              {formPlaceholders.length > 0 && (
                <div className="text-[11px] text-slate-400">
                  识别到占位符: {formPlaceholders.map((p) => `{{${p}}}`).join(' ')}
                </div>
              )}
              <div className="flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:bg-slate-800"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50"
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </form>
          )}

          {/* 我的技能库 */}
          {tab === 'my' && (
            <>
              {!formTarget && (
                <button
                  onClick={() => openCreate('USER')}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新建我的技能</span>
                </button>
              )}
              {mySkills.length === 0 && !formTarget && (
                <div className="text-center py-8 text-slate-500 text-xs">
                  还没有个人技能。把高频提问沉淀为技能模板，一键复用。
                </div>
              )}
              {mySkills.map((sk) =>
                renderSkillRow(
                  sk,
                  <>
                    {sk.status === 'ACTIVE' ? (
                      <button
                        onClick={() => postAction(sk, '/share', '已提交分享申请，等待管理员审核')}
                        disabled={busyId === sk.id}
                        title="申请分享到系统默认技能库"
                        className={`${iconBtn} border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/60`}
                      >
                        <Share2 className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => postAction(sk, '/share/cancel', '已撤回分享申请')}
                        disabled={busyId === sk.id}
                        title="撤回分享申请"
                        className={`${iconBtn} border-amber-700/60 text-amber-300 hover:bg-amber-950/60`}
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => openEdit(sk)}
                      disabled={busyId === sk.id}
                      title="编辑"
                      className={`${iconBtn} border-slate-700 text-slate-300 hover:bg-slate-800`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(sk)}
                      disabled={busyId === sk.id}
                      title="删除"
                      className={`${iconBtn} border-rose-700/60 text-rose-300 hover:bg-rose-950/60`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )
              )}
            </>
          )}

          {/* 系统技能库 */}
          {tab === 'system' && (
            <>
              {isAdmin && !formTarget && (
                <button
                  onClick={() => openCreate('SYSTEM')}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新增系统技能</span>
                </button>
              )}
              {!isAdmin && (
                <div className="text-[11px] text-slate-500">系统默认技能库由管理员维护，全员可在问数面板使用。</div>
              )}
              {systemSkills.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-xs">系统技能库暂无技能。</div>
              )}
              {systemSkills.map((sk) =>
                renderSkillRow(
                  sk,
                  isAdmin ? (
                    <>
                      <button
                        onClick={() => openEdit(sk)}
                        disabled={busyId === sk.id}
                        title="编辑"
                        className={`${iconBtn} border-slate-700 text-slate-300 hover:bg-slate-800`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(sk)}
                        disabled={busyId === sk.id}
                        title="删除"
                        className={`${iconBtn} border-rose-700/60 text-rose-300 hover:bg-rose-950/60`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : null
                )
              )}
            </>
          )}

          {/* 待审核分享（管理员） */}
          {tab === 'pending' && isAdmin && (
            <>
              {pendingShares.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-xs">暂无待审核的分享申请。</div>
              )}
              {pendingShares.map((sk) =>
                renderSkillRow(
                  sk,
                  <>
                    <button
                      onClick={() => postAction(sk, '/share/approve', '已批准，该技能已进入系统库')}
                      disabled={busyId === sk.id}
                      title="批准：复制进系统技能库"
                      className={`${iconBtn} border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/60 flex items-center space-x-1`}
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>批准</span>
                    </button>
                    <button
                      onClick={() => postAction(sk, '/share/reject', '已拒绝，技能退回个人库')}
                      disabled={busyId === sk.id}
                      title="拒绝：退回个人技能库"
                      className={`${iconBtn} border-rose-700/60 text-rose-300 hover:bg-rose-950/60 flex items-center space-x-1`}
                    >
                      <Ban className="w-3.5 h-3.5" />
                      <span>拒绝</span>
                    </button>
                  </>
                )
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
