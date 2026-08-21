/**
 * v0.4.8 数据版本指纹：看板/决策报表「数据变化自动检测、自主更新」的探测层。
 * 以 information_schema（MySQL）/ pg_stat_user_tables（PG/Greenplum）的行数与更新时间
 * 计算轻量指纹，不做全表扫描；结果内存缓存 10s，防多端轮询风暴。
 */
import { createHash } from 'node:crypto';
import { loadDataSourceConfig, getDsPool, dialectOfDsType } from './sqlExecutor';

export interface TableStat {
  name: string;
  rows: number;
  ts: string;
}

/** 归一化 MySQL information_schema.TABLES 结果（纯函数，便于单测） */
export function parseMysqlTableStats(rows: any[]): TableStat[] {
  return (rows || [])
    .filter((r) => r && r.TABLE_NAME)
    .map((r) => ({
      name: String(r.TABLE_NAME),
      rows: Number(r.TABLE_ROWS) || 0,
      ts: String(r.TS || r.UPDATE_TIME || r.CREATE_TIME || ''),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 归一化 PG pg_stat_user_tables 结果（行数 + vacuum/analyze 时间戳，无更新时间列） */
export function parsePgTableStats(rows: any[]): TableStat[] {
  return (rows || [])
    .filter((r) => r && r.relname)
    .map((r) => ({ name: String(r.relname), rows: Number(r.n_live_tup) || 0, ts: String(r.mx_ts || '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 表统计 → 稳定指纹；空库返回 null（前端跳过自动更新） */
export function buildDataVersion(tables: TableStat[]): string | null {
  if (!tables.length) return null;
  const payload = tables.map((t) => `${t.name}:${t.rows}:${t.ts}`).join('|');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

const versionCache = new Map<string, { version: string | null; at: number }>();
const CACHE_TTL_MS = 10_000;

export interface DataVersionOutcome {
  version: string | null;
  reason?: string;
}

/**
 * 计算指定数据源的数据版本指纹。
 * - 数据源不存在 → NOT_FOUND；非数据库型（csv/demo）→ UNSUPPORTED_DS_TYPE（version=null，前端跳过）
 * - 探测异常（连接失败等）→ version=null + reason，前端静默跳过本轮
 */
export async function computeDataVersion(dataSourceId: string): Promise<DataVersionOutcome> {
  const hit = versionCache.get(dataSourceId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { version: hit.version };

  const ds = await loadDataSourceConfig(dataSourceId);
  if (!ds) return { version: null, reason: 'NOT_FOUND' };
  const dialect = dialectOfDsType(ds.type);
  if (!dialect) return { version: null, reason: 'UNSUPPORTED_DS_TYPE' };

  try {
    const entry = getDsPool(dataSourceId, dialect, ds.config);
    let tables: TableStat[];
    if (entry.dialect === 'pg') {
      const result = await entry.pool.query(
        "SELECT relname, n_live_tup, GREATEST(COALESCE(last_vacuum,'epoch'::timestamptz), COALESCE(last_autovacuum,'epoch'::timestamptz), COALESCE(last_analyze,'epoch'::timestamptz), COALESCE(last_autoanalyze,'epoch'::timestamptz)) AS mx_ts FROM pg_stat_user_tables"
      );
      tables = parsePgTableStats(Array.isArray(result.rows) ? result.rows : []);
    } else {
      // MySQL 8.0+ 的 information_schema 统计默认缓存 24h（information_schema_stats_expiry=86400），
      // INSERT/UPDATE 后 TABLE_ROWS/UPDATE_TIME 不变 → 指纹漏检新增数据。
      // 用专用连接 SET SESSION expiry=0 读实时统计；旧版本无此变量时忽略继续（降级为原行为）。
      const conn = await entry.pool.getConnection();
      try {
        try {
          await conn.query('SET SESSION information_schema_stats_expiry = 0');
        } catch {
          /* MySQL 5.7 / MariaDB 无此变量，保持缓存统计降级行为 */
        }
        const [rows] = await conn.query(
          "SELECT TABLE_NAME, TABLE_ROWS, IFNULL(UPDATE_TIME, CREATE_TIME) AS TS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
        );
        tables = parseMysqlTableStats(Array.isArray(rows) ? (rows as any[]) : []);
      } finally {
        conn.release();
      }
    }
    const version = buildDataVersion(tables);
    versionCache.set(dataSourceId, { version, at: Date.now() });
    return { version };
  } catch (err: any) {
    return { version: null, reason: String(err?.message || err).slice(0, 200) };
  }
}

/** 测试与热重置用：清空指纹缓存 */
export function clearDataVersionCache(): void {
  versionCache.clear();
}
