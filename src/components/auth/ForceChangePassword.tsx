import React, { useState } from 'react';
import { ShieldAlert, KeyRound, RefreshCw, AlertCircle, LogOut } from 'lucide-react';
import { useAuthStore } from '../../hooks/useAuthStore';
import { apiFetch } from '../../api/client';

/**
 * P0-1 强制改密页：首登（初始密码/管理员重置）后必须修改密码才能进入系统。
 * 服务端 authMiddleware 会拦截一切业务接口，本页走 /api/auth/change-password（放行白名单）。
 */
export const ForceChangePassword: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const clearMustChangePassword = useAuthStore((s) => s.clearMustChangePassword);
  const logout = useAuthStore((s) => s.logout);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const valid =
    oldPassword && newPassword.length >= 8 && newPassword === confirmPassword && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '修改失败');
      clearMustChangePassword();
    } catch (err: any) {
      setError(err.message || '密码修改失败，请稍后重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-100 font-sans antialiased">
      <div className="w-full max-w-sm mx-4">
        <div className="flex flex-col items-center mb-8 space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-600 via-amber-500 to-orange-400 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <ShieldAlert className="w-7 h-7 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-extrabold tracking-tight text-slate-100">
              首次登录请修改密码
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              {user?.displayName || user?.username}，为保障账号安全，使用系统前需设置新密码
            </p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-2xl"
        >
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">原密码（初始密码）</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="请输入当前密码"
              autoFocus
              autoComplete="current-password"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="8-64 位，需包含字母和数字"
              autoComplete="new-password"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码"
              autoComplete="new-password"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="text-[11px] text-rose-400">两次输入的新密码不一致</p>
            )}
          </div>

          {error && (
            <div className="flex items-center space-x-2 p-3 rounded-xl bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={!valid}
            className="w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-amber-600/30 transition-all"
          >
            {isSubmitting ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <KeyRound className="w-4 h-4" />
            )}
            <span>{isSubmitting ? '提交中…' : '设置新密码并进入系统'}</span>
          </button>

          <button
            type="button"
            onClick={logout}
            className="w-full flex items-center justify-center space-x-1 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>退出登录</span>
          </button>
        </form>
      </div>
    </div>
  );
};
