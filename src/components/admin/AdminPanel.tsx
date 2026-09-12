import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldCheck,
  UserPlus,
  RefreshCw,
  KeyRound,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Users,
  Gauge,
  BookMarked,
  Settings,
  Search,
  Radar,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';
import { UserRole } from '../../types/analytics';
import { LlmUsagePanel } from './LlmUsagePanel';
import { OpsMetricsPanel } from './OpsMetricsPanel';
import { DriftAlertPanel } from './DriftAlertPanel';
import { ReportTemplateManager } from './ReportTemplateManager';
import { MetricsPanel } from './MetricsPanel';
import { IronRulesPanel } from './IronRulesPanel';
import { ExpertPersonasPanel } from './ExpertPersonasPanel';
import { AccessRequestsPanel } from './AccessRequestsPanel';
import { DlpDownloadPanel } from './DlpDownloadPanel';
import { EnvironmentConfigPanel } from './EnvironmentConfigPanel';
import { FallbackApprovalPanel } from './FallbackApprovalPanel';
import { ABTestDashboard } from './ABTestDashboard';
import { PatrolPanel } from './PatrolPanel';

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  department?: string;
  role: UserRole;
  status: 'ACTIVE' | 'DISABLED';
  mustChangePassword?: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: '管理员',
  ANALYST: '分析师',
  VIEWER: '只读用户',
};

/** 系统管理分类（7 项，左栏导航切换） */
type AdminSection =
  | 'users'
  | 'permission-approval'
  | 'rule-governance'
  | 'ai-audit'
  | 'quality-monitoring'
  | 'patrol'
  | 'system-config';

/** 左栏分类导航：三域分组；color/bar 为选中态图标色与左侧色条（分类色系沿用既有编码，巡检用 orange） */
const SECTION_GROUPS: {
  label: string;
  items: { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }>; color: string; bar: string }[];
}[] = [
  {
    label: '账号与权限',
    items: [
      { id: 'users', label: '基础管理', icon: Users, color: 'text-indigo-400', bar: 'bg-indigo-500' },
      { id: 'permission-approval', label: '权限审批', icon: ShieldCheck, color: 'text-amber-400', bar: 'bg-amber-500' },
    ],
  },
  {
    label: '治理与审核',
    items: [
      { id: 'rule-governance', label: '规则治理', icon: BookMarked, color: 'text-cyan-400', bar: 'bg-cyan-500' },
      { id: 'ai-audit', label: 'AI 审核', icon: Search, color: 'text-rose-400', bar: 'bg-rose-500' },
    ],
  },
  {
    label: '运维与系统',
    items: [
      { id: 'quality-monitoring', label: '质量监控', icon: Gauge, color: 'text-emerald-400', bar: 'bg-emerald-500' },
      { id: 'patrol', label: '异常巡检', icon: Radar, color: 'text-orange-400', bar: 'bg-orange-500' },
      { id: 'system-config', label: '系统配置', icon: Settings, color: 'text-slate-300', bar: 'bg-slate-500' },
    ],
  },
];

export const AdminPanel: React.FC = () => {
  const currentUser = useAuthStore((s) => s.user);

  // 左栏分类切换：7 个分类（三域分组见 SECTION_GROUPS），默认「基础管理」
  const [section, setSection] = useState<AdminSection>('users');
  const contentRef = useRef<HTMLDivElement>(null);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create form
  const [isCreating, setIsCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDepartment, setNewDepartment] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('ANALYST');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 切换分类时将右栏内容区滚动回顶
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  // 初始 isLoading=true 覆盖首次加载；手动刷新时在按钮 onClick 里先 setIsLoading(true)
  const loadUsers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/users');
      const data = await res.json();
      if (data.success) {
        setUsers(data.users);
      } else {
        showNotice('error', data.error || '加载用户列表失败');
      }
    } catch (err: any) {
      showNotice('error', err.message || '加载用户列表失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => loadUsers(), 0);
    return () => clearTimeout(timer);
  }, [loadUsers]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername.trim(),
          displayName: newDisplayName.trim() || newUsername.trim(),
          password: newPassword,
          department: newDepartment.trim(),
          role: newRole,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '创建失败');
      showNotice('success', `用户 ${newUsername.trim()} 创建成功`);
      setIsCreating(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      setNewDepartment('');
      setNewRole('ANALYST');
      loadUsers();
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleStatus = async (u: AdminUser) => {
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      showNotice('success', next === 'ACTIVE' ? `已启用 ${u.username}` : `已禁用 ${u.username}`);
      loadUsers();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleResetPassword = async (u: AdminUser) => {
    const pwd = window.prompt(`为用户 ${u.username} 设置新密码（8-64 位，需包含字母和数字，重置后该用户下次登录需改密）:`);
    if (!pwd) return;
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: pwd }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '重置失败');
      showNotice('success', `已重置 ${u.username} 的密码`);
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleEditDepartment = async (u: AdminUser) => {
    const input = window.prompt(`修改用户 ${u.username} 的所属部门（数据源授权按部门匹配，留空为未设置）:`, u.department || '');
    if (input === null) return;
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      showNotice('success', `已更新 ${u.username} 的部门为「${input.trim() || '未设置'}」`);
      loadUsers();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  const handleDelete = async (u: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${u.username}（${u.displayName}）？此操作不可恢复。`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
      showNotice('success', `已删除用户 ${u.username}`);
      loadUsers();
    } catch (err: any) {
      showNotice('error', err.message);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 紧凑页头 */}
      <div className="flex items-center space-x-3 px-6 py-4 border-b border-slate-800/60 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
          <ShieldCheck className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-base font-bold text-slate-100">系统管理</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            账号、治理、监控与系统配置的一体化管理控制台
          </p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 左栏分类导航（三域分组，窄屏收窄为图标列） */}
        <nav className="w-14 md:w-52 shrink-0 border-r border-slate-800/60 overflow-y-auto p-2 md:p-3 space-y-3 md:space-y-4">
          {SECTION_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="hidden md:block px-2 py-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = section === item.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSection(item.id)}
                      title={item.label}
                      className={`relative w-full flex items-center justify-center md:justify-start space-x-2 px-2 md:px-2.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                        active
                          ? 'bg-slate-800/80 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                      }`}
                    >
                      {active && <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${item.bar}`} />}
                      <Icon className={`w-4 h-4 shrink-0 ${active ? item.color : ''}`} />
                      <span className="hidden md:inline">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* 右栏内容区（独立滚动，切换分类自动回顶） */}
        <div ref={contentRef} className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Notice */}
          {notice && (
            <div className={`p-4 rounded-xl border ${
              notice.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
            }`}>
              <div className="flex items-center gap-2">
                {notice.type === 'success' ? (
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                ) : (
                  <AlertCircle className="w-5 h-5 shrink-0" />
                )}
                <span>{notice.text}</span>
              </div>
            </div>
          )}

      {/* ============ 区块一：用户管理 ============ */}
      {section === 'users' && (
        <div className="space-y-6">
          {/* 创建账号表单 */}
          {isCreating && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center space-x-2 mb-6 pb-4 border-b border-slate-800">
                <UserPlus className="w-5 h-5 text-indigo-400" />
                <h3 className="text-lg font-bold text-slate-100">创建新账号</h3>
              </div>
      
              <form onSubmit={handleCreate}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">用户名 <span className="text-slate-500">(3-20 位)</span></label>
                    <input
                      type="text"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder="zhangsan"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">显示名称</label>
                    <input
                      type="text"
                      value={newDisplayName}
                      onChange={(e) => setNewDisplayName(e.target.value)}
                      placeholder="张三"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">初始密码</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="••••••"
                      autoComplete="new-password"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono transition-colors"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">部门</label>
                    <input
                      type="text"
                      value={newDepartment}
                      onChange={(e) => setNewDepartment(e.target.value)}
                      placeholder="财务部"
                      maxLength={100}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-slate-400 font-medium">角色</label>
                    <select
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value as UserRole)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    >
                      <option value="ANALYST">分析师</option>
                      <option value="VIEWER">只读用户</option>
                      <option value="ADMIN">管理员</option>
                    </select>
                  </div>
                </div>
      
                <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-slate-700"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={
                      isSubmitting ||
                      !/^[a-zA-Z0-9_]{3,20}$/.test(newUsername.trim()) ||
                      newPassword.length < 6
                    }
                    className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold shadow-lg shadow-indigo-600/30 transition-all"
                  >
                    {isSubmitting ? '创建中…' : '确认创建'}
                  </button>
                </div>
              </form>
            </div>
          )}
      
          {/* 用户列表卡片 */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            {/* 卡片头部 */}
            <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Users className="w-5 h-5 text-indigo-400" />
                  系统账号列表
                </h3>
                <p className="text-xs text-slate-500 mt-1">共 {users.length} 个账号</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    placeholder="搜索用户..."
                    className="w-64 pl-10 pr-4 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-300 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  />
                </div>
                <button
                  onClick={() => setIsCreating((v) => !v)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-sm font-semibold shadow-lg shadow-indigo-600/30 transition-all group border border-indigo-500/50"
                >
                  <UserPlus className="w-4 h-4 group-hover:scale-110 transition-transform" />
                  <span>创建账号</span>
                </button>
              </div>
            </div>
      
            {/* 表格区域 */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-950">
                  <tr>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">用户名 / 显示名</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">部门</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">角色</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">状态</th>
                    <th className="px-6 py-3 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">最近登录</th>
                    <th className="px-6 py-3 text-right text-[10px] font-medium text-slate-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {isLoading ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center">
                        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
                        <p className="text-sm text-slate-500">加载中...</p>
                      </td>
                    </tr>
                  ) : users.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center">
                        <Users className="w-12 h-12 mx-auto mb-3 text-slate-600" />
                        <p className="text-sm text-slate-500">暂无用户数据</p>
                      </td>
                    </tr>
                  ) : (
                    users.map((u) => {
                      const isSelf = u.id === currentUser?.id;
                      return (
                        <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white font-bold text-sm shrink-0 shadow-lg">
                                {u.displayName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="text-sm font-semibold text-slate-200">{u.username}</div>
                                  {isSelf && (
                                    <span className="text-[9px] text-indigo-300 bg-indigo-500/20 px-1.5 py-0.5 rounded border border-indigo-500/30">
                                      当前账号
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-500">{u.displayName}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-400">
                            <button
                              onClick={() => handleEditDepartment(u)}
                              className="hover:text-indigo-400 hover:underline transition-colors"
                            >
                              {u.department || <span className="text-slate-600 italic">未设置</span>}
                            </button>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                              u.role === 'ADMIN'
                                ? 'bg-violet-500/10 text-violet-300 border-violet-500/30'
                                : u.role === 'ANALYST'
                                ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                                : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                            }`}>
                              {ROLE_LABELS[u.role]}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                              u.status === 'ACTIVE'
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                            }`}>
                              {u.status === 'ACTIVE' ? '启用中' : '已禁用'}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500 font-mono">
                            {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleToggleStatus(u)}
                                disabled={isSelf}
                                title={isSelf ? '不能禁用当前登录账号' : ''}
                                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                  u.status === 'ACTIVE'
                                    ? 'border-rose-800/60 text-rose-400 hover:bg-rose-950/30'
                                    : 'border-emerald-800/60 text-emerald-400 hover:bg-emerald-950/30'
                                }`}
                              >
                                {u.status === 'ACTIVE' ? '禁用' : '启用'}
                              </button>
                              <button
                                onClick={() => handleResetPassword(u)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-300 text-xs font-medium transition-colors"
                              >
                                <KeyRound className="w-3 h-3" />
                                <span>重置</span>
                              </button>
                              <button
                                onClick={() => handleDelete(u)}
                                disabled={isSelf}
                                title={isSelf ? '不能删除当前登录账号' : ''}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-800/60 text-rose-400 hover:bg-rose-950/30 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Trash2 className="w-3 h-3" />
                                <span>删除</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      
      {/* ============ 区块二：质量监控 (P0-4 北极星 +ABTest+Token 用量) ============ */}
      {section === 'quality-monitoring' && (
        <div className="space-y-6">
          {/* P3-3 知识库漂移提醒（枚举值快照比对） */}
          <DriftAlertPanel />
          <OpsMetricsPanel />
          <LlmUsagePanel />
          <ABTestDashboard />
        </div>
      )}
      
      {/* ============ 区块三：规则治理 (指标 + 铁律 + 专家角色) ============ */}
      {section === 'rule-governance' && (
        <div className="space-y-6">
          {/* 指标层治理（P1-8 提议 - 审批 - 版本化） */}
          <MetricsPanel />
          {/* 铁律规则库（v0.9.35 全量恒注入强制约束） */}
          <IronRulesPanel />
          {/* 问数专家角色（v0.9.40 阶段二解读 persona 路由配置） */}
          <ExpertPersonasPanel />
        </div>
      )}
      
      {/* ============ 区块四：权限审批 (权限审批 + 报告模板) ============ */}
      {section === 'permission-approval' && (
        <div className="space-y-5">
          {/* 数据源权限审批（P2-11 申请 - 审批 - 授权） */}
          <AccessRequestsPanel />
          {/* 报告模板管理（v0.5.0） */}
          <ReportTemplateManager />
        </div>
      )}
      
      {/* ============ 区块五：AI 审核 (Fallback 审核 + DLP 下载审批) ============ */}
      {section === 'ai-audit' && (
        <div className="space-y-5">
          {/* NL2SQL Fallback 困难样本审核（v0.9.44 Strategy C） */}
          <FallbackApprovalPanel />
          {/* P2-12 DLP 数据导出审批（超阈值下载申请） */}
          <DlpDownloadPanel />
        </div>
      )}
      
      {/* ============ 区块六：系统配置 (环境配置 + 系统设置) ============ */}
      {section === 'system-config' && <EnvironmentConfigPanel />}

      {/* ============ 区块七：异常巡检（与侧边栏「异常巡检」页共用 PatrolPanel，双入口） ============ */}
      {section === 'patrol' && <PatrolPanel />}
        </div>
      </div>
    </div>
  );
};
