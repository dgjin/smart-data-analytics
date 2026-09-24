/**
 * 血缘管理优化 P0：前端血缘图工具单测（索引 / 闭包 / 影响 / 匹配 / 布局 / Flow 转换）。
 * fixture 不依赖中文排序细节：绝对顺序仅在原型确定的场景断言（层 x / 类型优先级），
 * 名称排序性质用集合与相对关系断言（跨 locale 环境稳定）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildIndex,
  upstreamClosure,
  downstreamClosure,
  impactSummary,
  matchNodes,
  layoutLineageGraph,
  toFlowGraph,
  LINEAGE_LAYER_X,
  LINEAGE_ROW_Y,
  LINEAGE_NODE_WIDTH,
  LINEAGE_NODE_HEIGHT,
  type LineageGraph,
} from './lineageGraph';

// ---- fixture：2 数据源 / 3 表 / 1 指标 / 1 报表 / 2 图表，覆盖 parsed/declared/stale ----
const graph: LineageGraph = {
  generatedAt: '2026-09-24T10:00:00.000Z',
  stats: { nodes: 9, edges: 8, parsedEdges: 6, declaredEdges: 1, staleEdges: 1, parseCoverage: 6 / 7 },
  nodes: [
    { id: 'ds:ds-a', type: 'datasource', label: '数据资源', dataSourceId: 'ds-a' },
    { id: 'ds:ds-b', type: 'datasource', label: '日志库', dataSourceId: 'ds-b' },
    { id: 'tbl:ds-a:orders', type: 'table', label: 'orders', dataSourceId: 'ds-a' },
    { id: 'tbl:ds-a:users', type: 'table', label: 'users', dataSourceId: 'ds-a' },
    { id: 'tbl:ds-b:logs', type: 'table', label: 'logs', dataSourceId: 'ds-b' },
    { id: 'metric:1', type: 'metric', label: '投放金额', dataSourceId: 'ds-a', meta: { expr: 'SUM(tfje)' } },
    {
      id: 'report:1',
      type: 'report',
      label: '不良资产经营简报',
      dataSourceId: 'ds-a',
      meta: { createdAt: '2026-09-20T00:00:00.000Z', sqlCount: 1 },
    },
    {
      id: 'widget:1',
      type: 'widget',
      label: '逐月投放走势',
      dataSourceId: 'ds-b',
      meta: { createdAt: '2026-09-10T00:00:00.000Z', sqlCount: 1 },
    },
    { id: 'widget:2', type: 'widget', label: '访问趋势', dataSourceId: 'ds-b', meta: { sqlCount: 0 } },
  ],
  edges: [
    { id: 'e1', from: 'ds:ds-a', to: 'tbl:ds-a:orders', kind: 'contains', sourceType: 'parsed', status: 'active' },
    { id: 'e2', from: 'ds:ds-a', to: 'tbl:ds-a:users', kind: 'contains', sourceType: 'parsed', status: 'active' },
    { id: 'e3', from: 'ds:ds-b', to: 'tbl:ds-b:logs', kind: 'contains', sourceType: 'parsed', status: 'active' },
    {
      id: 'e4',
      from: 'tbl:ds-a:orders',
      to: 'report:1',
      kind: 'consumes',
      sourceType: 'parsed',
      evidence: '报表 SQL #1',
      status: 'active',
    },
    {
      id: 'e5',
      from: 'tbl:ds-a:users',
      to: 'report:1',
      kind: 'consumes',
      sourceType: 'parsed',
      evidence: '报表 SQL #1',
      status: 'active',
    },
    {
      id: 'e6',
      from: 'tbl:ds-b:logs',
      to: 'widget:1',
      kind: 'consumes',
      sourceType: 'parsed',
      evidence: '图表固化 SQL',
      status: 'stale',
    },
    {
      id: 'e7',
      from: 'tbl:ds-a:orders',
      to: 'metric:1',
      kind: 'derives',
      sourceType: 'parsed',
      evidence: '指标归属表登记',
      status: 'active',
    },
    {
      id: 'e8',
      from: 'ds:ds-b',
      to: 'widget:2',
      kind: 'consumes',
      sourceType: 'declared',
      evidence: '数据源绑定（无表级 SQL 证据）',
      status: 'active',
    },
  ],
};

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('buildIndex：邻接表索引', () => {
  it('节点索引与出入边分组完整', () => {
    const index = buildIndex(graph);
    expect(index.nodeById.size).toBe(9);
    expect(index.outgoing.get('ds:ds-a')?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(index.incoming.get('report:1')?.map((e) => e.id)).toEqual(['e4', 'e5']);
    expect(index.incoming.get('ds:ds-a')).toBeUndefined();
    expect(index.outgoing.get('report:1')).toBeUndefined();
  });
});

describe('upstreamClosure / downstreamClosure：上下游闭包', () => {
  it('上游闭包沿入边反向可达（不含起点自身）', () => {
    const up = upstreamClosure(graph, 'report:1');
    expect(sorted(up.nodeIds)).toEqual(sorted(['tbl:ds-a:orders', 'tbl:ds-a:users', 'ds:ds-a']));
    expect(sorted(up.edgeIds)).toEqual(sorted(['e1', 'e2', 'e4', 'e5']));
    expect(up.nodeIds.has('report:1')).toBe(false);
  });

  it('下游闭包沿出边正向可达', () => {
    const down = downstreamClosure(graph, 'ds:ds-a');
    expect(sorted(down.nodeIds)).toEqual(
      sorted(['tbl:ds-a:orders', 'tbl:ds-a:users', 'metric:1', 'report:1']),
    );
    expect(sorted(down.edgeIds)).toEqual(sorted(['e1', 'e2', 'e4', 'e5', 'e7']));
  });

  it('环形图不死循环（环保护）', () => {
    const ring: LineageGraph = {
      generatedAt: graph.generatedAt,
      stats: graph.stats,
      nodes: [
        { id: 'n:a', type: 'table', label: 'a' },
        { id: 'n:b', type: 'table', label: 'b' },
      ],
      edges: [
        { id: 'r1', from: 'n:a', to: 'n:b', kind: 'consumes', sourceType: 'parsed', status: 'active' },
        { id: 'r2', from: 'n:b', to: 'n:a', kind: 'consumes', sourceType: 'parsed', status: 'active' },
      ],
    };
    const down = downstreamClosure(ring, 'n:a');
    expect(sorted(down.nodeIds)).toEqual(['n:b']);
    expect(sorted(down.edgeIds)).toEqual(['r1', 'r2']);
  });
});

describe('impactSummary：影响分析（爆炸半径）', () => {
  it('表的下游：报表与指标清单 + 首跳证据', () => {
    const imp = impactSummary(graph, 'tbl:ds-a:orders');
    expect(imp.reports.map((r) => r.id)).toEqual(['report:1']);
    expect(imp.metrics.map((m) => m.id)).toEqual(['metric:1']);
    expect(imp.widgets).toEqual([]);
    expect(imp.total).toBe(2);
    expect(imp.hasStale).toBe(false);
    expect(imp.reports[0].depth).toBe(1);
    expect(imp.reports[0].sourceType).toBe('parsed');
    expect(imp.reports[0].evidence).toBe('报表 SQL #1');
  });

  it('数据源跨表聚合 + stale 传播与跳数', () => {
    const imp = impactSummary(graph, 'ds:ds-b');
    expect(sorted(imp.widgets.map((w) => w.id))).toEqual(sorted(['widget:1', 'widget:2']));
    expect(imp.hasStale).toBe(true);
    const w1 = imp.widgets.find((w) => w.id === 'widget:1');
    expect(w1?.depth).toBe(2); // ds-b → logs → widget:1
    expect(w1?.status).toBe('stale');
    const w2 = imp.widgets.find((w) => w.id === 'widget:2');
    expect(w2?.depth).toBe(1); // ds-b 直接声明
    expect(w2?.sourceType).toBe('declared');
  });

  it('无下游的消费物返回空清单', () => {
    const imp = impactSummary(graph, 'report:1');
    expect(imp.total).toBe(0);
    expect(imp.reports).toEqual([]);
    expect(imp.hasStale).toBe(false);
  });
});

describe('matchNodes：搜索匹配', () => {
  it('未激活（空查询 + 无类型）返回 null', () => {
    expect(matchNodes(graph, '', null)).toBeNull();
    expect(matchNodes(graph, '   ', new Set())).toBeNull();
  });

  it('名称模糊匹配且大小写不敏感', () => {
    const m = matchNodes(graph, 'ORDERS');
    expect(m && sorted(m)).toEqual(['tbl:ds-a:orders']);
    const cn = matchNodes(graph, '简报');
    expect(cn && sorted(cn)).toEqual(['report:1']);
  });

  it('类型过滤与空查询组合', () => {
    const m = matchNodes(graph, '', ['report', 'widget']);
    expect(m && sorted(m)).toEqual(sorted(['report:1', 'widget:1', 'widget:2']));
  });

  it('无命中返回空集合而非 null', () => {
    const m = matchNodes(graph, 'zzz-不存在');
    expect(m).not.toBeNull();
    expect(m && m.size).toBe(0);
  });
});

describe('layoutLineageGraph：分层布局', () => {
  const layout = layoutLineageGraph(graph.nodes, graph.edges);
  const pos = (id: string) => layout.positions.get(id)!;
  const yOf = (id: string) => pos(id).y;

  it('层分配：数据源 0 / 表 1 / 指标 2 / 消费物 3', () => {
    expect(pos('ds:ds-a').x).toBe(0);
    expect(pos('tbl:ds-a:orders').x).toBe(LINEAGE_LAYER_X);
    expect(pos('metric:1').x).toBe(2 * LINEAGE_LAYER_X);
    expect(pos('report:1').x).toBe(3 * LINEAGE_LAYER_X);
    expect(pos('widget:1').x).toBe(3 * LINEAGE_LAYER_X);
  });

  it('数据源层按名称排序占位 0 / 1 行距', () => {
    const dsYs = [yOf('ds:ds-a'), yOf('ds:ds-b')].sort((a, b) => a - b);
    expect(dsYs).toEqual([0, LINEAGE_ROW_Y]);
  });

  it('表按上游数据源聚簇：同源两表相邻、三层占满 0/1/2 行距', () => {
    const tblYs = [yOf('tbl:ds-a:orders'), yOf('tbl:ds-a:users'), yOf('tbl:ds-b:logs')].sort((a, b) => a - b);
    expect(tblYs).toEqual([0, LINEAGE_ROW_Y, 2 * LINEAGE_ROW_Y]);
    expect(Math.abs(yOf('tbl:ds-a:orders') - yOf('tbl:ds-a:users'))).toBe(LINEAGE_ROW_Y);
  });

  it('消费物：报表先于图表，创建时间倒序（缺失视为最旧）', () => {
    expect(yOf('report:1')).toBeLessThan(yOf('widget:1'));
    expect(yOf('widget:1')).toBeLessThan(yOf('widget:2'));
    expect(yOf('widget:2')).toBe(2 * LINEAGE_ROW_Y);
  });

  it('建议画布尺寸', () => {
    expect(layout.width).toBe(3 * LINEAGE_LAYER_X + LINEAGE_NODE_WIDTH);
    expect(layout.height).toBe(3 * LINEAGE_ROW_Y);
  });
});

describe('toFlowGraph：React Flow 转换', () => {
  it('默认上下文：全量节点边、视觉 normal、注册类型 lineage', () => {
    const flow = toFlowGraph(graph);
    expect(flow.nodes).toHaveLength(9);
    expect(flow.edges).toHaveLength(8);
    expect(flow.nodes.every((n) => n.data.visual === 'normal')).toBe(true);
    expect(flow.edges.every((e) => e.data.visual === 'normal')).toBe(true);
    expect(flow.nodes.find((n) => n.id === 'ds:ds-a')?.type).toBe('lineage');
    // 节点声明固定几何：MiniMap 按 userNode 尺寸判定节点可见性（缺省则迷你地图为空）
    const dsNode = flow.nodes.find((n) => n.id === 'ds:ds-a');
    expect(dsNode?.width).toBe(LINEAGE_NODE_WIDTH);
    expect(dsNode?.initialHeight).toBe(LINEAGE_NODE_HEIGHT);
    expect(flow.nodes.find((n) => n.id === 'tbl:ds-a:orders')?.data.kind).toBe('table');
    expect(flow.edges.find((e) => e.id === 'e4')?.source).toBe('tbl:ds-a:orders');
    expect(flow.edges.find((e) => e.id === 'e4')?.target).toBe('report:1');
  });

  it('悬停节点：上下游闭包高亮、闭包外与无关边变暗', () => {
    const flow = toFlowGraph(graph, { hoveredId: 'report:1' });
    const v = (id: string) => flow.nodes.find((n) => n.id === id)?.data.visual;
    expect(v('report:1')).toBe('highlighted');
    expect(v('tbl:ds-a:orders')).toBe('highlighted');
    expect(v('tbl:ds-a:users')).toBe('highlighted');
    expect(v('ds:ds-a')).toBe('highlighted');
    expect(v('metric:1')).toBe('dimmed');
    expect(v('tbl:ds-b:logs')).toBe('dimmed');
    const ev = (id: string) => flow.edges.find((e) => e.id === id)?.data.visual;
    expect(ev('e4')).toBe('highlighted');
    expect(ev('e1')).toBe('highlighted');
    expect(ev('e7')).toBe('dimmed');
    expect(ev('e6')).toBe('dimmed');
  });

  it('选中与搜索匹配状态', () => {
    const flow = toFlowGraph(graph, {
      selectedId: 'tbl:ds-a:orders',
      matchedIds: new Set(['tbl:ds-a:orders']),
    });
    const orders = flow.nodes.find((n) => n.id === 'tbl:ds-a:orders');
    expect(orders?.data.selected).toBe(true);
    expect(orders?.data.matched).toBe(true);
    expect(orders?.data.visual).toBe('highlighted');
    expect(flow.nodes.find((n) => n.id === 'report:1')?.data.visual).toBe('dimmed');
    // 一端命中的边保持高亮，与匹配无关的边变暗
    expect(flow.edges.find((e) => e.id === 'e4')?.data.visual).toBe('highlighted');
    expect(flow.edges.find((e) => e.id === 'e6')?.data.visual).toBe('dimmed');
  });

  it('聚焦子集：仅保留可见节点与两端可见的边', () => {
    const flow = toFlowGraph(graph, {
      selectedId: 'tbl:ds-a:orders',
      visibleIds: new Set(['ds:ds-a', 'tbl:ds-a:orders', 'report:1']),
    });
    expect(sorted(flow.nodes.map((n) => n.id))).toEqual(sorted(['ds:ds-a', 'tbl:ds-a:orders', 'report:1']));
    expect(flow.edges.map((e) => e.id)).toEqual(['e1', 'e4']);
    expect(flow.nodes.find((n) => n.id === 'tbl:ds-a:orders')?.data.selected).toBe(true);
  });

  it('边样式按证据与状态区分：parsed 实线 / declared 琥珀虚线 / stale 红色告警', () => {
    const flow = toFlowGraph(graph);
    const parsed = flow.edges.find((e) => e.id === 'e4');
    expect(parsed?.style?.stroke).toBe('#10b981');
    expect(parsed?.style?.strokeDasharray).toBeUndefined();
    const declared = flow.edges.find((e) => e.id === 'e8');
    expect(declared?.style?.stroke).toBe('#f59e0b');
    expect(declared?.style?.strokeDasharray).toBe('6 4');
    const stale = flow.edges.find((e) => e.id === 'e6');
    expect(stale?.style?.stroke).toBe('#f43f5e');
    expect(stale?.label).toBe('⚠');
  });

  it('高亮边加粗、变暗边降透明度', () => {
    const flow = toFlowGraph(graph, { hoveredId: 'ds:ds-a' });
    const highlighted = flow.edges.find((e) => e.id === 'e4');
    expect(highlighted?.data.visual).toBe('highlighted');
    expect(highlighted?.style?.strokeWidth).toBe(2.5);
    const dimmed = flow.edges.find((e) => e.id === 'e3');
    expect(dimmed?.data.visual).toBe('dimmed');
    expect(dimmed?.style?.opacity).toBe(0.15);
  });
});
