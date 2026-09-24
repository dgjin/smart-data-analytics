/**
 * 血缘管理优化 P0：前端血缘图工具（纯函数，便于单测）。
 * 消费服务端 GET /api/lineage/graph 的输出（类型为镜像定义，前端自包含、不做跨端导入）；
 * 职责分层：
 *   - 图论：buildIndex / upstreamClosure / downstreamClosure / impactSummary
 *   - 交互：matchNodes（搜索匹配）/ layoutLineageGraph（分层布局）
 *   - 渲染：toFlowGraph（领域图 → React Flow 节点与边，含视觉状态）
 * 节点 ID 前缀约定（与服务端一致）：ds: / tbl:<dsId>: / metric: / report: / widget:
 */
import type { Node, Edge } from '@xyflow/react';
import type { CSSProperties } from 'react';

// ============ 血缘图类型（镜像 server/lineage/graph.ts 的 API 输出） ============

export type LineageNodeType = 'datasource' | 'table' | 'metric' | 'report' | 'widget';
export type LineageEdgeKind = 'contains' | 'consumes' | 'derives';
export type LineageEdgeSource = 'parsed' | 'declared';
export type LineageEdgeStatus = 'active' | 'stale';

export interface LineageNodeMeta {
  /** 数据源：类型 / 表总数 / 被引用表数 / Schema 同步时间 */
  dsType?: string;
  tablesTotal?: number;
  tablesReferenced?: number;
  lastSyncedAt?: string;
  /** 表：对象类型（TABLE / VIEW / …）与「SQL 引用但不在当前 Schema」标记 */
  tableType?: string;
  unresolved?: boolean;
  /** 指标：表达式 / 审批与启停状态 / 归属表 */
  expr?: string;
  metricStatus?: string;
  tableName?: string;
  /** 报表 / 图表：模板 / 图表类型 / 创建时间 / SQL 条数 */
  templateType?: string;
  chartType?: string;
  createdAt?: string;
  sqlCount?: number;
}

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  label: string;
  dataSourceId?: string;
  meta?: LineageNodeMeta;
}

export interface LineageEdge {
  id: string;
  from: string;
  to: string;
  kind: LineageEdgeKind;
  sourceType: LineageEdgeSource;
  /** 证据说明（如「报表 SQL #2」「数据资源库推演」） */
  evidence?: string;
  /** 验证时间（消费物创建时间 / 数据源 Schema 同步时间） */
  lastVerifiedAt?: string;
  status: LineageEdgeStatus;
}

export interface LineageStats {
  nodes: number;
  edges: number;
  /** 消费边（consumes/derives，不含 contains 结构边）的证据分级计数 */
  parsedEdges: number;
  declaredEdges: number;
  staleEdges: number;
  /** 解析覆盖率 = parsed / (parsed + declared)；无消费边时为 1 */
  parseCoverage: number;
}

export interface LineageGraph {
  generatedAt: string;
  stats: LineageStats;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

// ============ 邻接索引与闭包 ============

export interface LineageIndex {
  nodeById: Map<string, LineageNode>;
  /** 节点 → 入边（edge.to === 节点） */
  incoming: Map<string, LineageEdge[]>;
  /** 节点 → 出边（edge.from === 节点） */
  outgoing: Map<string, LineageEdge[]>;
}

/** 构建邻接表索引（同一份图多次查询时复用） */
export function buildIndex(graph: LineageGraph): LineageIndex {
  const nodeById = new Map<string, LineageNode>();
  const incoming = new Map<string, LineageEdge[]>();
  const outgoing = new Map<string, LineageEdge[]>();
  for (const n of graph.nodes) nodeById.set(n.id, n);
  const push = (map: Map<string, LineageEdge[]>, key: string, edge: LineageEdge): void => {
    const list = map.get(key);
    if (list) list.push(edge);
    else map.set(key, [edge]);
  };
  for (const e of graph.edges) {
    push(outgoing, e.from, e);
    push(incoming, e.to, e);
  }
  return { nodeById, incoming, outgoing };
}

export interface LineageClosure {
  /** 闭包内节点（不含起点自身） */
  nodeIds: Set<string>;
  /** 闭包内边 */
  edgeIds: Set<string>;
}

/** 闭包遍历：up 沿入边反向（上游）、down 沿出边正向（下游）；含环保护 */
function traverse(graph: LineageGraph, nodeId: string, dir: 'up' | 'down'): LineageClosure {
  const index = buildIndex(graph);
  const adjacency = dir === 'up' ? index.incoming : index.outgoing;
  const nodeIds = new Set<string>([nodeId]);
  const edgeIds = new Set<string>();
  const queue: string[] = [nodeId];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    for (const edge of adjacency.get(cur) || []) {
      edgeIds.add(edge.id);
      const next = dir === 'up' ? edge.from : edge.to;
      if (!nodeIds.has(next)) {
        nodeIds.add(next);
        queue.push(next);
      }
    }
  }
  nodeIds.delete(nodeId);
  return { nodeIds, edgeIds };
}

/** 上游闭包（数据从哪里来）：沿入边反向 BFS */
export function upstreamClosure(graph: LineageGraph, nodeId: string): LineageClosure {
  return traverse(graph, nodeId, 'up');
}

/** 下游闭包（影响什么）：沿出边正向 BFS */
export function downstreamClosure(graph: LineageGraph, nodeId: string): LineageClosure {
  return traverse(graph, nodeId, 'down');
}

// ============ 影响分析（爆炸半径） ============

export interface LineageImpactItem {
  id: string;
  label: string;
  kind: 'report' | 'widget' | 'metric';
  /** 距选中节点的跳数（数据源 → 表 → 消费物 = 2） */
  depth: number;
  /** 首跳到达边的证据（解析/声明 + 失效状态） */
  sourceType?: LineageEdgeSource;
  status?: LineageEdgeStatus;
  evidence?: string;
  lastVerifiedAt?: string;
}

export interface LineageImpactSummary {
  reports: LineageImpactItem[];
  widgets: LineageImpactItem[];
  metrics: LineageImpactItem[];
  total: number;
  /** 影响链中存在失效（stale）边 */
  hasStale: boolean;
}

/** 影响分析：下游可达的报表 / 图表 / 指标清单（按跳数升序） + 失效警示 */
export function impactSummary(graph: LineageGraph, nodeId: string): LineageImpactSummary {
  const index = buildIndex(graph);
  const visited = new Set<string>([nodeId]);
  const parentEdge = new Map<string, LineageEdge>();
  const depthOf = new Map<string, number>([[nodeId, 0]]);
  const queue: string[] = [nodeId];
  let head = 0;
  let hasStale = false;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    for (const edge of index.outgoing.get(cur) || []) {
      if (edge.status === 'stale') hasStale = true;
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      parentEdge.set(edge.to, edge);
      depthOf.set(edge.to, (depthOf.get(cur) ?? 0) + 1);
      queue.push(edge.to);
    }
  }
  visited.delete(nodeId);

  const items: LineageImpactItem[] = [];
  for (const id of visited) {
    const node = index.nodeById.get(id);
    if (!node || (node.type !== 'report' && node.type !== 'widget' && node.type !== 'metric')) continue;
    const edge = parentEdge.get(id);
    items.push({
      id,
      label: node.label,
      kind: node.type,
      depth: depthOf.get(id) ?? 0,
      ...(edge ? { sourceType: edge.sourceType, status: edge.status } : {}),
      ...(edge && edge.evidence ? { evidence: edge.evidence } : {}),
      ...(edge && edge.lastVerifiedAt ? { lastVerifiedAt: edge.lastVerifiedAt } : {}),
    });
  }
  const byDepth = (a: LineageImpactItem, b: LineageImpactItem) =>
    a.depth - b.depth || a.label.localeCompare(b.label);
  return {
    reports: items.filter((i) => i.kind === 'report').sort(byDepth),
    widgets: items.filter((i) => i.kind === 'widget').sort(byDepth),
    metrics: items.filter((i) => i.kind === 'metric').sort(byDepth),
    total: items.length,
    hasStale,
  };
}

// ============ 搜索匹配 ============

/**
 * 搜索匹配：名称模糊（大小写不敏感包含）+ 类型过滤。
 * 查询与类型均未激活时返回 null（无匹配态，全量正常显示）。
 */
export function matchNodes(
  graph: LineageGraph,
  query: string,
  types?: Iterable<LineageNodeType> | null,
): Set<string> | null {
  const q = query.trim().toLowerCase();
  const typeSet = types ? new Set(types) : null;
  if (!q && (!typeSet || typeSet.size === 0)) return null;
  const matched = new Set<string>();
  for (const node of graph.nodes) {
    if (q && !node.label.toLowerCase().includes(q)) continue;
    if (typeSet && typeSet.size > 0 && !typeSet.has(node.type)) continue;
    matched.add(node.id);
  }
  return matched;
}

// ============ 分层布局 ============

/** 层间距（x）/ 行间距（y）/ 节点卡宽度与估算高度（供建议画布尺寸与 React Flow 预测量） */
export const LINEAGE_LAYER_X = 340;
export const LINEAGE_ROW_Y = 76;
export const LINEAGE_NODE_WIDTH = 260;
export const LINEAGE_NODE_HEIGHT = 52;

export interface LineageLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  /** 建议画布尺寸（供容器预估） */
  width: number;
  height: number;
}

const byLabel = (a: LineageNode, b: LineageNode): number => a.label.localeCompare(b.label);

/**
 * 分层布局（确定性纯函数）：
 * 层分配：数据源 = 0 → 表 = 1 → 指标 = 2 → 报表/图表 = 3（x = 层序 × 340）；
 * 同层排序：数据源按名称；表按「上游数据源聚簇 + 名称」；消费物按「报表先于图表 + 创建时间倒序」；
 * y = 同层序号 × 76，固定行距天然去重叠（76 为验证后调优：原 96 使默认全图 fitView 缩放偏小）。
 */
export function layoutLineageGraph(nodes: LineageNode[], edges: LineageEdge[]): LineageLayoutResult {
  const positions = new Map<string, { x: number; y: number }>();

  // 层 0：数据源按名称；建立「数据源 → 层内序号」供表聚簇排序
  const dsNodes = nodes.filter((n) => n.type === 'datasource').sort(byLabel);
  const dsOrder = new Map(dsNodes.map((n, i) => [n.id, i]));

  // 表 → 上游数据源（优先节点字段；缺失时兜底从 contains 入边推演）
  const dsOfTable = new Map<string, string>();
  for (const n of nodes) if (n.type === 'table' && n.dataSourceId) dsOfTable.set(n.id, n.dataSourceId);
  for (const e of edges) {
    if (e.kind !== 'contains' || dsOfTable.has(e.to) || !e.from.startsWith('ds:')) continue;
    dsOfTable.set(e.to, e.from.slice(3));
  }

  // 层 1：表按「上游数据源聚簇 + 名称」，同源表相邻
  const tableNodes = nodes.filter((n) => n.type === 'table').sort((a, b) => {
    const oa = dsOrder.get(dsOfTable.get(a.id) ?? '') ?? Number.MAX_SAFE_INTEGER;
    const ob = dsOrder.get(dsOfTable.get(b.id) ?? '') ?? Number.MAX_SAFE_INTEGER;
    return oa - ob || byLabel(a, b);
  });

  // 层 2：指标按名称
  const metricNodes = nodes.filter((n) => n.type === 'metric').sort(byLabel);

  // 层 3：消费物「报表先于图表；同类型创建时间倒序（缺失视为最旧）」
  const consumerNodes = nodes
    .filter((n) => n.type === 'report' || n.type === 'widget')
    .sort((a, b) => {
      const ra = a.type === 'report' ? 0 : 1;
      const rb = b.type === 'report' ? 0 : 1;
      return ra - rb || (b.meta?.createdAt ?? '').localeCompare(a.meta?.createdAt ?? '') || byLabel(a, b);
    });

  const layers: Array<[LineageNode[], number]> = [
    [dsNodes, 0],
    [tableNodes, 1],
    [metricNodes, 2],
    [consumerNodes, 3],
  ];
  let maxCount = 0;
  for (const [list, layer] of layers) {
    maxCount = Math.max(maxCount, list.length);
    list.forEach((n, idx) => positions.set(n.id, { x: layer * LINEAGE_LAYER_X, y: idx * LINEAGE_ROW_Y }));
  }

  return {
    positions,
    width: 3 * LINEAGE_LAYER_X + LINEAGE_NODE_WIDTH,
    height: Math.max(maxCount, 1) * LINEAGE_ROW_Y,
  };
}

// ============ React Flow 图转换 ============

/** 视觉状态：highlighted（选中 / 悬停闭包 / 搜索命中）/ dimmed（变暗）/ normal */
export type LineageVisual = 'normal' | 'highlighted' | 'dimmed';

export type LineageFlowNodeData = {
  kind: LineageNodeType;
  label: string;
  meta?: LineageNodeMeta;
  selected: boolean;
  matched: boolean;
  visual: LineageVisual;
};

export type LineageFlowEdgeData = {
  kind: LineageEdgeKind;
  sourceType: LineageEdgeSource;
  status: LineageEdgeStatus;
  evidence?: string;
  visual: LineageVisual;
};

export interface LineageFlowGraph {
  nodes: Node<LineageFlowNodeData, 'lineage'>[];
  edges: Edge<LineageFlowEdgeData>[];
}

export interface FlowGraphContext {
  /** 选中（聚焦）节点 */
  selectedId?: string | null;
  /** 悬停节点（内部计算上下游闭包用于高亮） */
  hoveredId?: string | null;
  /** 搜索匹配集合（null/undefined 表示搜索未激活） */
  matchedIds?: Set<string> | null;
  /** 聚焦子集（null/undefined 表示展示全量；两端不可见的边会被移除） */
  visibleIds?: Set<string> | null;
}

/** 边基础配色（复用项目现有色系 500 档；declared 覆写 amber、stale 覆写 rose） */
const EDGE_COLORS: Record<LineageEdgeKind, string> = {
  contains: '#64748b', // slate-500：结构包含
  consumes: '#10b981', // emerald-500：表 → 消费物
  derives: '#d946ef', // fuchsia-500：表 → 指标
};
const EDGE_DECLARED_COLOR = '#f59e0b'; // amber-500：声明式（待验证）
const EDGE_STALE_COLOR = '#f43f5e'; // rose-500：失效
const EDGE_DIM_OPACITY = 0.15;

/** 边样式：按证据来源（parsed 实线 / declared 虚线）、失效与视觉状态计算 */
function edgeStyleOf(edge: LineageEdge, visual: LineageVisual): CSSProperties {
  const color =
    edge.status === 'stale'
      ? EDGE_STALE_COLOR
      : edge.sourceType === 'declared'
        ? EDGE_DECLARED_COLOR
        : EDGE_COLORS[edge.kind];
  const width =
    edge.kind === 'contains' ? (visual === 'highlighted' ? 1.8 : 1.2) : visual === 'highlighted' ? 2.5 : 1.8;
  return {
    stroke: color,
    strokeWidth: width,
    ...(edge.sourceType === 'declared' ? { strokeDasharray: '6 4' } : {}),
    ...(visual === 'dimmed' ? { opacity: EDGE_DIM_OPACITY } : {}),
  };
}

/** 领域图 → React Flow 节点 / 边（含选中 / 匹配 / 变暗视觉状态，纯函数） */
export function toFlowGraph(graph: LineageGraph, ctx: FlowGraphContext = {}): LineageFlowGraph {
  const { selectedId, hoveredId, matchedIds, visibleIds } = ctx;
  const { positions } = layoutLineageGraph(graph.nodes, graph.edges);

  // 悬停闭包（含悬停自身）：闭包内高亮、闭包外变暗
  let closureNodes: Set<string> | null = null;
  let closureEdges: Set<string> | null = null;
  if (hoveredId) {
    const up = upstreamClosure(graph, hoveredId);
    const down = downstreamClosure(graph, hoveredId);
    closureNodes = new Set([...up.nodeIds, ...down.nodeIds, hoveredId]);
    closureEdges = new Set([...up.edgeIds, ...down.edgeIds]);
  }

  const nodes: LineageFlowGraph['nodes'] = [];
  for (const n of graph.nodes) {
    if (visibleIds && !visibleIds.has(n.id)) continue;
    let visual: LineageVisual = 'normal';
    if (closureNodes) visual = closureNodes.has(n.id) ? 'highlighted' : 'dimmed';
    else if (matchedIds) visual = matchedIds.has(n.id) ? 'highlighted' : 'dimmed';
    nodes.push({
      id: n.id,
      type: 'lineage',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      // 声明固定几何：React Flow 12 受控模式（未接 onNodesChange）不会把 measured 回填到
      // userNode，MiniMap 按 userNode 尺寸判定节点可见性 → 不给尺寸则迷你地图恒为空。
      width: LINEAGE_NODE_WIDTH,
      initialHeight: LINEAGE_NODE_HEIGHT,
      data: {
        kind: n.type,
        label: n.label,
        ...(n.meta ? { meta: n.meta } : {}),
        selected: n.id === selectedId,
        matched: matchedIds ? matchedIds.has(n.id) : false,
        visual,
      },
    });
  }

  const visibleNow = new Set(nodes.map((n) => n.id));
  const edges: LineageFlowGraph['edges'] = [];
  for (const e of graph.edges) {
    if (!visibleNow.has(e.from) || !visibleNow.has(e.to)) continue;
    let visual: LineageVisual = 'normal';
    if (closureEdges) visual = closureEdges.has(e.id) ? 'highlighted' : 'dimmed';
    else if (matchedIds) visual = matchedIds.has(e.from) || matchedIds.has(e.to) ? 'highlighted' : 'dimmed';
    edges.push({
      id: e.id,
      source: e.from,
      target: e.to,
      style: edgeStyleOf(e, visual),
      data: {
        kind: e.kind,
        sourceType: e.sourceType,
        status: e.status,
        ...(e.evidence ? { evidence: e.evidence } : {}),
        visual,
      },
      ...(e.status === 'stale'
        ? { label: '⚠', labelStyle: { fill: EDGE_STALE_COLOR, fontSize: 12, fontWeight: 600 } }
        : {}),
    });
  }

  return { nodes, edges };
}
