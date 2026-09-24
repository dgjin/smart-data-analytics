/**
 * 影响分析面板（爆炸半径）：选中节点的下游可达报表 / 图表 / 指标清单。
 * - 三类计数卡 + 逐项清单（名称 + 血缘来源 parsed/declared + 验证时间 + 失效警示）
 * - 清单项点击 → 画布跳转并居中该节点（onNavigate）
 * - 「只看相关链路」开关（onToggleFocus）与「复制影响清单」（纯文本，供变更评审粘贴）
 */
import React, { useMemo } from 'react';
import { Radar, X, Copy, Focus, FileSpreadsheet, BarChart3, Sigma, AlertTriangle } from 'lucide-react';
import { impactSummary } from '../../../utils/lineageGraph';
import type { LineageGraph, LineageImpactItem } from '../../../utils/lineageGraph';

export interface LineageImpactPanelProps {
  graph: LineageGraph;
  selectedId: string;
  /** 聚焦模式：画布过滤为以选中节点为中心的上下游闭包子图 */
  focusMode: boolean;
  onToggleFocus: () => void;
  /** 清单项点击：画布跳转并居中该节点 */
  onNavigate: (id: string) => void;
  /** 复制成功后由容器弹提示（面板不持有 toast） */
  onCopied: () => void;
  onClose: () => void;
}

const KIND_ICONS = { report: FileSpreadsheet, widget: BarChart3, metric: Sigma } as const;

const formatDate = (iso?: string): string => (iso ? iso.slice(0, 10) : '—');

/** 复制清单文本：纯文本结构，供变更评审/工单粘贴 */
function buildReportText(graph: LineageGraph, nodeId: string, imp: ReturnType<typeof impactSummary>): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const lines: string[] = [
    '数据血缘影响清单（爆炸半径）',
    `节点：${node?.label || nodeId}（${nodeId}）`,
    `生成时间：${new Date().toLocaleString()}`,
    `受影响合计：${imp.total} 项（报表 ${imp.reports.length} / 图表 ${imp.widgets.length} / 指标 ${imp.metrics.length}）`,
  ];
  const section = (title: string, items: LineageImpactItem[]): void => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(`【${title}】${items.length} 项`);
    for (const it of items) {
      const source = it.sourceType === 'parsed' ? '解析' : '声明式';
      const stale = it.status === 'stale' ? ' · ⚠ 已失效' : '';
      const verified = it.lastVerifiedAt ? ` · 验证于 ${formatDate(it.lastVerifiedAt)}` : '';
      const evidence = it.evidence ? ` · 证据：${it.evidence}` : '';
      lines.push(`- ${it.label}（${source}${stale}${verified}${evidence}）`);
    }
  };
  section('受影响报表', imp.reports);
  section('受影响图表', imp.widgets);
  section('受影响指标', imp.metrics);
  if (imp.total === 0) lines.push('（无下游消费物）');
  return lines.join('\n');
}

/** 单类计数卡 */
const CountCard: React.FC<{ label: string; count: number; className: string }> = ({ label, count, className }) => (
  <div className={`rounded-xl border px-2 py-2 text-center ${className}`}>
    <div className="text-lg font-extrabold leading-none">{count}</div>
    <div className="text-[10px] mt-1 opacity-80">{label}</div>
  </div>
);

/** 清单项（点击跳转居中） */
const ImpactItemRow: React.FC<{ item: LineageImpactItem; onNavigate: (id: string) => void }> = ({ item, onNavigate }) => {
  const Icon = KIND_ICONS[item.kind];
  const stale = item.status === 'stale';
  return (
    <button
      onClick={() => onNavigate(item.id)}
      className={`w-full text-left p-2.5 rounded-xl border transition-colors ${
        stale
          ? 'bg-rose-950/40 border-rose-500/40 hover:border-rose-400'
          : 'bg-slate-900 border-slate-800 hover:border-slate-600'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-200 truncate" title={item.label}>
            {item.label}
          </span>
        </div>
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold border ${
            item.sourceType === 'parsed'
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
          }`}
        >
          {item.sourceType === 'parsed' ? '解析' : '声明式'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1 text-[10px] text-slate-500">
        <span className="truncate" title={item.evidence}>
          {stale && (
            <span className="text-rose-300 font-semibold inline-flex items-center gap-0.5 mr-1">
              <AlertTriangle className="w-2.5 h-2.5" />
              已失效
            </span>
          )}
          {item.evidence || `跳数 ${item.depth}`}
        </span>
        <span className="font-mono shrink-0">{formatDate(item.lastVerifiedAt)}</span>
      </div>
    </button>
  );
};

export const LineageImpactPanel: React.FC<LineageImpactPanelProps> = ({
  graph,
  selectedId,
  focusMode,
  onToggleFocus,
  onNavigate,
  onCopied,
  onClose,
}) => {
  const imp = useMemo(() => impactSummary(graph, selectedId), [graph, selectedId]);
  const node = graph.nodes.find((n) => n.id === selectedId);

  const handleCopy = async (): Promise<void> => {
    const text = buildReportText(graph, selectedId, imp);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文降级 execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    onCopied();
  };

  return (
    <div className="h-full min-h-0 rounded-2xl border border-slate-800 bg-slate-950 flex flex-col overflow-hidden">
      {/* 头部：选中节点 + 关闭 */}
      <div className="p-3.5 border-b border-slate-800 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
            <Radar className="w-3.5 h-3.5 text-indigo-400" />
            <span>影响分析（爆炸半径）</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1 truncate" title={selectedId}>
            选中节点：{node?.label || selectedId}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors shrink-0"
          title="关闭面板"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 三类计数卡 */}
      <div className="grid grid-cols-3 gap-1.5 p-3 pb-2">
        <CountCard
          label="受影响报表"
          count={imp.reports.length}
          className="border-emerald-500/30 bg-emerald-950/40 text-emerald-300"
        />
        <CountCard
          label="受影响图表"
          count={imp.widgets.length}
          className="border-amber-500/30 bg-amber-950/40 text-amber-300"
        />
        <CountCard
          label="受影响指标"
          count={imp.metrics.length}
          className="border-fuchsia-500/30 bg-fuchsia-950/40 text-fuchsia-300"
        />
      </div>

      {/* 操作行：聚焦开关 + 复制清单 */}
      <div className="px-3 pb-2 flex items-center justify-between gap-2">
        <button
          onClick={onToggleFocus}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
            focusMode
              ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
              : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-300'
          }`}
          title="将画布过滤为以选中节点为中心的上下游闭包子图"
        >
          <Focus className="w-3 h-3" />
          <span>只看相关链路</span>
          <span className={`w-6 h-3.5 rounded-full relative transition-colors ${focusMode ? 'bg-indigo-500' : 'bg-slate-700'}`}>
            <span
              className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${
                focusMode ? 'left-3' : 'left-0.5'
              }`}
            />
          </span>
        </button>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 text-[11px] font-medium hover:border-slate-500 transition-colors"
          title="复制纯文本影响清单（供变更评审粘贴）"
        >
          <Copy className="w-3 h-3" />
          <span>复制影响清单</span>
        </button>
      </div>

      {/* 失效警示条 */}
      {imp.hasStale && (
        <div className="mx-3 mb-2 px-2.5 py-2 rounded-xl bg-rose-950/50 border border-rose-500/40 text-[10px] text-rose-300 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span>影响链中存在失效血缘（引用的表不在当前 Schema），请先核验再变更。</span>
        </div>
      )}

      {/* 清单 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-3">
        {imp.total === 0 && (
          <div className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-[11px] text-slate-500">
            该节点暂无下游消费物（报表 / 图表 / 指标）
          </div>
        )}
        {imp.reports.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              受影响报表 ({imp.reports.length})
            </div>
            {imp.reports.map((item) => (
              <ImpactItemRow key={item.id} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        )}
        {imp.widgets.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              受影响图表 ({imp.widgets.length})
            </div>
            {imp.widgets.map((item) => (
              <ImpactItemRow key={item.id} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        )}
        {imp.metrics.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              受影响指标 ({imp.metrics.length})
            </div>
            {imp.metrics.map((item) => (
              <ImpactItemRow key={item.id} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
