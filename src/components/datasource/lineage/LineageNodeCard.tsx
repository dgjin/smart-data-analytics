/**
 * 血缘节点卡片（React Flow 自定义节点，节点类型注册名 'lineage'）。
 * 类型着色：数据源 indigo / 表 cyan / 指标 fuchsia / 报表 emerald / 图表 amber；
 * 血缘徽标：已解析（parsed SQL / 指标登记表）/ 声明式（无 SQL 证据）/ 不在 Schema（unresolved）。
 * 视觉状态由 toFlowGraph 派发：dimmed 变暗、highlighted 高亮、matched 脉冲、selected 聚焦。
 * Handle 按语义放置：数据源仅右出；表左右俱全；指标/报表/图表仅左入。
 */
import type { NodeProps, Node } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { Database, Table as TableIcon, Sigma, FileSpreadsheet, BarChart3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LineageFlowNodeData, LineageNodeType } from '../../../utils/lineageGraph';

/** 与 utils/lineageGraph.ts 的 LineageFlowGraph 节点类型对齐 */
export type LineageFlowNode = Node<LineageFlowNodeData, 'lineage'>;

const KIND_ICONS: Record<LineageNodeType, LucideIcon> = {
  datasource: Database,
  table: TableIcon,
  metric: Sigma,
  report: FileSpreadsheet,
  widget: BarChart3,
};

const KIND_STYLES: Record<LineageNodeType, { border: string; bg: string; iconBg: string; iconText: string }> = {
  datasource: {
    border: 'border-indigo-500/40',
    bg: 'bg-indigo-950/60',
    iconBg: 'bg-indigo-500/15',
    iconText: 'text-indigo-400',
  },
  table: { border: 'border-cyan-500/40', bg: 'bg-cyan-950/50', iconBg: 'bg-cyan-500/15', iconText: 'text-cyan-400' },
  metric: {
    border: 'border-fuchsia-500/40',
    bg: 'bg-fuchsia-950/50',
    iconBg: 'bg-fuchsia-500/15',
    iconText: 'text-fuchsia-400',
  },
  report: {
    border: 'border-emerald-500/40',
    bg: 'bg-emerald-950/50',
    iconBg: 'bg-emerald-500/15',
    iconText: 'text-emerald-400',
  },
  widget: { border: 'border-amber-500/40', bg: 'bg-amber-950/50', iconBg: 'bg-amber-500/15', iconText: 'text-amber-400' },
};

/** 副标题：按类型展示关键元信息（表名 / 表达式 / 模板 / 图表类型 / 表计数） */
function subtitleOf(data: LineageFlowNodeData): string {
  const m = data.meta;
  switch (data.kind) {
    case 'datasource': {
      const type = (m?.dsType || '').toUpperCase();
      return `${type ? `${type} · ` : ''}共 ${m?.tablesTotal ?? 0} 表 · 已引用 ${m?.tablesReferenced ?? 0}`;
    }
    case 'table':
      return m?.unresolved ? 'SQL 引用但不在当前 Schema' : m?.tableType || '数据表';
    case 'metric':
      return m?.expr || '语义指标口径';
    case 'report':
      return `${m?.templateType || '分析报告'} · ${m?.sqlCount ?? 0} 条 SQL`;
    case 'widget':
      return `${m?.chartType || '监控图表'} · ${m?.sqlCount ?? 0} 条 SQL`;
  }
}

/** 血缘徽标：失效（unresolved）/ 已解析 / 声明式 */
function badgeOf(data: LineageFlowNodeData): { text: string; className: string } | null {
  if (data.kind === 'table') {
    return data.meta?.unresolved
      ? { text: '不在 Schema', className: 'bg-rose-500/15 text-rose-300 border-rose-500/30' }
      : null;
  }
  const parsed =
    data.kind === 'metric'
      ? Boolean(data.meta?.tableName)
      : (data.meta?.sqlCount ?? 0) > 0;
  if (parsed) {
    return { text: '已解析', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  }
  return { text: '声明式', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
}

export const LineageNodeCard: React.FC<NodeProps<LineageFlowNode>> = ({ data, selected }) => {
  const kind = KIND_STYLES[data.kind];
  const Icon = KIND_ICONS[data.kind];
  const badge = badgeOf(data);

  // 状态优先级：dimmed < highlighted < matched < selected（互斥叠加，避免 ring 类冲突）
  let state = 'shadow-md';
  // dimmed 取 40%：25% 在浅色主题下几乎不可见，40% 仍明确让位于命中节点
  if (data.visual === 'dimmed') state = 'opacity-40';
  else if (selected) state = 'ring-2 ring-indigo-400 shadow-xl shadow-indigo-500/25';
  else if (data.matched) state = 'ring-2 ring-amber-400/80 animate-pulse';
  else if (data.visual === 'highlighted') state = 'ring-1 ring-emerald-400/60 shadow-lg';

  return (
    <div
      className={`w-[260px] rounded-xl border ${kind.border} ${kind.bg} ${state} px-3 py-2.5 transition-all duration-200`}
    >
      {data.kind !== 'datasource' && (
        <Handle type="target" position={Position.Left} className="!w-1.5 !h-1.5 !bg-slate-500 !border-slate-400" />
      )}
      {(data.kind === 'datasource' || data.kind === 'table') && (
        <Handle type="source" position={Position.Right} className="!w-1.5 !h-1.5 !bg-slate-500 !border-slate-400" />
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`p-1.5 rounded-lg border ${kind.border} ${kind.iconBg} shrink-0`}>
            <Icon className={`w-3.5 h-3.5 ${kind.iconText}`} />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-bold text-slate-100 truncate" title={data.label}>
              {data.label}
            </div>
            <div className="text-[10px] text-slate-400 font-mono truncate" title={subtitleOf(data)}>
              {subtitleOf(data)}
            </div>
          </div>
        </div>
        {badge && (
          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold border ${badge.className}`}>
            {badge.text}
          </span>
        )}
      </div>
    </div>
  );
};
