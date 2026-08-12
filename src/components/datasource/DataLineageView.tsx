import React, { useState } from 'react';
import {
  GitFork,
  Database,
  Cpu,
  FileSpreadsheet,
  BarChart3,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  Filter,
  Info,
  Table as TableIcon,
  Zap,
  MousePointer,
  Workflow,
  Activity,
  Layers,
  ChevronRight,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useEngineInfo } from '../../hooks/useEngineInfo';
import { SavedReport, DataSource, DashboardWidget } from '../../types/analytics';

export const DataLineageView: React.FC = () => {
  const { dataSources, savedReports, dashboardWidgets } = useAnalyticsStore();
  const engine = useEngineInfo();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Default processing engines in the mid-layer（引擎名按服务端实际配置展示）
  const engineName = engine?.model || 'AI';
  const processingNodes = [
    {
      id: 'proc_nl2sql',
      name: `${engineName} NL2SQL 引擎`,
      type: 'AI Translation & Query Generator',
      desc: '自然语言解析 Schema 并转化为高效分组聚合 SQL Query',
      status: 'active',
      icon: Cpu,
    },
    {
      id: 'proc_etl',
      name: '多维指标与特征清洗算子',
      type: 'Aggregation & KPI Transformer',
      desc: '清洗缺失值、日期对齐、计算环比与渠道归因比率',
      status: 'active',
      icon: Zap,
    },
  ];

  const activeNodeId = hoveredNodeId || selectedNodeId;

  // Find if active node is a report or widget or ds or proc
  const hoveredReport = savedReports.find((r) => r.id === activeNodeId);
  const hoveredWidget = dashboardWidgets.find((w) => w.id === activeNodeId);
  const hoveredDS = dataSources.find((ds) => ds.id === activeNodeId);
  const hoveredProc = processingNodes.find((p) => p.id === activeNodeId);

  // Determine upstream datasource for a report
  const getReportUpstreamDS = (report: SavedReport): DataSource | null => {
    return dataSources.find((ds) => ds.id === report.dataSourceId) || dataSources[0] || null;
  };

  // 固化图表的上游数据源：优先取固化时记录的 dataSourceId，旧数据缺失才回退首个数据源
  const getWidgetUpstreamDS = (w: DashboardWidget): DataSource | null => {
    return (w.dataSourceId && dataSources.find((ds) => ds.id === w.dataSourceId)) || dataSources[0] || null;
  };

  // Determine dependency matching for highlighting
  const isDSLineageActive = (dsId: string) => {
    if (!activeNodeId) return false;
    if (activeNodeId === dsId) return true;

    if (hoveredReport) {
      const upstreamDS = getReportUpstreamDS(hoveredReport);
      return upstreamDS?.id === dsId;
    }

    if (hoveredWidget) {
      return getWidgetUpstreamDS(hoveredWidget)?.id === dsId;
    }

    if (hoveredProc) return true;

    return false;
  };

  const isProcLineageActive = (procId: string) => {
    if (!activeNodeId) return false;
    if (activeNodeId === procId) return true;
    if (hoveredReport || hoveredWidget || hoveredDS) return true;
    return false;
  };

  const isReportLineageActive = (rep: SavedReport) => {
    if (!activeNodeId) return false;
    if (activeNodeId === rep.id) return true;

    if (hoveredDS) {
      const upstreamDS = getReportUpstreamDS(rep);
      return upstreamDS?.id === hoveredDS.id;
    }

    if (hoveredProc) return true;

    return false;
  };

  const isWidgetLineageActive = (w: DashboardWidget) => {
    if (!activeNodeId) return false;
    if (activeNodeId === w.id) return true;
    if (hoveredDS) return getWidgetUpstreamDS(w)?.id === hoveredDS.id;
    if (hoveredProc) return true;
    return false;
  };

  // Active upstream datasource for highlighted report/widget
  const activeUpstreamDS = hoveredReport
    ? getReportUpstreamDS(hoveredReport)
    : hoveredWidget
    ? getWidgetUpstreamDS(hoveredWidget)
    : null;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-8 space-y-6 shadow-xl relative">
      {/* Title & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              Data Lineage Engine
            </span>
            <span className="text-xs text-slate-400 flex items-center space-x-1">
              <GitFork className="w-3.5 h-3.5 text-cyan-400" />
              <span>全链路影响分析与数据血缘拓扑</span>
            </span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold text-slate-100 tracking-tight">
            全域数据血缘与计算流向图 (End-to-End Data Lineage)
          </h2>
          <p className="text-xs text-slate-400 flex items-center space-x-1">
            <MousePointer className="w-3.5 h-3.5 text-emerald-400" />
            <span>
              将鼠标悬停在下方任意<strong className="text-emerald-300 mx-1">报表组件</strong>上，即可即时高亮其依赖的全部上游数据源及中间 AI 算子处理路径。
            </span>
          </p>
        </div>

        {/* 重置按钮常驻占位（invisible 切换），避免条件渲染在窄屏头部插入新行导致跳动 */}
        <button
          onClick={() => {
            setSelectedNodeId(null);
            setHoveredNodeId(null);
          }}
          className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors shrink-0 ${
            selectedNodeId || hoveredNodeId ? 'visible' : 'invisible pointer-events-none'
          }`}
        >
          <Filter className="w-3.5 h-3.5 text-indigo-400" />
          <span>重置血缘高亮</span>
        </button>
      </div>

      {/* Interactive Upstream Lineage Pathway Banner when Hovered/Selected
          常驻占位 + 绝对定位叠层：占位层恒定撑起布局高度，链路横幅以 overlay 叠上，
          不参与文档流，悬停任何节点都不会推挤下方内容（窄屏多行换行也不影响布局） */}
      <div className="relative">
        {/* 占位层：撑起固定高度，永远参与布局 */}
        <div className="rounded-2xl border border-dashed border-slate-800 flex items-center justify-center px-4 py-6 text-center">
          <span className="text-xs text-slate-500 flex items-center space-x-1.5">
            <MousePointer className="w-3.5 h-3.5 text-slate-600" />
            <span>悬停任意决策简报或固化监控图表，此处即时展示其完整上游数据链路依赖分析</span>
          </span>
        </div>

        {(hoveredReport || hoveredWidget) && (
        <div className="absolute inset-x-0 top-0 bg-gradient-to-r from-emerald-950/90 via-slate-900 to-indigo-950/90 border border-emerald-500/50 rounded-2xl p-4 shadow-2xl space-y-3 animate-fadeIn ring-1 ring-emerald-500/30">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center space-x-2">
              <span className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <Workflow className="w-4 h-4 animate-pulse" />
              </span>
              <div>
                <span className="text-xs font-bold text-slate-100">
                  【{hoveredReport?.title || hoveredWidget?.title}】的完整上游数据链路依赖分析
                </span>
                <p className="text-[10px] text-slate-400">
                  即时识别该报表消费的所有源表及算子处理节点
                </p>
              </div>
            </div>

            <span className="text-[10px] text-emerald-300 font-mono bg-emerald-950 px-2.5 py-1 rounded-full border border-emerald-500/40 shrink-0 self-start sm:self-center flex items-center space-x-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
              <span>上游链路高亮中 (Hover Lineage Active)</span>
            </span>
          </div>

          {/* Dynamic Flow Trail（横向滚动不换行，保证横幅高度恒定不撑变） */}
          <div className="flex items-center gap-2 text-xs font-mono pt-1 overflow-x-auto pb-1">
            {/* Upstream Source */}
            <div className="flex items-center space-x-2 bg-indigo-950/80 px-3 py-1.5 rounded-xl border border-indigo-500/60 text-indigo-200 font-bold shadow-md shadow-indigo-500/10 shrink-0 whitespace-nowrap">
              <Database className="w-3.5 h-3.5 text-indigo-400" />
              <span>1. 接入源: {activeUpstreamDS?.name || '底层数据仓'}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-900/60 text-indigo-300 border border-indigo-700">
                {activeUpstreamDS?.type.toUpperCase()}
              </span>
            </div>

            <ChevronRight className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />

            {/* Stage 1 Engine */}
            <div className="flex items-center space-x-2 bg-cyan-950/80 px-3 py-1.5 rounded-xl border border-cyan-500/60 text-cyan-200 font-bold shadow-md shadow-cyan-500/10 shrink-0 whitespace-nowrap">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>2. {engineName} NL2SQL 语义转译</span>
            </div>

            <ChevronRight className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />

            {/* Stage 2 Engine */}
            <div className="flex items-center space-x-2 bg-cyan-950/80 px-3 py-1.5 rounded-xl border border-cyan-500/60 text-cyan-200 font-bold shadow-md shadow-cyan-500/10 shrink-0 whitespace-nowrap">
              <Zap className="w-3.5 h-3.5 text-cyan-400" />
              <span>3. 特征清洗 & 指标聚合</span>
            </div>

            <ChevronRight className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />

            {/* Target Component */}
            <div className="flex items-center space-x-2 bg-emerald-950 px-3 py-1.5 rounded-xl border border-emerald-400 text-emerald-200 font-bold shadow-lg shadow-emerald-500/20 shrink-0 whitespace-nowrap">
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>4. 报表组件: {hoveredReport?.title || hoveredWidget?.title}</span>
            </div>
          </div>
        </div>
        )}
      </div>

      {/* Visual Pipeline Layout: 3 Columns with Flow Connections */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 relative">
        {/* Column 1: Source Tier (4 Cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="flex items-center justify-between text-xs font-bold text-slate-300 uppercase tracking-wider bg-slate-950 p-3 rounded-xl border border-slate-800">
            <div className="flex items-center space-x-2">
              <Database className="w-4 h-4 text-indigo-400" />
              <span>1. 接入源层 (Raw Data Sources)</span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">{dataSources.length} 源</span>
          </div>

          <div className="space-y-3">
            {dataSources.map((ds) => {
              const isHighlighted = isDSLineageActive(ds.id);
              const isDirectSelected = activeNodeId === ds.id;
              const isDimmed = activeNodeId && !isHighlighted;

              return (
                <div
                  key={ds.id}
                  onMouseEnter={() => setHoveredNodeId(ds.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  onClick={() => setSelectedNodeId(isDirectSelected ? null : ds.id)}
                  className={`p-4 rounded-2xl border cursor-pointer transition-all duration-200 space-y-3 relative overflow-hidden ${
                    isHighlighted
                      ? 'bg-indigo-950/90 border-indigo-400 shadow-xl shadow-indigo-500/25 ring-2 ring-indigo-500/60'
                      : isDimmed
                      ? 'bg-slate-950/30 border-slate-800/40 opacity-30 filter blur-[0.3px]'
                      : 'bg-slate-950/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900/80'
                  }`}
                >
                  {isHighlighted && (
                    <div className="absolute -top-1 -right-1 px-2.5 py-0.5 rounded-bl-xl bg-indigo-500 text-slate-950 text-[9px] font-extrabold uppercase tracking-widest shadow">
                      ⬆️ 上游依赖数据源
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2.5">
                      <div
                        className={`p-2 rounded-xl border transition-colors ${
                          isHighlighted
                            ? 'bg-indigo-500 text-white border-indigo-300 shadow-md'
                            : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                        }`}
                      >
                        <Database className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-bold text-xs text-slate-100">{ds.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {ds.config.database || ds.config.fileName || 'Master Cluster'}
                        </div>
                      </div>
                    </div>

                    <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-900 text-cyan-300 border border-slate-800">
                      {ds.type}
                    </span>
                  </div>

                  {/* Connected Tables list */}
                  <div className="space-y-1.5 border-t border-slate-800/80 pt-2.5">
                    <div className="text-[10px] text-slate-400 font-semibold flex items-center justify-between">
                      <span>已注册 Schema 数据表 ({ds.tables.length})</span>
                      <span className="text-emerald-400 flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>数据通道畅通</span>
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {ds.tables.map((tbl) => (
                        <span
                          key={tbl.id}
                          className={`px-2 py-0.5 rounded text-[10px] border font-mono flex items-center space-x-1 transition-colors ${
                            isHighlighted
                              ? 'bg-indigo-900/80 border-indigo-400 text-indigo-100 font-bold'
                              : 'bg-slate-900 border-slate-800 text-slate-300'
                          }`}
                        >
                          <TableIcon className="w-2.5 h-2.5 text-indigo-400" />
                          <span>{tbl.name}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 2: Processing Engine Tier (3 Cols) */}
        <div className="lg:col-span-3 space-y-4">
          <div className="flex items-center justify-between text-xs font-bold text-slate-300 uppercase tracking-wider bg-slate-950 p-3 rounded-xl border border-slate-800">
            <div className="flex items-center space-x-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>2. 逻辑提炼算子层</span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">2 节点</span>
          </div>

          <div className="space-y-3">
            {processingNodes.map((proc) => {
              const Icon = proc.icon;
              const isHighlighted = isProcLineageActive(proc.id);
              const isDimmed = activeNodeId && !isHighlighted;

              return (
                <div
                  key={proc.id}
                  onMouseEnter={() => setHoveredNodeId(proc.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  onClick={() => setSelectedNodeId(activeNodeId === proc.id ? null : proc.id)}
                  className={`p-4 rounded-2xl border cursor-pointer transition-all duration-200 space-y-2 relative ${
                    isHighlighted
                      ? 'bg-cyan-950/90 border-cyan-400 shadow-xl shadow-cyan-500/20 ring-2 ring-cyan-500/50'
                      : isDimmed
                      ? 'bg-slate-950/30 border-slate-800/40 opacity-30 filter blur-[0.3px]'
                      : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {isHighlighted && (
                    <div className="absolute -top-1 -right-1 px-2.5 py-0.5 rounded-bl-xl bg-cyan-400 text-slate-950 text-[9px] font-extrabold uppercase tracking-widest shadow">
                      ⚡ 链路算子执行中
                    </div>
                  )}

                  <div className="flex items-center space-x-2.5">
                    <div
                      className={`p-2 rounded-xl border transition-colors ${
                        isHighlighted
                          ? 'bg-cyan-500 text-slate-950 border-cyan-300 font-bold'
                          : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-bold text-xs text-slate-100">{proc.name}</div>
                      <div className="text-[10px] text-cyan-400 font-mono">{proc.type}</div>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 leading-relaxed bg-slate-900/60 p-2 rounded-xl border border-slate-800">
                    {proc.desc}
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                    <span className="flex items-center space-x-1 text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      <span>处理路径畅通</span>
                    </span>
                    <span className="font-mono text-slate-500">延迟 &lt; 8ms</span>
                  </div>
                </div>
              );
            })}

            {/* Dynamic Pipeline Info Box */}
            <div className="p-3.5 bg-slate-950 border border-indigo-500/20 rounded-2xl space-y-1.5">
              <div className="text-xs font-bold text-indigo-400 flex items-center space-x-1">
                <Sparkles className="w-3.5 h-3.5" />
                <span>鼠标悬停血缘高亮特性</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-snug">
                系统根据报表绑定的 <code className="text-indigo-300">dataSourceId</code> 及查询元数据，即时向上推演数据归因路线，协助开发人员快速评估源库变更对终端报表的影响。
              </p>
            </div>
          </div>
        </div>

        {/* Column 3: Consumption Tier (5 Cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between text-xs font-bold text-slate-300 uppercase tracking-wider bg-slate-950 p-3 rounded-xl border border-slate-800">
            <div className="flex items-center space-x-2">
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
              <span>3. 终端导向层 (Downstream Reports & Widgets)</span>
            </div>
            <span className="text-[10px] text-emerald-400 font-mono">
              {savedReports.length + dashboardWidgets.length} 组件
            </span>
          </div>

          <div className="space-y-4">
            {/* Reports Group */}
            <div className="space-y-2">
              <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider px-1 flex items-center justify-between">
                <span>衍生决策简报 ({savedReports.length})</span>
                <span className="text-[10px] text-slate-500 font-normal">
                  悬停卡片高亮上游数据路径
                </span>
              </div>

              {savedReports.map((rep) => {
                const isHighlighted = isReportLineageActive(rep);
                const isDirectHovered = activeNodeId === rep.id;
                const isDimmed = activeNodeId && !isHighlighted;
                const upstreamDS = getReportUpstreamDS(rep);

                return (
                  <div
                    key={rep.id}
                    onMouseEnter={() => setHoveredNodeId(rep.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    onClick={() => setSelectedNodeId(isDirectHovered ? null : rep.id)}
                    className={`p-3.5 rounded-2xl border cursor-pointer transition-all duration-200 space-y-2.5 relative overflow-hidden ${
                      isDirectHovered
                        ? 'bg-emerald-950/90 border-emerald-400 shadow-2xl shadow-emerald-500/30 ring-2 ring-emerald-500'
                        : isHighlighted
                        ? 'bg-emerald-950/70 border-emerald-500/80 shadow-lg shadow-emerald-500/15'
                        : isDimmed
                        ? 'bg-slate-950/30 border-slate-800/40 opacity-30 filter blur-[0.3px]'
                        : 'bg-slate-950/80 border-slate-800 hover:border-emerald-500/50 hover:bg-slate-900'
                    }`}
                  >
                    {isDirectHovered && (
                      <div className="absolute -top-1 -right-1 px-2.5 py-0.5 rounded-bl-xl bg-emerald-400 text-slate-950 text-[9px] font-extrabold uppercase tracking-widest shadow flex items-center space-x-1">
                        <MousePointer className="w-2.5 h-2.5" />
                        <span>已高亮当前报表</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <div
                          className={`p-1.5 rounded-lg border ${
                            isDirectHovered
                              ? 'bg-emerald-500 text-slate-950 border-emerald-300 font-bold'
                              : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          }`}
                        >
                          <FileSpreadsheet className="w-4 h-4 shrink-0" />
                        </div>
                        <span className="font-bold text-xs text-slate-100">{rep.title}</span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono">{rep.createdAt}</span>
                    </div>

                    <div className="flex items-center justify-between text-[10px]">
                      <div className="flex items-center space-x-1.5 text-slate-400">
                        <span className="px-2 py-0.5 bg-slate-900 rounded border border-slate-800 text-slate-300">
                          {rep.insights?.length || 0} 项归因
                        </span>
                        <span className="px-2 py-0.5 bg-slate-900 rounded border border-slate-800 text-indigo-300 font-mono">
                          {rep.kpiList?.length || 0} KPI
                        </span>
                      </div>

                      {/* Explicit Upstream Source Tag */}
                      <div className="flex items-center space-x-1 font-mono text-indigo-300 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-500/30">
                        <Database className="w-2.5 h-2.5 text-indigo-400" />
                        <span>依赖源: {upstreamDS?.name.split(' ')[0] || '默认主库'}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Dashboard Widgets Group */}
            <div className="space-y-2">
              <div className="text-[11px] text-slate-400 font-bold uppercase tracking-wider px-1">
                固化监控图表 ({dashboardWidgets.length})
              </div>
              {dashboardWidgets.map((w) => {
                const isHighlighted = isWidgetLineageActive(w);
                const isDirectHovered = activeNodeId === w.id;
                const isDimmed = activeNodeId && !isHighlighted;

                return (
                  <div
                    key={w.id}
                    onMouseEnter={() => setHoveredNodeId(w.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    onClick={() => setSelectedNodeId(isDirectHovered ? null : w.id)}
                    className={`p-3 rounded-xl border cursor-pointer transition-all duration-200 flex items-center justify-between ${
                      isDirectHovered
                        ? 'bg-indigo-950/90 border-indigo-400 shadow-xl shadow-indigo-500/25 ring-2 ring-indigo-500'
                        : isHighlighted
                        ? 'bg-indigo-950/60 border-indigo-500/70'
                        : isDimmed
                        ? 'bg-slate-950/30 border-slate-800/40 opacity-30 filter blur-[0.3px]'
                        : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <BarChart3 className="w-4 h-4 text-indigo-400" />
                      <span className="text-xs font-semibold text-slate-200">{w.title}</span>
                    </div>
                    <span className="text-[10px] uppercase font-mono text-cyan-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                      {w.chartConfig.type}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Selected Node Detailed Lineage Summary Card
          同样采用常驻占位 + 绝对定位叠层：聚焦详情叠在占位上，不影响文档流高度 */}
      <div className="relative">
        <div className="rounded-2xl border border-dashed border-slate-800 px-5 py-6 flex items-center justify-center">
          <span className="text-xs text-slate-500">悬停或点击任意节点，此处展示该节点的数据血缘与全路径归因审计详情</span>
        </div>

        {activeNodeId && (
        <div className="absolute inset-x-0 top-0 bg-slate-950 border border-indigo-500/30 rounded-2xl p-5 space-y-3 animate-fadeIn">
          <div className="flex items-center space-x-2 text-indigo-400 text-xs font-bold uppercase tracking-wider">
            <Info className="w-4 h-4" />
            <span>数据血缘与全路径归因分析 (Lineage Audit Detail)</span>
          </div>

          <div className="text-xs text-slate-300 leading-relaxed font-mono space-y-1">
            <div>
              当前聚焦节点 ID: <span className="text-indigo-300 font-bold">{activeNodeId}</span>
            </div>
            {hoveredReport && (
              <div className="text-emerald-300">
                • 目标报表: 【{hoveredReport.title}】 已绑定上游数据源 [{activeUpstreamDS?.name}]，经过 {engineName} NL2SQL 解析和特征清洗，数据流向正常。
              </div>
            )}
            {hoveredWidget && (
              <div className="text-indigo-300">
                • 固化监控图表: 【{hoveredWidget.title}】（{hoveredWidget.chartConfig.type}）来自上游数据源 [{activeUpstreamDS?.name || '未知'}]，经问数链路固化至决策看板。
              </div>
            )}
            {hoveredDS && (
              <div className="text-indigo-300">
                • 数据源: 【{hoveredDS.name}】 下游供给 {savedReports.filter((r) => getReportUpstreamDS(r)?.id === hoveredDS.id).length} 项决策简报及 {dashboardWidgets.filter((w) => getWidgetUpstreamDS(w)?.id === hoveredDS.id).length} 项固化监控图表。
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
