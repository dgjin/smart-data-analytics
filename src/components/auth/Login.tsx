import React, { useState } from 'react';
import { Sparkles, LogIn, AlertCircle, RefreshCw } from 'lucide-react';
import { useAuthStore } from '../../hooks/useAuthStore';

export const Login: React.FC = () => {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message || '登录失败，请稍后重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-slate-100 font-sans antialiased">
      <div className="w-full max-w-sm mx-4">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8 space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-extrabold tracking-tight text-slate-100">
              智能问数分析系统
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              多源数据集成 • 自然语言交互 • 自动可视化
            </p>
          </div>
        </div>

        {/* Login Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-2xl"
        >
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoFocus
              autoComplete="username"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {error && (
            <div className="flex items-center space-x-2 p-3 rounded-xl bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={!username.trim() || !password || isSubmitting}
            className="w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-indigo-600/30 transition-all"
          >
            {isSubmitting ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <LogIn className="w-4 h-4" />
            )}
            <span>{isSubmitting ? '登录中…' : '登 录'}</span>
          </button>

          <p className="text-[11px] text-slate-500 text-center leading-relaxed">
            初始管理员账号：admin / admin123<br />
            登录后请尽快在系统管理中修改默认密码
          </p>
        </form>
      </div>
    </div>
  );
};
