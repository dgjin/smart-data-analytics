import React, { useEffect, useState } from 'react';
import {
  MessageSquareCode,
  FileSpreadsheet,
  FileText,
  Database,
  LayoutDashboard,
  Table,
  Layers,
  Sparkles,
  ShieldCheck,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
} from 'lucide-react';
import { useAnalyticsStore } from '../hooks/useAnalyticsStore';
import { useAuthStore } from '../hooks/useAuthStore';
import { useEngineInfo } from '../hooks/useEngineInfo';
import { AppTab } from '../types/analytics';

const COLLAPSE_KEY = 'app-sidebar-collapsed';

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
  const engine = useEngineInfo();

  // 侧边栏收缩状态（持久化，刷新后保持）
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next;
    });
  };

  // 收缩态下 Schema 区域的展开状态
  const [schemaOpen, setSchemaOpen] = useState(true);

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
      id: 'query-reports',
      label: '问数报告中心',
      sublabel: '智能问数报告模式生成的报告',
      icon: FileText,
      badge: '报告模式',
    },
    {
      id: 'dashboard',
      label: '决策数据看板',
      sublabel: '固化指标图表与看板展示',
      icon: LayoutDashboard,
    }
  );

  // v0.4.9 灵活查询：拖拉拽定制固定报表（依赖 flex-schema，仅 ADMIN/ANALYST）
  if (user?.role !== 'VIEWER') {
    navItems.push({
      id: 'flexquery',
      label: '灵活查询',
      sublabel: '拖拉拽可视化定制固定报表',
      icon: SlidersHorizontal,
      badge: '自定义',
    });
  }

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
        sublabel: '用户角色与 Token 用量管理',
        icon: ShieldCheck,
      }
    );
  }

  // ---------- 收缩态：仅图标导航 ----------
  if (collapsed) {
    return (
      <aside className="w-16 bg-slate-900 border-r border-slate-800 text-slate-300 flex flex-col shrink-0 select-none">
        <div className="p-2 flex justify-center">
          <button
            onClick={toggleCollapsed}
            title="展开侧边栏"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
        <div className="p-2 space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                title={`${item.label}${item.badge ? ` · ${item.badge}` : ''}`}
                className={`w-full flex justify-center p-2.5 rounded-xl transition-all ${
                  isActive
                    ? 'bg-indigo-600/15 border border-indigo-500/30 text-indigo-300'
                    : 'hover:bg-slate-800/80 text-slate-400 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <div className="p-2 border-t border-slate-800/80 flex justify-center">
          <div
            className={`w-2 h-2 rounded-full ${engine ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`}
            title={engine ? `${engine.label} 引擎运行中` : 'AI 引擎运行中'}
          />
        </div>
      </aside>
    );
  }

  // ---------- 展开态 ----------
  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 text-slate-300 flex flex-col shrink-0 select-none">
      {/* 收缩按钮 */}
      <div className="p-2 flex justify-end">
        <button
          onClick={toggleCollapsed}
          title="收起侧边栏"
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation Links */}
      <div className="px-3 pb-3 space-y-1">
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

      {/* Active Data Source Tables Inspector（表结构详情仅管理员可见，可折叠） */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <button
          onClick={() => setSchemaOpen((v) => !v)}
          className="w-full flex items-center justify-between px-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider hover:text-slate-200 transition-colors"
          title={schemaOpen ? '折叠表结构区域' : '展开表结构区域'}
        >
          <span className="flex items-center space-x-1.5">
            <Layers className="w-3.5 h-3.5 text-indigo-400" />
            <span>数据源表结构 Schema</span>
          </span>
          <span className="text-slate-500">
            {(activeDS?.tables.length || activeDS?.tableCount || 0)} 表
          </span>
        </button>

        {schemaOpen && (
          user?.role !== 'ADMIN' ? (
            <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800 text-center space-y-1.5">
              <ShieldCheck className="w-4 h-4 text-slate-500 mx-auto" />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                表结构仅管理员可查看
              </p>
            </div>
          ) : activeDS ? (
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
          )
        )}
      </div>

      {/* Footer Info Card */}
      <div className="p-3 border-t border-slate-800/80 bg-slate-900/80">
        <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-950/40 via-slate-900 to-slate-900 border border-indigo-500/20 text-xs space-y-1.5">
          <div className="flex items-center space-x-1.5 text-indigo-300 font-semibold text-[11px]">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>{engine ? `${engine.label} 引擎运行中` : 'AI 引擎运行中'}</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            基于自然语言自动转化 SQL、智能推荐最优可视化图表并输出归因诊断。
          </p>
        </div>
      </div>
    </aside>
  );
};
