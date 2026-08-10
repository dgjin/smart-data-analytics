import React from 'react';
import {
  MessageSquareCode,
  FileSpreadsheet,
  Database,
  LayoutDashboard,
  Table,
  Layers,
  ChevronRight,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { useAnalyticsStore } from '../hooks/useAnalyticsStore';
import { useAuthStore } from '../hooks/useAuthStore';
import { AppTab } from '../types/analytics';

export const Sidebar: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    dataSources,
    activeDataSourceId,
    activeTableId,
    setActiveTable,
  } = useAnalyticsStore();
  const user = useAuthStore((s) => s.user);

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);

  interface NavItem {
    id: AppTab;
    label: string;
    sublabel: string;
    icon: React.ElementType;
    badge?: string;
  }

  // 按角色过滤导航项：query 仅 ADMIN/ANALYST，datasources 与系统管理仅 ADMIN
  const navItems: NavItem[] = [];

  if (user?.role !== 'VIEWER') {
    navItems.push({
      id: 'query',
      label: '智能问答与查询',
      sublabel: '自然语言 NL2SQL 交互式提问',
      icon: MessageSquareCode,
      badge: 'AI 交互',
    });
  }

  navItems.push(
    {
      id: 'reports',
      label: '可视化决策报表',
      sublabel: '一键自动生成高管分析简报',
      icon: FileSpreadsheet,
      badge: '自动生成',
    },
    {
      id: 'dashboard',
      label: '决策数据看板',
      sublabel: '固化指标图表与看板展示',
      icon: LayoutDashboard,
    }
  );

  if (user?.role === 'ADMIN') {
    navItems.push(
      {
        id: 'datasources',
        label: '数据源与 Schema',
        sublabel: '接入 MySQL/PostgreSQL/CSV/API',
        icon: Database,
        badge: `${dataSources.length} 源`,
      },
      {
        id: 'admin',
        label: '系统管理',
        sublabel: '用户账号与角色权限配置',
        icon: ShieldCheck,
      }
    );
  }

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 text-slate-300 flex flex-col shrink-0 select-none">
      {/* Navigation Links */}
      <div className="p-3 space-y-1">
        <div className="px-3 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          分析功能中心
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full text-left p-2.5 rounded-xl transition-all flex items-center justify-between group ${
                isActive
                  ? 'bg-indigo-600/15 border border-indigo-500/30 text-indigo-300 font-medium'
                  : 'hover:bg-slate-800/80 text-slate-300 border border-transparent'
              }`}
            >
              <div className="flex items-center space-x-3 min-w-0">
                <div
                  className={`p-2 rounded-lg ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'bg-slate-800 text-slate-400 group-hover:text-slate-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="truncate">
                  <div className="text-xs font-semibold leading-none text-slate-100 mb-1">
                    {item.label}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">
                    {item.sublabel}
                  </div>
                </div>
              </div>
              {item.badge && (
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    isActive
                      ? 'bg-indigo-500/20 text-indigo-300'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="my-2 border-t border-slate-800/80" />

      {/* Active Data Source Tables Inspector */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <div className="flex items-center justify-between px-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          <span className="flex items-center space-x-1.5">
            <Layers className="w-3.5 h-3.5 text-indigo-400" />
            <span>数据源表结构 Schema</span>
          </span>
          <span className="text-slate-500">{activeDS?.tables.length || 0} 表</span>
        </div>

        {activeDS ? (
          <div className="space-y-1">
            <div className="px-2 py-1.5 bg-slate-800/50 rounded border border-slate-800 text-xs font-medium text-slate-300 flex items-center justify-between">
              <span className="truncate">{activeDS.name}</span>
              <span className="text-[10px] uppercase font-mono px-1 bg-slate-700 text-slate-300 rounded">
                {activeDS.type}
              </span>
            </div>

            <div className="pl-1 space-y-0.5 pt-1">
              {activeDS.tables.map((table) => {
                const isSelected = activeTableId === table.id;
                return (
                  <button
                    key={table.id}
                    onClick={() => {
                      setActiveTable(table.id);
                      if (user?.role === 'ADMIN') {
                        setActiveTab('datasources');
                      }
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                      isSelected
                        ? 'bg-indigo-950/60 text-indigo-300 border border-indigo-500/20'
                        : 'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center space-x-2 truncate">
                      <Table className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate font-mono">{table.displayName || table.name}</span>
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      {table.rowCount.toLocaleString()}行
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-3 text-center text-xs text-slate-400">请选择一个数据源</div>
        )}
      </div>

      {/* Footer Info Card */}
      <div className="p-3 border-t border-slate-800/80 bg-slate-900/80">
        <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-950/40 via-slate-900 to-slate-900 border border-indigo-500/20 text-xs space-y-1.5">
          <div className="flex items-center space-x-1.5 text-indigo-300 font-semibold text-[11px]">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>Ollama 本地引擎运行中</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            基于自然语言自动转化 SQL、智能推荐最优可视化图表并输出归因诊断。
          </p>
        </div>
      </div>
    </aside>
  );
};
