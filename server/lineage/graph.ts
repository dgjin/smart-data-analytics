/**
 * 血缘图构建（纯函数，便于单测）：输入各数据源/报表/图表/指标的行数据，
 * 输出统一「节点 + 边 + 统计」的血缘图（GET /api/lineage/graph 的数据源）。
 *
 * 采集策略（对齐最新血缘管理理念：自动采集 + 证据分级 + 定期验证）：
 * 1. 报表 executedSqls / 图表 sourceSql → SQL 解析得到真实表级血缘（parsed 边，高可信）；
 * 2. 语义指标 table_name → 指标归属边（parsed，登记时已校验）；
 * 3. 无 SQL 证据时按 dataSourceId 绑定补「声明式」边（declared 边，待验证）；
 * 4. 边引用的表不在当前 Schema 中 → status='stale'（血缘失效提醒）；
 * 5. 数据源归属缺失（如出厂内置图表无 dataSourceId）按 SQL 表匹配 / 数据资源库特征推演，
 *    不硬编码数据源 ID（延续 DataLineageView 动态推演规范）。
 */
import { tablesOfSql, dialectOfDsType } from './sqlRefs';

// ============ 输入（来自 DB 行数据的纯数据） ============

export interface LineageDsInput {
  id: string;
  name: string;
  type: string;
  lastSyncedAt?: string;
  tables: Array<{ name: string; tableType?: string }>;
}

export interface LineageReportInput {
  id: string;
  title: string;
  dataSourceId: string;
  createdAt?: string;
  templateType?: string;
  /** 生成时各图表的原聚合 SQL（executedSqls） */
  sqls: string[];
}

export interface LineageWidgetInput {
  id: string;
  title: string;
  dataSourceId?: string;
  createdAt?: string;
  chartType?: string;
  /** 固化时的原聚合 SQL（sourceSql；出厂内置图表缺失） */
  sql?: string;
}

export interface LineageMetricInput {
  id: string;
  name: string;
  dataSourceId: string;
  tableName: string;
  expr?: string;
  status?: string;
}

export interface LineageGraphInput {
  dataSources: LineageDsInput[];
  reports: LineageReportInput[];
  widgets: LineageWidgetInput[];
  metrics: LineageMetricInput[];
}

// ============ 输出 ============

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

export interface LineageGraphNode {
  id: string;
  type: LineageNodeType;
  label: string;
  dataSourceId?: string;
  meta?: LineageNodeMeta;
}

export interface LineageGraphEdge {
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

export interface LineageGraphStats {
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
  stats: LineageGraphStats;
  nodes: LineageGraphNode[];
  edges: LineageGraphEdge[];
}

// ============ 节点 ID 约定（前后端共用同一格式，前端按前缀解析类型） ============
export const lineageDsNodeId = (dsId: string): string => `ds:${dsId}`;
export const lineageTableNodeId = (dsId: string, tableLower: string): string =>
  `tbl:${dsId}:${tableLower}`;
export const lineageMetricNodeId = (metricId: string): string => `metric:${metricId}`;
export const lineageReportNodeId = (reportId: string): string => `report:${reportId}`;
export const lineageWidgetNodeId = (widgetId: string): string => `widget:${widgetId}`;

/** 按 SQL 引用表在全部数据源中推演归属（匹配表数最多且 > 0；并列取首个，保证确定性） */
function inferDsFromSql(sqls: string[], dataSources: LineageDsInput[]): LineageDsInput | undefined {
  const refs = new Set<string>();
  for (const sql of sqls) {
    if (!sql) continue;
    // 归属推演时方言未知：两种方言口径取并集（仅用于打分，不产生边）
    for (const t of tablesOfSql(sql, 'mysql')) refs.add(t);
    for (const t of tablesOfSql(sql, 'pg')) refs.add(t);
  }
  if (refs.size === 0) return undefined;
  let best: { ds: LineageDsInput; score: number } | undefined;
  for (const ds of dataSources) {
    const names = new Set(ds.tables.map((t) => t.name.toLowerCase()));
    let score = 0;
    for (const r of refs) if (names.has(r)) score += 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { ds, score };
  }
  return best ? best.ds : undefined;
}

/** 数据资源库推演（与前端 resolveNpaDataSource 同口径：fct_jc_ 宽表特征 → 源名「数据资源」） */
function inferNpaDataSource(dataSources: LineageDsInput[]): LineageDsInput | undefined {
  return (
    dataSources.find((ds) => ds.tables.some((t) => t.name.toLowerCase().startsWith('fct_jc_'))) ||
    dataSources.find((ds) => ds.name === '数据资源')
  );
}

/**
 * 构建血缘图（确定性纯函数）。
 * @param generatedAt 生成时间（可注入便于测试）
 */
export function buildLineageGraph(
  input: LineageGraphInput,
  generatedAt = new Date().toISOString(),
): LineageGraph {
  const nodes = new Map<string, LineageGraphNode>();
  const edges: LineageGraphEdge[] = [];
  const edgeIds = new Set<string>();
  const dsById = new Map(input.dataSources.map((d) => [d.id, d]));
  /** 每个数据源被引用的表集合（小写表名），用于数据源节点计数回填 */
  const referencedByDs = new Map<string, Set<string>>();

  const addEdge = (
    from: string,
    to: string,
    kind: LineageEdgeKind,
    sourceType: LineageEdgeSource,
    evidence: string | undefined,
    lastVerifiedAt: string | undefined,
    status: LineageEdgeStatus,
  ): void => {
    const id = `e:${from}->${to}:${kind}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({
      id,
      from,
      to,
      kind,
      sourceType,
      ...(evidence ? { evidence } : {}),
      ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
      status,
    });
  };

  const ensureDsNode = (ds: LineageDsInput): void => {
    const id = lineageDsNodeId(ds.id);
    if (nodes.has(id)) return;
    nodes.set(id, {
      id,
      type: 'datasource',
      label: ds.name,
      dataSourceId: ds.id,
      meta: {
        dsType: ds.type,
        tablesTotal: ds.tables.length,
        ...(ds.lastSyncedAt ? { lastSyncedAt: ds.lastSyncedAt } : {}),
      },
    });
  };

  /**
   * 在指定数据源的 Schema 中解析一张表（大小写不敏感）：
   * 命中 → active 表节点 + 数据源 contains 结构边；未命中 → unresolved 表节点（stale 提示）。
   */
  const resolveTable = (
    dsId: string,
    rawName: string,
  ): { nodeId: string; status: LineageEdgeStatus } => {
    const ds = dsById.get(dsId);
    const lower = rawName.toLowerCase();
    const id = lineageTableNodeId(dsId, lower);
    if (!nodes.has(id)) {
      const schemaTable = ds?.tables.find((t) => t.name.toLowerCase() === lower);
      nodes.set(id, {
        id,
        type: 'table',
        label: schemaTable?.name || rawName,
        dataSourceId: dsId,
        meta: {
          ...(schemaTable?.tableType ? { tableType: schemaTable.tableType } : {}),
          ...(schemaTable ? {} : { unresolved: true }),
        },
      });
      if (ds && schemaTable) {
        // 数据源 → 表 结构边（仅被引用且在 Schema 中的表；unresolved 表不建 contains）
        addEdge(lineageDsNodeId(ds.id), id, 'contains', 'parsed', '数据源 Schema 同步', ds.lastSyncedAt, 'active');
      }
    }
    if (ds) {
      if (!referencedByDs.has(dsId)) referencedByDs.set(dsId, new Set());
      referencedByDs.get(dsId)!.add(lower);
    }
    const schemaTable = ds?.tables.find((t) => t.name.toLowerCase() === lower);
    return { nodeId: id, status: schemaTable ? 'active' : 'stale' };
  };

  /** 消费物的数据源归属：记录 ID → SQL 表匹配推演 → 数据资源库推演（返回推演证据说明） */
  const resolveConsumerDs = (
    recordedDsId: string | undefined,
    sqls: string[],
  ): { ds?: LineageDsInput; inferredEvidence?: string } => {
    if (recordedDsId) {
      const ds = dsById.get(recordedDsId);
      if (ds) return { ds };
    }
    const bySql = inferDsFromSql(sqls, input.dataSources);
    if (bySql) return { ds: bySql, inferredEvidence: '按 SQL 引用表匹配数据源 Schema 推演' };
    const npa = inferNpaDataSource(input.dataSources);
    if (npa) return { ds: npa, inferredEvidence: '数据资源库推演（fct_jc_ 宽表特征）' };
    return {};
  };

  // ---- 数据源节点：全部展示（未被消费的源也是信息：其表可被引用数为 0） ----
  for (const ds of input.dataSources) ensureDsNode(ds);

  // ---- 报表（决策简报） ----
  for (const rep of input.reports) {
    const nodeId = lineageReportNodeId(rep.id);
    nodes.set(nodeId, {
      id: nodeId,
      type: 'report',
      label: rep.title,
      ...(rep.dataSourceId ? { dataSourceId: rep.dataSourceId } : {}),
      meta: {
        ...(rep.templateType ? { templateType: rep.templateType } : {}),
        ...(rep.createdAt ? { createdAt: rep.createdAt } : {}),
        sqlCount: rep.sqls.length,
      },
    });

    const { ds, inferredEvidence } = resolveConsumerDs(rep.dataSourceId, rep.sqls);
    if (!ds) continue;
    if (inferredEvidence) nodes.get(nodeId)!.dataSourceId = ds.id;

    const dialect = dialectOfDsType(ds.type);
    const parsedTables = new Set<string>();
    rep.sqls.forEach((sql, idx) => {
      for (const t of tablesOfSql(sql, dialect)) {
        if (parsedTables.has(t)) continue;
        parsedTables.add(t);
        const { nodeId: tableId, status } = resolveTable(ds.id, t);
        addEdge(tableId, nodeId, 'consumes', 'parsed', `报表 SQL #${idx + 1}`, rep.createdAt, status);
      }
    });
    if (parsedTables.size === 0) {
      addEdge(
        lineageDsNodeId(ds.id),
        nodeId,
        'consumes',
        'declared',
        inferredEvidence || '数据源绑定（无表级 SQL 证据）',
        rep.createdAt,
        'active',
      );
    }
  }

  // ---- 固化监控图表 ----
  for (const w of input.widgets) {
    const nodeId = lineageWidgetNodeId(w.id);
    nodes.set(nodeId, {
      id: nodeId,
      type: 'widget',
      label: w.title,
      ...(w.dataSourceId ? { dataSourceId: w.dataSourceId } : {}),
      meta: {
        ...(w.chartType ? { chartType: w.chartType } : {}),
        ...(w.createdAt ? { createdAt: w.createdAt } : {}),
        sqlCount: w.sql ? 1 : 0,
      },
    });

    const sqls = w.sql ? [w.sql] : [];
    const { ds, inferredEvidence } = resolveConsumerDs(w.dataSourceId, sqls);
    if (!ds) continue;
    if (inferredEvidence) nodes.get(nodeId)!.dataSourceId = ds.id;

    const dialect = dialectOfDsType(ds.type);
    const parsedTables = new Set<string>();
    for (const t of tablesOfSql(sqls[0] || '', dialect)) {
      if (parsedTables.has(t)) continue;
      parsedTables.add(t);
      const { nodeId: tableId, status } = resolveTable(ds.id, t);
      addEdge(tableId, nodeId, 'consumes', 'parsed', '图表固化 SQL', w.createdAt, status);
    }
    if (parsedTables.size === 0) {
      addEdge(
        lineageDsNodeId(ds.id),
        nodeId,
        'consumes',
        'declared',
        inferredEvidence || '数据源绑定（无表级 SQL 证据）',
        w.createdAt,
        'active',
      );
    }
  }

  // ---- 语义指标（业务血缘：表 → 指标） ----
  for (const m of input.metrics) {
    const nodeId = lineageMetricNodeId(m.id);
    nodes.set(nodeId, {
      id: nodeId,
      type: 'metric',
      label: m.name,
      ...(m.dataSourceId ? { dataSourceId: m.dataSourceId } : {}),
      meta: {
        ...(m.expr ? { expr: m.expr } : {}),
        ...(m.status ? { metricStatus: m.status } : {}),
        ...(m.tableName ? { tableName: m.tableName } : {}),
      },
    });

    const { ds, inferredEvidence } = resolveConsumerDs(m.dataSourceId, []);
    if (!ds) continue;
    if (inferredEvidence) nodes.get(nodeId)!.dataSourceId = ds.id;

    if (m.tableName) {
      const { nodeId: tableId, status } = resolveTable(ds.id, m.tableName);
      addEdge(tableId, nodeId, 'derives', 'parsed', '指标归属表登记', undefined, status);
    } else {
      addEdge(
        lineageDsNodeId(ds.id),
        nodeId,
        'derives',
        'declared',
        inferredEvidence || '数据源绑定（无归属表登记）',
        undefined,
        'active',
      );
    }
  }

  // ---- 数据源节点计数回填（被引用表数） ----
  for (const ds of input.dataSources) {
    const node = nodes.get(lineageDsNodeId(ds.id));
    if (node && node.meta) {
      node.meta.tablesReferenced = referencedByDs.get(ds.id)?.size ?? 0;
    }
  }

  // ---- 统计（消费边口径；contains 为结构边不计入覆盖率） ----
  const consumeEdges = edges.filter((e) => e.kind !== 'contains');
  const parsedEdges = consumeEdges.filter((e) => e.sourceType === 'parsed').length;
  const declaredEdges = consumeEdges.filter((e) => e.sourceType === 'declared').length;
  const staleEdges = edges.filter((e) => e.status === 'stale').length;
  const denominator = parsedEdges + declaredEdges;
  const stats: LineageGraphStats = {
    nodes: nodes.size,
    edges: edges.length,
    parsedEdges,
    declaredEdges,
    staleEdges,
    parseCoverage: denominator === 0 ? 1 : parsedEdges / denominator,
  };

  return { generatedAt, stats, nodes: [...nodes.values()], edges };
}
