import React, { useState, useRef, useEffect } from 'react';
import {
  LayoutDashboard,
  Trash2,
  Sparkles,
  BarChart3,
  Plus,
  Palette,
  GripVertical,
  Move,
  Maximize2,
  Columns,
  RotateCcw,
  Sliders,
  Check,
  Lock,
  Unlock,
  Grid,
  RefreshCw,
  Gauge,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { DynamicChart } from '../charts/DynamicChart';
import { CHART_THEMES } from '../../utils/chartThemes';
import { DashboardWidget } from '../../types/analytics';
import { apiFetch } from '../../api/client';
import { useDataVersion } from '../../hooks/useDataVersion';
import { useEffectiveAmountUnit } from '../../hooks/useAmountUnitStore';
import { AmountUnitSelect } from '../common/AmountUnitSelect';

/** P2-14 语义层：语义指标定义（与后端 MetricDefinition 对齐，仅需看板端用到的字段） */
interface SemanticMetric {
  id: number;
  name: string;
  expr: string;
  tableName: string;
  dimensions: string[];
  status: string;
}

export const CustomDashboard: React.FC = () => {
  const {
    dashboardWidgets,
    initDashboardWidgets,
    removeDashboardWidgetRemote,
    updateDashboardWidgetRemote,
    reorderDashboardWidgetsRemote,
    pinChartToDashboardRemote,
    dataSources,
    setActiveTab,
  } = useAnalyticsStore();
  const currentUser = useAuthStore((s) => s.user);
  // P2-14：统一指标查询端点仅 ADMIN/ANALYST 可调（与问数同权限）
  const canQueryMetric = currentUser?.role === 'ADMIN' || currentUser?.role === 'ANALYST';

  // v0.9.24：看板固化图表服务端持久化——挂载后迁移本地遗留并拉取服务端权威列表
  useEffect(() => {
    if (currentUser) void initDashboardWidgets();
  }, [currentUser, initDashboardWidgets]);

  const [globalThemeId, setGlobalThemeId] = useState<string>('cyber');
  const [globalAutoContrast, setGlobalAutoContrast] = useState<boolean>(true);
  const [isEditingLayout, setIsEditingLayout] = useState<boolean>(true);

  // Drag and Drop state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Mouse Resize state
  const [resizingWidgetId, setResizingWidgetId] = useState<string | null>(null);

  // v0.4.8 自主更新：监测固化图表所属数据源，检测到数据变化时重放原聚合 SQL 刷新看板
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [autoUpdateMsg, setAutoUpdateMsg] = useState<string | null>(null);
  // 看板固化通常来自同一问数会话的单一数据源，取首个可重放 widget 的数据源作为监测对象
  const watchedDsId = dashboardWidgets.find((w) => w.dataSourceId && w.sourceSql)?.dataSourceId;
  const widgetsRef = useRef(dashboardWidgets);
  widgetsRef.current = dashboardWidgets;
  const { lastCheckedAt } = useDataVersion(watchedDsId, () => {
    void replayWidgets();
  });

  async function replayWidgets(): Promise<void> {
    if (autoRefreshing) return;
    setAutoRefreshing(true);
    try {
      const targets = widgetsRef.current.filter((w) => w.dataSourceId === watchedDsId && w.sourceSql);
      let refreshed = 0;
      for (const w of targets) {
        try {
          const res = await apiFetch('/api/query/execute-sql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataSourceId: w.dataSourceId, sql: w.sourceSql }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (data.success && Array.isArray(data.rows)) {
            // v0.9.24：自动重放快照同步远端；VIEWER 无写权限（403）或网络异常时仅本地生效，不回滚避免看板数字闪回
            void updateDashboardWidgetRemote(w.id, { data: data.rows, lastAutoUpdatedAt: new Date().toISOString() }, { keepLocalOnError: true });
            refreshed += 1;
          }
        } catch {
          // 单个 widget 重放失败不影响其余
        }
      }
      setAutoUpdateMsg(
        refreshed > 0
          ? `检测到数据变化，已自动刷新 ${refreshed} 个图表`
          : '检测到数据变化，但图表刷新失败（可手动重新固化）',
      );
    } finally {
      setAutoRefreshing(false);
    }
  }

  // ---------- P2-14 语义层看板端：语义指标直查（选指标+维度 → 统一查询端点 → 可固化） ----------
  const dbSources = dataSources.filter((ds) => ['mysql', 'postgresql', 'greenplum'].includes(ds.type));
  const [metricDsId, setMetricDsId] = useState('');
  const [metricList, setMetricList] = useState<SemanticMetric[]>([]);
  const [metricId, setMetricId] = useState<number | ''>('');
  const [metricDims, setMetricDims] = useState<string[]>([]);
  const [metricBusy, setMetricBusy] = useState(false);
  const [metricError, setMetricError] = useState('');
  const [metricPinned, setMetricPinned] = useState(false);
  const [metricResult, setMetricResult] = useState<{
    rows: Record<string, any>[];
    sql: string;
    metricName: string;
    dims: string[];
    /** v0.9.21 金额单位标注：服务端实际换算时为单位 label（如「万元」），未换算为空串 */
    unitLabel: string;
  } | null>(null);
  // v0.9.21 语义指标直查金额单位：跟随全局（Header），面板内可模块级覆盖
  const metricAmountUnit = useEffectiveAmountUnit('dashboard');
  // 默认跟随看板正在监测的数据源，其次首个库型数据源
  const effectiveMetricDsId = metricDsId || watchedDsId || dbSources[0]?.id || '';

  // v0.9.21 单位切换后旧结果口径过期，清空待重新查询（与切换数据源/指标行为一致）
  useEffect(() => {
    setMetricResult(null);
    setMetricError('');
  }, [metricAmountUnit]);

  useEffect(() => {
    setMetricList([]);
    setMetricId('');
    setMetricDims([]);
    setMetricResult(null);
    setMetricError('');
    if (!effectiveMetricDsId || !canQueryMetric) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/metrics?dataSourceId=${encodeURIComponent(effectiveMetricDsId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const active = (Array.isArray(data.metrics) ? data.metrics : []).filter(
          (m: SemanticMetric) => m.status === 'ACTIVE'
        );
        setMetricList(active);
      } catch {
        // 指标列表加载失败静默降级（不影响看板主功能区）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveMetricDsId, canQueryMetric]);

  const selectedMetric = metricList.find((m) => m.id === metricId) || null;

  async function runMetricQuery(): Promise<void> {
    if (!selectedMetric) return;
    setMetricBusy(true);
    setMetricError('');
    setMetricResult(null);
    setMetricPinned(false);
    try {
      const res = await apiFetch('/api/metrics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metricId: selectedMetric.id, dimensions: metricDims, limit: 100, amountUnit: metricAmountUnit }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMetricError(data.error || `查询失败（HTTP ${res.status}）`);
        return;
      }
      setMetricResult({
        rows: Array.isArray(data.rows) ? data.rows : [],
        sql: String(data.sql || ''),
        metricName: selectedMetric.name,
        dims: metricDims,
        // 服务端实际完成单位换算时才标注（非金额类指标/「元」原值口径不标注）
        unitLabel: data.amountUnit?.applied === true ? String(data.amountUnit.label) : '',
      });
    } catch (e: any) {
      setMetricError(e?.message || '网络异常');
    } finally {
      setMetricBusy(false);
    }
  }

  function pinMetricResult(): void {
    if (!metricResult || metricResult.rows.length === 0) return;
    const { rows, sql, metricName, dims, unitLabel } = metricResult;
    // v0.9.21：金额单位参与固化标题与轴名，固化卡片口径自说明（重放 SQL 已含换算，口径一致）
    const displayName = unitLabel ? `${metricName}（${unitLabel}）` : metricName;
    const title = dims.length > 0 ? `${displayName}（按${dims.join('/')}切分）` : displayName;
    // 带维度结果固化后带 sourceSql，可参与 v0.4.8 数据变化自动重放刷新；
    // 无维度单值固化为静态快照（重放会改变数据形状，不参与自动更新）
    if (dims.length > 0) {
      pinChartToDashboardRemote({
        title,
        chartConfig: { type: 'bar', title, xAxisKey: dims[0], yAxisKeys: ['value'], yAxisNames: { value: displayName }, xAxisName: dims[0] },
        data: rows,
        dataSourceId: effectiveMetricDsId,
        sourceSql: sql || undefined,
      }).catch((err) => window.alert(err?.message || '固化到看板失败'));
    } else {
      const v = rows[0]?.value;
      pinChartToDashboardRemote({
        title,
        chartConfig: { type: 'bar', title, xAxisKey: 'value', yAxisKeys: ['value'], yAxisNames: { value: displayName } },
        data: [{ value: typeof v === 'number' ? v : Number(v) || 0 }],
        dataSourceId: effectiveMetricDsId,
      }).catch((err) => window.alert(err?.message || '固化到看板失败'));
    }
    setMetricPinned(true);
  }
  const resizeStartRef = useRef<{
    widgetId: string;
    startX: number;
    startY: number;
    initialColSpan: 1 | 2 | 3;
    initialHeight: number;
  } | null>(null);

  // Handle Drag Start
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // Transparent drag image or default handle
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    // Keep dragOverIndex until drop or exit
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const updated = [...dashboardWidgets];
    const [movedItem] = updated.splice(draggedIndex, 1);
    updated.splice(targetIndex, 0, movedItem);

    // v0.9.24：排序同步服务端，失败自动回滚（回滚即视觉反馈）
    void reorderDashboardWidgetsRemote(updated).catch(() => {});
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  // Mouse Resize Handler
  const handleResizeStart = (
    e: React.MouseEvent<HTMLDivElement>,
    widget: DashboardWidget
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const initialColSpan = (widget.colSpan || 1) as 1 | 2 | 3;
    const initialHeight = widget.height || 280;

    resizeStartRef.current = {
      widgetId: widget.id,
      startX: e.clientX,
      startY: e.clientY,
      initialColSpan,
      initialHeight,
    };

    setResizingWidgetId(widget.id);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const { widgetId, startX, startY, initialColSpan, initialHeight } =
        resizeStartRef.current;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // ColSpan calculation: ~120px horizontal drag changes colSpan
      let newColSpan = initialColSpan;
      if (dx > 140 && initialColSpan < 3) {
        newColSpan = (initialColSpan + 1) as 1 | 2 | 3;
      } else if (dx > 280 && initialColSpan < 2) {
        newColSpan = 3;
      } else if (dx < -140 && initialColSpan > 1) {
        newColSpan = (initialColSpan - 1) as 1 | 2 | 3;
      } else if (dx < -280 && initialColSpan > 2) {
        newColSpan = 1;
      }

      // Height calculation: clamped between 200px and 520px
      const newHeight = Math.max(200, Math.min(520, Math.round(initialHeight + dy)));

      // v0.9.24：拖拽缩放 mousemove 高频调用仅本地预览（localOnly），mouseup 再一次性同步远端
      void updateDashboardWidgetRemote(widgetId, {
        colSpan: newColSpan,
        height: newHeight,
      }, { localOnly: true });
    };

    const handleMouseUp = () => {
      if (resizingWidgetId) {
        const finalWidget = widgetsRef.current.find((x) => x.id === resizingWidgetId);
        resizeStartRef.current = null;
        setResizingWidgetId(null);
        if (finalWidget) {
          void updateDashboardWidgetRemote(finalWidget.id, {
            colSpan: finalWidget.colSpan,
            height: finalWidget.height,
          }).catch(() => {});
        }
      }
    };

    if (resizingWidgetId) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingWidgetId, updateDashboardWidgetRemote]);

  // Apply Layout Presets
  const applyPresetLayout = (preset: 'three' | 'two' | 'hero') => {
    const updated = dashboardWidgets.map((w, idx) => {
      if (preset === 'three') {
        return { ...w, colSpan: 1 as const, height: 280 };
      }
      if (preset === 'two') {
        return { ...w, colSpan: 2 as const, height: 320 };
      }
      if (preset === 'hero') {
        return idx === 0
          ? { ...w, colSpan: 3 as const, height: 380 }
          : { ...w, colSpan: 1 as const, height: 260 };
      }
      return w;
    });
    // v0.9.24：预设布局只改列宽/高度（顺序不变），逐图同步远端；失败自动回滚
    updated.forEach((w, idx) => {
      const prev = dashboardWidgets[idx];
      if (prev && (prev.colSpan !== w.colSpan || prev.height !== w.height)) {
        void updateDashboardWidgetRemote(w.id, { colSpan: w.colSpan, height: w.height }).catch(() => {});
      }
    });
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 md:p-8 space-y-6">
      {/* Top Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center space-x-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider">
            <LayoutDashboard className="w-4 h-4 text-indigo-400" />
            <span>实时决策看板 (Executive Dashboard)</span>
          </div>
          <h1 className="text-xl md:text-2xl font-extrabold text-slate-100 tracking-tight">
            固化分析指标与自定义网格工作区
          </h1>
          <p className="text-xs text-slate-400">
            支持拖拽排序与鼠标拽拉调尺寸，自由打造个性化高效率仪表盘。
          </p>
          {/* v0.4.8 自主更新：数据源监测状态（轮询指纹比对，变化时重放 SQL 自动刷新） */}
          {watchedDsId && (
            <p className="text-[11px] text-slate-500 flex items-center space-x-1.5">
              {autoRefreshing ? (
                <RefreshCw className="w-3 h-3 text-indigo-400 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3 text-emerald-400" />
              )}
              <span>{autoRefreshing ? '正在自动刷新图表…' : autoUpdateMsg || '已开启数据变化自动监测与更新'}</span>
              {lastCheckedAt && <span className="text-slate-600">· 最近探测 {lastCheckedAt}</span>}
            </p>
          )}
        </div>

        <button
          onClick={() => setActiveTab('query')}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow transition-all shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>去智能问答探索新图表</span>
        </button>
      </div>

      {/* Interactive Grid Layout Control & Theme Toolbar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs">
          {/* Layout Editing Mode Toggle */}
          <div className="flex items-center space-x-2 flex-wrap gap-y-2">
            <button
              onClick={() => setIsEditingLayout(!isEditingLayout)}
              className={`px-3 py-1.5 rounded-xl border font-bold text-xs flex items-center space-x-1.5 transition-all shadow ${
                isEditingLayout
                  ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 ring-2 ring-emerald-500/30'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {isEditingLayout ? (
                <>
                  <Unlock className="w-4 h-4 text-emerald-400 animate-pulse" />
                  <span>自定义网格编辑中 (拖拽已开启)</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4 text-slate-400" />
                  <span>已锁定看板布局 (开启调整)</span>
                </>
              )}
            </button>

            {/* Layout Quick Presets */}
            {isEditingLayout && (
              <div className="flex items-center space-x-1 border border-slate-800 bg-slate-950 p-1 rounded-xl">
                <span className="text-[10px] text-slate-400 font-bold px-1.5">网格预设:</span>
                <button
                  onClick={() => applyPresetLayout('three')}
                  className="px-2 py-1 rounded-lg hover:bg-slate-800 text-slate-300 text-[11px] font-medium flex items-center space-x-1"
                  title="全等三列三等分"
                >
                  <Grid className="w-3 h-3 text-indigo-400" />
                  <span>等分三列</span>
                </button>
                <button
                  onClick={() => applyPresetLayout('two')}
                  className="px-2 py-1 rounded-lg hover:bg-slate-800 text-slate-300 text-[11px] font-medium flex items-center space-x-1"
                  title="双列大网格"
                >
                  <Columns className="w-3 h-3 text-cyan-400" />
                  <span>双列网格</span>
                </button>
                <button
                  onClick={() => applyPresetLayout('hero')}
                  className="px-2 py-1 rounded-lg hover:bg-slate-800 text-slate-300 text-[11px] font-medium flex items-center space-x-1"
                  title="首图通铺+副图并列"
                >
                  <Maximize2 className="w-3 h-3 text-amber-400" />
                  <span>主图聚焦</span>
                </button>
              </div>
            )}
          </div>

          {/* Theme Palette & Contrast */}
          <div className="flex items-center space-x-3 shrink-0 flex-wrap gap-y-2">
            <div className="flex items-center space-x-2">
              <Palette className="w-4 h-4 text-indigo-400 shrink-0" />
              <span className="font-bold text-slate-200">配色:</span>
              <div className="flex items-center space-x-1 overflow-x-auto py-0.5">
                {Object.values(CHART_THEMES).slice(0, 4).map((theme) => {
                  const isActive = globalThemeId === theme.id;
                  return (
                    <button
                      key={theme.id}
                      onClick={() => setGlobalThemeId(theme.id)}
                      className={`px-2 py-1 rounded-lg border text-[10px] font-bold flex items-center space-x-1 shrink-0 transition-all ${
                        isActive
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-400'
                      }`}
                    >
                      <span className="flex items-center space-x-0.5">
                        {theme.colors.slice(0, 2).map((c, i) => (
                          <span
                            key={i}
                            className="w-1.5 h-1.5 rounded-full inline-block"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </span>
                      <span>{theme.name.split(' ')[0]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex items-center space-x-1.5 cursor-pointer hover:text-slate-200 text-[11px] text-slate-400">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              <span>智能高对比度</span>
              <input
                type="checkbox"
                checked={globalAutoContrast}
                onChange={(e) => setGlobalAutoContrast(e.target.checked)}
                className="rounded accent-indigo-500 ml-1"
              />
            </label>
          </div>
        </div>

        {/* Layout Mode Helper Banner */}
        {isEditingLayout && (
          <div className="p-2.5 rounded-xl bg-indigo-950/40 border border-indigo-500/30 text-[11px] text-indigo-200 flex items-center justify-between gap-2 animate-fadeIn">
            <div className="flex items-center space-x-2">
              <Move className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span>
                <strong>拖拽排版指南:</strong> 按住图表左上角的 <code className="text-emerald-300">拖拽柄</code> 可互换卡片顺序；拖拽右下角 <code className="text-emerald-300">resize 抓手</code> 可自由缩放图表宽度与高度。
              </span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">
              网格总列数: 3 Columns
            </span>
          </div>
        )}
      </div>

      {/* P2-14 语义层看板端：语义指标直查面板（口径与问数/报表共享同一语义层定义） */}
      {canQueryMetric && dbSources.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
          <div className="flex items-center space-x-2 text-xs font-bold text-slate-200">
            <Gauge className="w-4 h-4 text-cyan-400 shrink-0" />
            <span>语义指标直查</span>
            <span className="text-[10px] text-slate-500 font-normal">
              指标口径来自语义层登记定义（治理审批后生效），与智能问数 / 报表中心共享同一权威口径
            </span>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center gap-2 text-xs">
            <select
              value={effectiveMetricDsId}
              onChange={(e) => setMetricDsId(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
              title="选择数据源"
            >
              {dbSources.map((ds) => (
                <option key={ds.id} value={ds.id}>{ds.name}</option>
              ))}
            </select>

            <select
              value={metricId}
              onChange={(e) => {
                setMetricId(e.target.value ? Number(e.target.value) : '');
                setMetricDims([]);
                setMetricResult(null);
                setMetricError('');
              }}
              disabled={metricList.length === 0}
              className="bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-cyan-500 min-w-[220px]"
              title="选择已生效的语义指标"
            >
              <option value="">{metricList.length === 0 ? '该数据源暂无已生效指标' : '选择语义指标'}</option>
              {metricList.map((m) => (
                <option key={m.id} value={m.id}>{m.name}（{m.expr} · 表 {m.tableName}）</option>
              ))}
            </select>

            {selectedMetric && selectedMetric.dimensions.length > 0 && (
              <div className="flex items-center flex-wrap gap-1.5">
                <span className="text-slate-500 shrink-0">切分维度:</span>
                {selectedMetric.dimensions.map((d) => {
                  const checked = metricDims.includes(d);
                  return (
                    <label
                      key={d}
                      className={`flex items-center space-x-1 px-2 py-1 rounded-lg border cursor-pointer text-[11px] transition-colors ${
                        checked
                          ? 'bg-cyan-600/20 border-cyan-500 text-cyan-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setMetricDims((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
                        }
                        className="accent-cyan-500"
                      />
                      <span>{d}</span>
                    </label>
                  );
                })}
              </div>
            )}

            <AmountUnitSelect module="dashboard" />

            <button
              onClick={() => void runMetricQuery()}
              disabled={!selectedMetric || metricBusy}
              className="px-3.5 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-semibold shadow transition-all shrink-0"
            >
              {metricBusy ? '查询中…' : '查询指标'}
            </button>
          </div>

          {metricError && <p className="text-xs text-rose-400">{metricError}</p>}

          {metricResult && (
            <div className="border border-slate-800 rounded-xl p-3 space-y-2 bg-slate-950/60">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[11px] text-slate-400 truncate">
                  结果 {metricResult.rows.length} 行{metricResult.dims.length > 0 ? ` · 按 ${metricResult.dims.join(' / ')} 分组` : ''}
                  {metricResult.unitLabel && <span className="ml-1 text-amber-400/90">· 金额单位：{metricResult.unitLabel}</span>}
                  {metricResult.sql && <code className="ml-2 text-slate-600">{metricResult.sql}</code>}
                </span>
                <button
                  onClick={pinMetricResult}
                  disabled={metricPinned || metricResult.rows.length === 0}
                  className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-[11px] font-semibold transition-colors shrink-0"
                >
                  {metricPinned ? '✓ 已固化至看板' : '固化至看板'}
                </button>
              </div>

              {metricResult.rows.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">查询成功但无数据行</p>
              ) : metricResult.dims.length === 0 ? (
                <div className="flex items-baseline space-x-2 py-2">
                  <span className="text-3xl font-extrabold text-cyan-300">
                    {(() => {
                      const v = metricResult.rows[0]?.value;
                      return typeof v === 'number' ? v.toLocaleString('zh-CN') : String(v ?? '-');
                    })()}
                  </span>
                  <span className="text-xs text-slate-400">
                    {metricResult.metricName}
                    {metricResult.unitLabel && <span className="ml-1 text-amber-400/90">（{metricResult.unitLabel}）</span>}
                  </span>
                </div>
              ) : (
                <DynamicChart
                  config={{
                    type: 'bar',
                    title: metricResult.unitLabel ? `${metricResult.metricName}（${metricResult.unitLabel}）` : metricResult.metricName,
                    xAxisKey: metricResult.dims[0],
                    yAxisKeys: ['value'],
                    yAxisNames: { value: metricResult.unitLabel ? `${metricResult.metricName}（${metricResult.unitLabel}）` : metricResult.metricName },
                    xAxisName: metricResult.dims[0],
                  }}
                  data={metricResult.rows}
                  height={240}
                  globalThemeId={globalThemeId}
                  autoOptimizeContrast={globalAutoContrast}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Grid Layout Container */}
      {dashboardWidgets.length > 0 ? (
        <div
          className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 relative transition-all ${
            isEditingLayout ? 'p-1 border border-dashed border-slate-800 rounded-3xl bg-slate-950/50' : ''
          }`}
        >
          {dashboardWidgets.map((widget, index) => {
            const colSpan = widget.colSpan || 1;
            const height = widget.height || 280;

            const colSpanClass =
              colSpan === 2
                ? 'md:col-span-2'
                : colSpan === 3
                ? 'md:col-span-3'
                : 'col-span-1';

            const isDraggingThis = draggedIndex === index;
            const isDragOverThis = dragOverIndex === index && draggedIndex !== index;
            const isResizingThis = resizingWidgetId === widget.id;

            return (
              <div
                key={widget.id}
                draggable={isEditingLayout}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                className={`group bg-slate-900 border rounded-2xl p-5 space-y-3 shadow-lg transition-all relative flex flex-col justify-between ${colSpanClass} ${
                  isDraggingThis
                    ? 'opacity-40 border-indigo-500 border-dashed bg-indigo-950/30 scale-95'
                    : isDragOverThis
                    ? 'border-emerald-400 ring-2 ring-emerald-500/50 bg-emerald-950/30 scale-[1.01]'
                    : isResizingThis
                    ? 'border-indigo-400 ring-2 ring-indigo-500/50 shadow-2xl'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                {/* Drag Target Highlight overlay */}
                {isDragOverThis && (
                  <div className="absolute inset-0 bg-emerald-500/10 border-2 border-emerald-400 border-dashed rounded-2xl z-40 pointer-events-none flex items-center justify-center">
                    <span className="px-3 py-1.5 rounded-xl bg-emerald-950 text-emerald-300 font-bold text-xs border border-emerald-400 shadow-xl">
                      松开即可将图表放置于此位置
                    </span>
                  </div>
                )}

                {/* Card Top Header */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <div className="flex items-center space-x-2">
                    {/* Drag Handle */}
                    {isEditingLayout ? (
                      <div
                        className="cursor-grab active:cursor-grabbing p-1 rounded-lg bg-slate-800 text-indigo-400 hover:bg-indigo-600 hover:text-white transition-colors"
                        title="按住拖拽调整此图表在看板中的顺序"
                      >
                        <GripVertical className="w-4 h-4" />
                      </div>
                    ) : (
                      <BarChart3 className="w-4 h-4 text-indigo-400" />
                    )}

                    <h3 className="font-bold text-xs text-slate-100 truncate">{widget.title}</h3>
                    {/* v0.4.8 自主更新：最近一次自动刷新时间角标 */}
                    {widget.lastAutoUpdatedAt && (
                      <span
                        className="text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded-full whitespace-nowrap"
                        title="数据源变化后已自动重放 SQL 刷新"
                      >
                        自动更新 {new Date(widget.lastAutoUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
                      </span>
                    )}
                  </div>

                  {/* Header Actions & Column Span quick toggles */}
                  <div className="flex items-center space-x-2">
                    {isEditingLayout && (
                      <div className="flex items-center space-x-1 bg-slate-950 border border-slate-800 p-0.5 rounded-lg text-[10px]">
                        <span className="text-slate-500 px-1 font-mono">列宽:</span>
                        <button
                          onClick={() => void updateDashboardWidgetRemote(widget.id, { colSpan: 1 }).catch(() => {})}
                          className={`px-1.5 py-0.5 rounded ${
                            colSpan === 1
                              ? 'bg-indigo-600 text-white font-bold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          1x
                        </button>
                        <button
                          onClick={() => void updateDashboardWidgetRemote(widget.id, { colSpan: 2 }).catch(() => {})}
                          className={`px-1.5 py-0.5 rounded ${
                            colSpan === 2
                              ? 'bg-indigo-600 text-white font-bold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          2x
                        </button>
                        <button
                          onClick={() => void updateDashboardWidgetRemote(widget.id, { colSpan: 3 }).catch(() => {})}
                          className={`px-1.5 py-0.5 rounded ${
                            colSpan === 3
                              ? 'bg-indigo-600 text-white font-bold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          3x
                        </button>
                      </div>
                    )}

                    <button
                      onClick={() => void removeDashboardWidgetRemote(widget.id).catch((err) => window.alert(err?.message || '移除看板图表失败'))}
                      className="p-1 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition-colors"
                      title="从看板移除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Chart Render */}
                <div className="w-full relative">
                  <DynamicChart
                    config={widget.chartConfig}
                    data={widget.data}
                    height={height}
                    globalThemeId={globalThemeId}
                    autoOptimizeContrast={globalAutoContrast}
                  />
                </div>

                {/* Card Footer & Mouse Corner Resize Handle */}
                {isEditingLayout && (
                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px] text-slate-400 font-mono">
                    <span className="flex items-center space-x-1">
                      <span>尺寸: {colSpan}列宽 × {height}px高</span>
                    </span>

                    {/* Interactive Drag Handle at Bottom Right */}
                    <div
                      onMouseDown={(e) => handleResizeStart(e, widget)}
                      className="cursor-se-resize p-1.5 rounded-lg bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white transition-all flex items-center space-x-1 border border-slate-700 shadow-sm"
                      title="拖拽此右下角抓手，可实时调宽或调高卡片"
                    >
                      <Maximize2 className="w-3 h-3" />
                      <span className="font-bold text-[9px] uppercase">拖拽缩放</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="p-12 text-center bg-slate-900/40 border border-slate-800 rounded-3xl space-y-3">
          <LayoutDashboard className="w-10 h-10 text-slate-500 mx-auto" />
          <h3 className="font-bold text-slate-200 text-sm">看板暂无固化图表</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            在“智能问答”交互过程中，点击图表上方的“固定至看板”按钮，即可将关键图表钉在此处方便日常例会汇报与监控。
          </p>
        </div>
      )}
    </div>
  );
};
