/**
 * v0.9.77 P2-15：固定报表服务端执行器——按保存配置在服务端重建并安全执行 SQL。
 * 供 Excel 导出（routes/flexQueries.ts）与订阅调度（flexSubscriptions.ts）共用，链路：
 * loadSchemaContext（scope/敏感列过滤后的落库 schema）→ 适配前端 TableSchema
 * → buildFlexQuerySql 重建 SQL（金额单位不传 = 原值口径，重放不引入个人单位偏好）
 * → executeSafeSql（SELECT-only / 表白名单 / 敏感列 / 行级过滤 / EXPLAIN 防线全链路）。
 * 文件型数据源（fileBacked）与前端一致按 MySQL 方言生成（executeSafeSql 内部改道应用库执行）。
 */
import type mysql from 'mysql2/promise';
import { getPool } from './infra/db';
import { logger } from './infra/logger';
import { loadSchemaContext, isLiveCapableType } from './query/schemaContext';
import { executeSafeSql, dialectOfDsType, MAX_ROWS, type QueryScenario } from './query/sqlExecutor';
import { buildFlexQuerySql, type FlexQueryConfig } from '../src/utils/flexQueryBuilder';
import type { SchemaTable } from './query/schemaTypes';
import type { ColumnSchema, TableSchema } from '../src/types/analytics';

/** 列类型白名单（前端 ColumnSchema.type 值域；落库 DB 类型（VARCHAR/INTEGER…）宽松归一到 string） */
const FLEX_COLUMN_TYPES = new Set(['string', 'number', 'boolean', 'date', 'category']);

/** 落库 SchemaTable → 前端 TableSchema（flexQueryBuilder 的输入形；列类型仅金额列判定/展示用） */
export function toFlexTableSchema(t: SchemaTable): TableSchema {
  return {
    id: String(t.id || t.name),
    name: String(t.name),
    displayName: String(t.displayName || t.name),
    description: String(t.description || ''),
    rowCount: typeof t.rowCount === 'number' ? t.rowCount : 0,
    columns: (Array.isArray(t.columns) ? t.columns : []).map((c) => {
      const type = String(c.type || '');
      return {
        name: String(c.name),
        type: (FLEX_COLUMN_TYPES.has(type) ? type : 'string') as ColumnSchema['type'],
        description: typeof c.description === 'string' ? c.description : undefined,
        isMetric: c.isMetric === true,
        isDimension: c.isDimension === true,
        isPrimaryKey: c.isPrimaryKey === true,
      };
    }),
  };
}

export interface FlexRunData {
  /** 结果列名（按首行键序；空结果集为空数组） */
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export type FlexRunOutcome = { ok: true; data: FlexRunData } | { ok: false; error: string; notFound?: boolean };

/**
 * 按配置在服务端重建并执行 SQL。
 * maxRows 为结果硬上限（SQL 内嵌 LIMIT 由 config.limit 决定，此处为二次截断兜底）。
 */
export async function runFlexQueryConfig(
  dataSourceId: string,
  config: FlexQueryConfig,
  opts?: { maxRows?: number; scenario?: QueryScenario },
): Promise<FlexRunOutcome> {
  if (!dataSourceId) return { ok: false, error: '固定报表未绑定数据源' };
  if (!config || typeof config !== 'object') return { ok: false, error: '查询配置缺失' };
  try {
    const ctx = await loadSchemaContext(dataSourceId, undefined);
    if (ctx.status === 'disconnected') return { ok: false, error: '该数据源已被管理员停用' };
    if (!isLiveCapableType(ctx.dsType, ctx.fileBacked)) {
      return { ok: false, error: '该数据源类型不支持服务端执行' };
    }
    const dialect = dialectOfDsType(ctx.dsType || '') || 'mysql';
    const tables = ctx.schema.map(toFlexTableSchema);
    const main = tables.find((t) => t.name === config?.table);
    if (!main) return { ok: false, error: `数据表「${String(config?.table || '')}」不在数据源 Schema 中` };
    const built = buildFlexQuerySql(config, main, dialect, tables);
    if (built.ok !== true) return { ok: false, error: built.error };
    const outcome = await executeSafeSql(
      dataSourceId,
      built.sql,
      tables,
      ctx.sensitiveRemoved,
      opts?.maxRows ?? MAX_ROWS,
      ctx.rowFilters,
      opts?.scenario ?? 'export',
    );
    if (outcome.ok !== true) return { ok: false, error: outcome.reason };
    const rows = outcome.result.rows;
    return {
      ok: true,
      data: {
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        rows,
        rowCount: outcome.result.rowCount,
        truncated: outcome.result.truncated,
      },
    };
  } catch (err) {
    logger.warn('[FlexRunner] 固定报表服务端执行失败:', err);
    return { ok: false, error: '固定报表执行失败' };
  }
}

interface FlexQueryDbRow extends mysql.RowDataPacket {
  query_id: string;
  data_source_id: string;
  query_data: string;
}

export interface FlexRunMeta extends FlexRunData {
  /** 固定报表名称 */
  name: string;
  /** 重建 SQL 所用数据源 */
  dataSourceId: string;
}

/** query_data JSON 解析形（宽松：仅使用 name/dataSourceId/config 三字段） */
interface SavedFlexQueryLite {
  name?: string;
  dataSourceId?: string;
  config?: FlexQueryConfig;
}

/** 按 queryId 读取固定报表并在服务端重放执行（Excel 导出/订阅执行共用入口） */
export async function runSavedFlexQuery(
  queryId: string,
  opts?: { maxRows?: number; scenario?: QueryScenario },
): Promise<{ ok: true; data: FlexRunMeta } | { ok: false; error: string; notFound?: boolean }> {
  let saved: SavedFlexQueryLite | null;
  let dsId: string;
  try {
    const [rows] = await getPool().query<FlexQueryDbRow[]>(
      'SELECT query_id, data_source_id, query_data FROM flex_queries WHERE query_id = ? LIMIT 1',
      [queryId],
    );
    const row = rows[0];
    if (!row) return { ok: false, error: '固定报表不存在', notFound: true };
    dsId = String(row.data_source_id || '');
    saved = JSON.parse(String(row.query_data || '{}')) as SavedFlexQueryLite;
  } catch (err) {
    logger.warn('[FlexRunner] 固定报表读取失败:', err);
    return { ok: false, error: '固定报表读取失败' };
  }
  if (!saved?.config || typeof saved.config !== 'object') {
    return { ok: false, error: '固定报表缺少查询配置' };
  }
  if (!dsId) dsId = String(saved.dataSourceId || '');
  const run = await runFlexQueryConfig(dsId, saved.config, opts);
  if (run.ok !== true) return run;
  return {
    ok: true,
    data: { ...run.data, name: String(saved.name || queryId), dataSourceId: dsId },
  };
}
