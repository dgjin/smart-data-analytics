/**
 * 数据血缘视图容器（血缘管理优化 P0）：
 * - 主路径：拉取 GET /api/lineage/graph（服务端表级血缘聚合）→ React Flow 画布 + 影响分析面板；
 * - 降级路径：接口不可用时保留本地声明式三列推导（LineageFallbackView，三级兜底不删除），
 *   顶部显示「本地声明式估算」提示条（fail-open，绝不影响其他页面）；
 * - 容器职责：数据获取、统计条、搜索/类型过滤、聚焦模式状态、复制 toast；
 *   画布与面板视觉计算委托 utils/lineageGraph 纯函数。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GitFork, Filter, Search, Layers, AlertTriangle, Loader2, MousePointer } from 'lucide-react';
import { apiFetch, parseApiErrorBody } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import { matchNodes, upstreamClosure, downstreamClosure } from '../../utils/lineageGraph';
import type { LineageGraph, LineageNodeType } from '../../utils/lineageGraph';
import { LineageCanvas } from './lineage/LineageCanvas';
import { LineageImpactPanel } from './lineage/LineageImpactPanel';
import { LineageFallbackView } from './lineage/LineageFallbackView';

/** 类型过滤 chips（对齐画布节点着色） */
const TYPE_FILTERS: Array<{ type: LineageNodeType; label: string; activeClass: string }> = [
  { type: 'table', label: '表', activeClass: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300' },
  { type: 'metric', label: '指标', activeClass: 'bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-300' },
  { type: 'report', label: '报表', activeClass: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300' },
  { type: 'widget', label: '图表', activeClass: 'bg-amber-500/20 border-amber-500/50 text-amber-300' },
];

/** 统计条单项 */
const StatChip: React.FC<{ label: string; value: string | number; tone?: 'default' | 'ok' | 'warn' | 'danger' }> = ({
  label,
  value,
  tone = 'default',
}) => {
  const toneClass =
    tone === 'warn'
      ? 'border-amber-500/40 bg-amber-950/40 text-amber-300'
      : tone === 'danger'
        ? 'border-rose-500/40 bg-rose-950/40 text-rose-300'
        : 'border-slate-800 bg-slate-950 text-slate-300';
  return (
    <span className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium ${toneClass}`}>
      {label} <span className="font-bold">{value}</span>
    </span>
  );
};

export const DataLineageView: React.FC = () => {
  const [graph, setGraph] = useState<LineageGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<Set<LineageNodeType>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string): void => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  };

  // 拉取服务端血缘图（失败 → 降级本地声明式估算）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/lineage/graph');
        if (!res.ok) throw new Error((await parseApiErrorBody(res)).error);
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.nodes)) throw new Error('血缘图数据格式异常');
        if (cancelled) return;
        setGraph({
          generatedAt: data.generatedAt || new Date().toISOString(),
          stats:
            data.stats ||
            {
              nodes: data.nodes.length,
              edges: (data.edges || []).length,
              parsedEdges: 0,
              declaredEdges: 0,
              staleEdges: 0,
              parseCoverage: 1,
            },
          nodes: data.nodes,
          edges: data.edges || [],
        });
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // 搜索匹配集合（null = 未激活）；类型过滤空集合视为不过滤
  const matchedIds = useMemo(
    () => (graph ? matchNodes(graph, searchQuery, typeFilter) : null),
    [graph, searchQuery, typeFilter],
  );

  // 聚焦子集：以选中节点为中心的上下游闭包 + 自身
  const visibleIds = useMemo(() => {
    if (!graph || !focusMode || !selectedId) return null;
    const up = upstreamClosure(graph, selectedId);
    const down = downstreamClosure(graph, selectedId);
    return new Set([...up.nodeIds, ...down.nodeIds, selectedId]);
  }, [graph, focusMode, selectedId]);

  const handleSelect = (id: string | null): void => {
    setSelectedId(id);
    if (!id) setFocusMode(false);
  };

  const resetAll = (): void => {
    setSelectedId(null);
    setHoveredId(null);
    setFocusMode(false);
    setSearchQuery('');
    setTypeFilter(new Set());
  };

  const toggleType = (t: LineageNodeType): void => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const hasActiveState = Boolean(selectedId || hoveredId || searchQuery || typeFilter.size > 0 || focusMode);

  // ---- 加载态 ----
  if (loading) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-8 shadow-xl">
        <div className="flex items-center justify-center py-20 text-sm text-slate-400 gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
          <span>正在聚合数据血缘图（数据源 / 表 / 指标 / 报表 / 图表）…</span>
        </div>
      </div>
    );
  }

  // ---- 降级态：本地声明式估算（三级兜底推导保留，不删除） ----
  if (error || !graph) {
    return (
      <div className="space-y-4">
        <div className="bg-amber-950/60 border border-amber-500/40 rounded-2xl px-4 py-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200 leading-relaxed">
            <span className="font-bold">血缘服务暂不可用，当前为本地声明式估算。</span>
            <span className="text-amber-300/80 ml-1">（{error || '未知错误'}；服务恢复后自动切换为服务端表级血缘）</span>
          </div>
        </div>
        <LineageFallbackView />
      </div>
    );
  }

  const coveragePct = Math.round((graph.stats.parseCoverage ?? 1) * 100);
  const lowCoverage = coveragePct < 60;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-8 space-y-5 shadow-xl relative">
      {/* Title & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              Data Lineage Engine
            </span>
            <span className="text-xs text-slate-400 flex items-center space-x-1">
              <GitFork className="w-3.5 h-3.5 text-cyan-400" />
              <span>表级血缘自动采集 · 影响分析 · 定期验证</span>
            </span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold text-slate-100 tracking-tight">
            全域数据血缘与计算流向图 (End-to-End Data Lineage)
          </h2>
          <p className="text-xs text-slate-400 flex items-center space-x-1">
            <MousePointer className="w-3.5 h-3.5 text-emerald-400" />
            <span>悬停节点高亮上下游链路；点击节点查看影响分析（爆炸半径）并聚焦相关链路。</span>
          </p>
        </div>

        {/* 重置按钮常驻占位（invisible 切换），避免条件渲染在窄屏头部插入新行导致跳动 */}
        <button
          onClick={resetAll}
          className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors shrink-0 ${
            hasActiveState ? 'visible' : 'invisible pointer-events-none'
          }`}
        >
          <Filter className="w-3.5 h-3.5 text-indigo-400" />
          <span>重置视图</span>
        </button>
      </div>

      {/* 统计条 + 搜索/类型过滤 */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatChip label="节点" value={graph.stats.nodes} />
          <StatChip label="边" value={graph.stats.edges} />
          <StatChip label="解析覆盖率" value={`${coveragePct}%`} tone={lowCoverage ? 'warn' : 'ok'} />
          {graph.stats.staleEdges > 0 && <StatChip label="失效边" value={graph.stats.staleEdges} tone="danger" />}
          <span className="text-[10px] text-slate-500 flex items-center gap-1">
            <Layers className="w-3 h-3" />
            parsed {graph.stats.parsedEdges} · declared {graph.stats.declaredEdges}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索节点（表 / 指标 / 报表 / 图表）"
              className="w-60 pl-8 pr-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500/60"
            />
          </div>
          {TYPE_FILTERS.map((f) => {
            const active = typeFilter.has(f.type);
            return (
              <button
                key={f.type}
                onClick={() => toggleType(f.type)}
                className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                  active ? f.activeClass : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-300'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 解析覆盖率偏低提示 */}
      {lowCoverage && (
        <div className="bg-amber-950/40 border border-amber-500/30 rounded-xl px-3 py-2 text-[11px] text-amber-300 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>解析覆盖率偏低（{coveragePct}%），建议在报表/图表生成侧补全 SQL 来源，减少声明式（declared）边。</span>
        </div>
      )}

      {/* 画布 + 影响分析面板 */}
      <div className={`grid grid-cols-1 gap-4 ${selectedId ? 'xl:grid-cols-[minmax(0,1fr)_340px]' : ''}`}>
        <div className="h-[560px] md:h-[620px] rounded-2xl border border-slate-800 overflow-hidden bg-slate-950">
          <LineageCanvas
            graph={graph}
            selectedId={selectedId}
            hoveredId={hoveredId}
            matchedIds={matchedIds}
            visibleIds={visibleIds}
            onSelect={handleSelect}
            onHover={setHoveredId}
          />
        </div>
        {selectedId && (
          <div
            className={`min-h-0 ${
              visibleIds && selectedId ? 'h-[560px] md:h-[620px]' : 'h-[420px] md:h-[620px]'
            }`}
          >
            <LineageImpactPanel
              graph={graph}
              selectedId={selectedId}
              focusMode={focusMode}
              onToggleFocus={() => setFocusMode((v) => !v)}
              onNavigate={(id) => setSelectedId(id)}
              onCopied={() => showToast('影响清单已复制到剪贴板')}
              onClose={() => handleSelect(null)}
            />
          </div>
        )}
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-emerald-600/90 text-white text-xs font-medium shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
};
