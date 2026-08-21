import React, { useEffect, useState } from 'react';
import {
  Database,
  Sparkles,
  BarChart3,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  CheckCircle2,
  LogOut,
  Sun,
  Moon,
  HelpCircle,
  Lock,
  X,
} from 'lucide-react';
import { useAnalyticsStore } from '../hooks/useAnalyticsStore';
import { useAuthStore } from '../hooks/useAuthStore';
import { apiFetch } from '../api/client';
import { UserRole } from '../types/analytics';
import { getUITheme, toggleUITheme, UI_THEME_EVENT, UIThemeMode } from '../utils/uiTheme';
import { HelpModal } from './help/HelpModal';

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: '管理员',
  ANALYST: '分析师',
  VIEWER: '只读',
};

const ROLE_BADGE: Record<UserRole, string> = {
  ADMIN: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  ANALYST: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  VIEWER: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

export const Header: React.FC = () => {
  const {
    dataSources,
    activeDataSourceId,
    setActiveDataSource,
    setActiveTab,
    activeTab,
  } = useAnalyticsStore();
  const { user, logout } = useAuthStore();

  // 帮助弹窗开关
  const [helpOpen, setHelpOpen] = useState(false);

  // P2-11 权限申请：无权访问的数据源列表 + 申请弹窗
  const deniedSources = dataSources.filter((ds) => ds.accessDenied);
  const accessibleSources = dataSources.filter((ds) => !ds.accessDenied);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestTarget, setRequestTarget] = useState<string>('');
  const [requestReason, setRequestReason] = useState('');
  const [requestMsg, setRequestMsg] = useState<string | null>(null);
  const [requestSubmitting, setRequestSubmitting] = useState(false);

  const submitAccessRequest = async () => {
    if (!requestTarget || !requestReason.trim() || requestSubmitting) return;
    setRequestSubmitting(true);
    setRequestMsg(null);
    try {
      const res = await apiFetch('/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: requestTarget, reason: requestReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '申请提交失败');
      setRequestMsg('申请已提交，等待管理员审批');
      setRequestReason('');
    } catch (err: any) {
      setRequestMsg(err.message || '申请提交失败');
    } finally {
      setRequestSubmitting(false);
    }
  };

  const activeDS = accessibleSources.find((ds) => ds.id === activeDataSourceId) || dataSources.find((ds) => ds.id === activeDataSourceId);

  // 深浅色主题切换：监听全局主题事件，保证多处入口状态一致
  const [themeMode, setThemeMode] = useState<UIThemeMode>(getUITheme);
  useEffect(() => {
    const onThemeChange = (e: Event) => setThemeMode((e as CustomEvent<UIThemeMode>).detail);
    window.addEventListener(UI_THEME_EVENT, onThemeChange);
    return () => window.removeEventListener(UI_THEME_EVENT, onThemeChange);
  }, []);

  return (
    <header className="h-16 bg-slate-900 border-b border-slate-800 text-slate-100 px-4 md:px-6 flex items-center justify-between sticky top-0 z-30 shadow-md">
      {/* Brand & Title */}
      <div className="flex items-center space-x-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <Sparkles className="w-5 h-5 text-white animate-pulse" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="font-bold text-lg text-slate-100 tracking-tight">
              智能问数分析系统
            </h1>
            <span className="px-2 py-0.5 text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full">
              NL2SQL Pro v0.5.3
            </span>
          </div>
          <p className="text-xs text-slate-400 hidden sm:block">
            多源数据集成 • 自然语言交互 • 自动可视化与决策简报
          </p>
        </div>
      </div>

      {/* Datasource Switcher & Quick Actions */}
      <div className="flex items-center space-x-3">
        {/* Datasource Switcher（P2-11：仅列出有访问权限的数据源） */}
        {accessibleSources.length > 0 && (
        <div className="hidden md:flex items-center bg-slate-800/80 border border-slate-700/80 rounded-lg p-1 text-xs">
          <Database className="w-3.5 h-3.5 text-indigo-400 ml-2 mr-1.5" />
          <span className="text-slate-400 mr-2 font-medium">当前数据源:</span>
          <select
            data-testid="datasource-select"
            value={activeDataSourceId}
            onChange={(e) => setActiveDataSource(e.target.value)}
            className="bg-slate-900 text-slate-200 border border-slate-700 rounded px-2.5 py-1 focus:outline-none focus:border-indigo-500 font-medium cursor-pointer"
          >
            {accessibleSources.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({ds.type.toUpperCase()})
              </option>
            ))}
          </select>
          <div className="flex items-center ml-2 mr-1.5 text-emerald-400 font-medium text-[11px]">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            已连接
          </div>
        </div>
        )}

        {/* P2-11 权限申请入口：存在无权访问的数据源时显示 */}
        {deniedSources.length > 0 && (
          <button
            onClick={() => {
              setRequestTarget(deniedSources[0].id);
              setRequestMsg(null);
              setRequestOpen(true);
            }}
            title={`有 ${deniedSources.length} 个数据源未授权，点击申请访问权限`}
            className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-800/50 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">申请权限({deniedSources.length})</span>
          </button>
        )}

        {/* Generate Report Quick Button */}
        <button
          onClick={() => setActiveTab('reports')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            activeTab === 'reports'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
          }`}
        >
          <FileSpreadsheet className="w-3.5 h-3.5 text-cyan-400" />
          <span>自动生成报表</span>
        </button>

        {/* Data Source Manager Button（仅管理员） */}
        {user?.role === 'ADMIN' && (
          <button
            onClick={() => setActiveTab('datasources')}
            className="hidden sm:flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-indigo-400" />
            <span>接入数据源</span>
          </button>
        )}

        {/* 深浅色主题切换 */}
        <button
          onClick={() => toggleUITheme()}
          title={themeMode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          className="p-2 rounded-lg text-slate-400 hover:text-amber-300 hover:bg-slate-800 border border-transparent hover:border-slate-700 transition-colors"
        >
          {themeMode === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* 帮助：打开系统功能说明书 */}
        <button
          onClick={() => setHelpOpen(true)}
          title="帮助 · 系统功能说明书"
          className="p-2 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800 border border-transparent hover:border-slate-700 transition-colors"
        >
          <HelpCircle className="w-4 h-4" />
        </button>

        {/* Current User Chip + Logout */}
        {user && (
          <div className="flex items-center space-x-2 pl-3 border-l border-slate-700/80">
            <div className="flex items-center space-x-2">
              <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center text-[11px] font-bold text-white shadow">
                {user.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="hidden lg:block leading-tight">
                <div className="text-xs font-semibold text-slate-200">{user.displayName}</div>
                <span
                  className={`inline-block mt-0.5 px-1.5 py-px rounded-full border text-[10px] font-semibold ${ROLE_BADGE[user.role]}`}
                >
                  {ROLE_LABELS[user.role]}
                </span>
              </div>
            </div>
            <button
              onClick={logout}
              title="退出登录"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 border border-transparent hover:border-slate-700 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* 帮助弹窗 */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      {/* P2-11 权限申请弹窗 */}
      {requestOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md mx-4 bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
                <Lock className="w-4 h-4 text-amber-400" />
                <span>申请数据源访问权限</span>
              </h3>
              <button
                onClick={() => setRequestOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">数据源（仅列出你暂无权限的）:</label>
                <select
                  value={requestTarget}
                  onChange={(e) => setRequestTarget(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  {deniedSources.map((ds) => (
                    <option key={ds.id} value={ds.id}>
                      {ds.name} ({ds.type.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-slate-300 font-medium">申请理由:</label>
                <textarea
                  value={requestReason}
                  onChange={(e) => setRequestReason(e.target.value)}
                  placeholder="请说明业务用途，便于管理员审批（500 字以内）"
                  rows={3}
                  maxLength={500}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>
              {requestMsg && (
                <div className={`p-2.5 rounded-lg border text-[11px] ${requestMsg.includes('已提交') ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300' : 'bg-rose-950/60 border-rose-800/60 text-rose-300'}`}>
                  {requestMsg}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-800">
              <button
                onClick={() => setRequestOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
              >
                关闭
              </button>
              <button
                onClick={submitAccessRequest}
                disabled={!requestReason.trim() || requestSubmitting}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow"
              >
                {requestSubmitting ? '提交中…' : '提交申请'}
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
