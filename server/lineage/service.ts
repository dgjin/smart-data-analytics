/**
 * 血缘图服务：从应用库聚合数据源/报表/图表/指标的行数据，构建血缘图并做进程内 TTL 缓存。
 * - 只读聚合，不新建血缘持久化表（设计决策：P0 采用内存聚合，避免 schema 迁移）；
 * - 30s TTL 缓存吸收高频打开血缘视图的开销；
 * - 构建失败向上抛错，由路由转 500，前端降级为本地声明式估算（fail-open，不影响其他页面）。
 */
import type { RowDataPacket } from 'mysql2';
import { getPool } from '../infra/db';
import {
  buildLineageGraph,
  type LineageGraph,
  type LineageDsInput,
  type LineageReportInput,
  type LineageWidgetInput,
  type LineageMetricInput,
} from './graph';

const CACHE_TTL_MS = 30_000;
let cache: { at: number; graph: LineageGraph } | null = null;

/** 安全 JSON 解析（行数据可能为 NULL / 脏数据） */
function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** DB 时间值 → ISO 字符串（缺失则 undefined） */
function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ============ 各来源行数据 → 纯数据输入 ============

interface DsRow extends RowDataPacket {
  id: string;
  name: string;
  type: string;
  schema_json: string | null;
  updated_at: string | Date | null;
}

function toDsInput(row: DsRow): LineageDsInput {
  const tables = safeJson<Array<{ name?: unknown; tableType?: unknown }>>(row.schema_json, []);
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type || ''),
    ...(toIso(row.updated_at) ? { lastSyncedAt: toIso(row.updated_at) } : {}),
    tables: tables
      .filter((t) => t && typeof t.name === 'string' && t.name)
      .map((t) => ({
        name: String(t.name),
        ...(typeof t.tableType === 'string' && t.tableType ? { tableType: t.tableType } : {}),
      })),
  };
}

interface ReportRow extends RowDataPacket {
  report_id: string;
  data_source_id: string | null;
  report_data: string | null;
  created_at: string | Date | null;
}

function toReportInput(row: ReportRow): LineageReportInput {
  const data = safeJson<{
    title?: unknown;
    createdAt?: unknown;
    templateType?: unknown;
    executedSqls?: unknown;
  }>(row.report_data, {});
  const sqls = Array.isArray(data.executedSqls)
    ? data.executedSqls.filter((s): s is string => typeof s === 'string' && !!s.trim())
    : [];
  return {
    id: String(row.report_id),
    title: typeof data.title === 'string' && data.title ? data.title : String(row.report_id),
    dataSourceId: String(row.data_source_id || ''),
    ...(typeof data.createdAt === 'string' && data.createdAt
      ? { createdAt: data.createdAt }
      : toIso(row.created_at)
        ? { createdAt: toIso(row.created_at) }
        : {}),
    ...(typeof data.templateType === 'string' && data.templateType
      ? { templateType: data.templateType }
      : {}),
    sqls,
  };
}

interface WidgetRow extends RowDataPacket {
  widget_id: string;
  widget_data: string | null;
  created_at: string | Date | null;
}

function toWidgetInput(row: WidgetRow): LineageWidgetInput {
  const data = safeJson<{
    title?: unknown;
    dataSourceId?: unknown;
    sourceSql?: unknown;
    chartConfig?: { type?: unknown };
  }>(row.widget_data, {});
  const sourceSql = typeof data.sourceSql === 'string' && data.sourceSql.trim() ? data.sourceSql : '';
  return {
    id: String(row.widget_id),
    title: typeof data.title === 'string' && data.title ? data.title : String(row.widget_id),
    ...(typeof data.dataSourceId === 'string' && data.dataSourceId
      ? { dataSourceId: data.dataSourceId }
      : {}),
    ...(toIso(row.created_at) ? { createdAt: toIso(row.created_at) } : {}),
    ...(typeof data.chartConfig?.type === 'string' && data.chartConfig.type
      ? { chartType: data.chartConfig.type }
      : {}),
    ...(sourceSql ? { sql: sourceSql } : {}),
  };
}

interface MetricRow extends RowDataPacket {
  id: number;
  name: string;
  data_source_id: string;
  table_name: string;
  expr: string | null;
  status: string | null;
}

function toMetricInput(row: MetricRow): LineageMetricInput {
  return {
    id: String(row.id),
    name: String(row.name || `指标 ${row.id}`),
    dataSourceId: String(row.data_source_id || ''),
    tableName: String(row.table_name || ''),
    ...(row.expr ? { expr: String(row.expr) } : {}),
    ...(row.status ? { status: String(row.status) } : {}),
  };
}

// ============ 查询与缓存 ============

async function loadInput(): Promise<{
  dataSources: DsRow[];
  reports: ReportRow[];
  widgets: WidgetRow[];
  metrics: MetricRow[];
}> {
  const pool = getPool();
  const [dataSources] = await pool.query<DsRow[]>(
    'SELECT id, name, type, schema_json, updated_at FROM data_sources'
  );
  const [reports] = await pool.query<ReportRow[]>(
    'SELECT report_id, data_source_id, report_data, created_at FROM saved_reports'
  );
  const [widgets] = await pool.query<WidgetRow[]>(
    'SELECT widget_id, widget_data, created_at FROM dashboard_widgets'
  );
  const [metrics] = await pool.query<MetricRow[]>(
    'SELECT id, name, data_source_id, table_name, expr, status FROM metric_definitions'
  );
  return { dataSources, reports, widgets, metrics };
}

/** 获取血缘图（30s 进程内缓存；构建失败向上抛错） */
export async function getLineageGraph(): Promise<LineageGraph> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.graph;
  const rows = await loadInput();
  const graph = buildLineageGraph({
    dataSources: rows.dataSources.map(toDsInput),
    reports: rows.reports.map(toReportInput),
    widgets: rows.widgets.map(toWidgetInput),
    metrics: rows.metrics.map(toMetricInput),
  });
  cache = { at: Date.now(), graph };
  return graph;
}

/** 主动失效缓存（测试与数据变更场景使用） */
export function invalidateLineageCache(): void {
  cache = null;
}
