/**
 * 血缘画布（React Flow 封装）：分层布局图谱渲染 + 缩放/适配/小地图控件。
 * 视觉与坐标计算委托 utils/lineageGraph.toFlowGraph（纯函数）；本组件只处理壳与交互事件：
 *   - 悬停节点 → onHover（由容器计算上下游闭包高亮）
 *   - 点击节点 → onSelect（聚焦 + 影响分析面板）；点击空白 → 取消选中
 *   - 选中 / 过滤变化时 fitView 到目标邻域或全景
 * colorMode 跟随全局主题（UI_THEME_EVENT）；Controls/MiniMap 浅色浮层在 index.css 局部覆盖。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
} from '@xyflow/react';
import { LineageNodeCard } from './LineageNodeCard';
import type { LineageFlowNode } from './LineageNodeCard';
import { toFlowGraph } from '../../../utils/lineageGraph';
import type { LineageGraph, LineageNodeType } from '../../../utils/lineageGraph';
import { getUITheme, UI_THEME_EVENT } from '../../../utils/uiTheme';

export interface LineageCanvasProps {
  graph: LineageGraph;
  selectedId: string | null;
  hoveredId: string | null;
  matchedIds: Set<string> | null;
  /** 聚焦子集（null = 展示全量） */
  visibleIds: Set<string> | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

/** 节点类型注册表（模块级常量：避免每次渲染重建导致全量节点重挂载） */
const NODE_TYPES = { lineage: LineageNodeCard };

/** 小地图节点配色（与 LineageNodeCard 类型着色一致） */
const MINIMAP_COLORS: Record<LineageNodeType, string> = {
  datasource: '#6366f1',
  table: '#22d3ee',
  metric: '#d946ef',
  report: '#10b981',
  widget: '#f59e0b',
};

/** 画布壳内的受控渲染（需要 useReactFlow 上下文，故与 Provider 分离） */
const LineageCanvasInner: React.FC<LineageCanvasProps> = ({
  graph,
  selectedId,
  hoveredId,
  matchedIds,
  visibleIds,
  onSelect,
  onHover,
}) => {
  const { fitView } = useReactFlow();
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(() => getUITheme());

  // 主题同步：Header 切换浅/深色时画布 colorMode 跟随
  useEffect(() => {
    const sync = () => setColorMode(getUITheme());
    window.addEventListener(UI_THEME_EVENT, sync);
    return () => window.removeEventListener(UI_THEME_EVENT, sync);
  }, []);

  const flow = useMemo(
    () => toFlowGraph(graph, { selectedId, hoveredId, matchedIds, visibleIds }),
    [graph, selectedId, hoveredId, matchedIds, visibleIds],
  );

  // 选中变化 → fitView 到目标邻域；取消选中/过滤切换 → 恢复全景
  useEffect(() => {
    const timer = setTimeout(() => {
      if (selectedId) {
        fitView({ nodes: [{ id: selectedId }], duration: 400, padding: 0.4, maxZoom: 1.3 });
      } else {
        fitView({ duration: 400, padding: 0.1 });
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [selectedId, visibleIds, fitView]);

  const miniMapColor = useCallback((node: LineageFlowNode) => MINIMAP_COLORS[node.data.kind] || '#64748b', []);

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={NODE_TYPES}
      colorMode={colorMode}
      fitView
      minZoom={0.2}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      onNodeMouseEnter={(_, node) => onHover(node.id)}
      onNodeMouseLeave={() => onHover(null)}
      onPaneClick={() => onSelect(null)}
      defaultEdgeOptions={{
        type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      }}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={miniMapColor}
        maskColor={colorMode === 'light' ? 'rgba(241, 245, 249, 0.72)' : 'rgba(2, 6, 23, 0.72)'}
      />
    </ReactFlow>
  );
};

export const LineageCanvas: React.FC<LineageCanvasProps> = (props) => (
  <ReactFlowProvider>
    <LineageCanvasInner {...props} />
  </ReactFlowProvider>
);
