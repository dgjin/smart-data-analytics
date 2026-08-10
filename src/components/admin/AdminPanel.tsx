import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  UserPlus,
  RefreshCw,
  KeyRound,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Users,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';
import { UserRole } from '../../types/analytics';

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  lastLoginAt: string | null;
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: '管理员',
  ANALYST: '分析师',
  VIEWER: '只读用户',
};

const ROLE_BADGE: Record<UserRole, string> = {
  ADMIN: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  ANALYST: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  VIEWER: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

export const AdminPanel: React.FC = () => {
  const currentUser = useAuthStore((s) => s.user);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create form
  const [isCreating, setIsCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('ANALYST');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

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
    const pwd = window.prompt(`为用户 ${u.username} 设置新密码（6-64 位）:`);
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
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 md:p-8 space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center space-x-2 text-amber-400 text-xs font-semibold uppercase tracking-wider">
            <ShieldCheck className="w-4 h-4" />
            <span>系统管理 · 仅管理员可见</span>
          </div>
          <h1 className="text-xl md:text-2xl font-extrabold text-slate-100 tracking-tight">
            用户与权限管理 (User Management)
          </h1>
          <p className="text-xs text-slate-400">
            管理系统账号与角色：管理员（全部权限）、分析师（查询与报表）、只读用户（仅查看）。
          </p>
        </div>

        <button
          onClick={() => setIsCreating((v) => !v)}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          <span>创建账号</span>
        </button>
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
          {notice.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Create User Form */}
      {isCreating && (
        <form
          onSubmit={handleCreate}
          className="bg-slate-900 border border-indigo-500/40 rounded-2xl p-6 space-y-4 shadow-2xl"
        >
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2 border-b border-slate-800 pb-3">
            <UserPlus className="w-4 h-4 text-indigo-400" />
            <span>创建新账号</span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">用户名 (3-20位字母/数字/下划线):</label>
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="例如: zhangsan"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">显示名称:</label>
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="例如: 张三"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">初始密码 (6-64 位):</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="初始密码"
                autoComplete="new-password"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">角色:</label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as UserRole)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="ANALYST">分析师（查询+报表）</option>
                <option value="VIEWER">只读用户（仅查看）</option>
                <option value="ADMIN">管理员（全部权限）</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
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
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow"
            >
              {isSubmitting ? '创建中…' : '确认创建'}
            </button>
          </div>
        </form>
      )}

      {/* Users Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-xs font-bold text-slate-300">
            <Users className="w-4 h-4 text-indigo-400" />
            <span>系统账号列表（{users.length}）</span>
          </div>
          <button
            onClick={() => {
              setIsLoading(true);
              loadUsers();
            }}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-5 py-3 font-medium">用户名</th>
                <th className="px-5 py-3 font-medium">显示名称</th>
                <th className="px-5 py-3 font-medium">角色</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">最近登录</th>
                <th className="px-5 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = currentUser?.id === u.id;
                return (
                  <tr
                    key={u.id}
                    className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="px-5 py-3 font-mono text-slate-200">
                      {u.username}
                      {isSelf && (
                        <span className="ml-2 text-[10px] text-indigo-300 bg-indigo-500/15 px-1.5 py-0.5 rounded">
                          当前账号
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">{u.displayName}</td>
                    <td className="px-5 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${ROLE_BADGE[u.role]}`}
                      >
                        {ROLE_LABELS[u.role]}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          u.status === 'ACTIVE'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-rose-500/15 text-rose-300'
                        }`}
                      >
                        {u.status === 'ACTIVE' ? '启用中' : '已禁用'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => handleToggleStatus(u)}
                          disabled={isSelf}
                          title={isSelf ? '不能禁用当前登录账号' : ''}
                          className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                            u.status === 'ACTIVE'
                              ? 'border-rose-800/60 text-rose-300 hover:bg-rose-950/40'
                              : 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40'
                          }`}
                        >
                          {u.status === 'ACTIVE' ? '禁用' : '启用'}
                        </button>
                        <button
                          onClick={() => handleResetPassword(u)}
                          className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-[11px] font-medium transition-colors"
                        >
                          <KeyRound className="w-3 h-3" />
                          <span>重置密码</span>
                        </button>
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={isSelf}
                          title={isSelf ? '不能删除当前登录账号' : ''}
                          className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>删除</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-500">
                    暂无用户数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
