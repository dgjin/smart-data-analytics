/**
 * L3 上下文层：加载进入 LLM 上下文的数据源 Schema。
 * 防御链：落库 schema → scope 白名单过滤 → 敏感列过滤 → 摘要生成，结果缓存 5 分钟。
 * P2-7 缓存接 StateStore：REDIS_URL 配置时多实例共享同一份缓存，
 * 数据源写操作后 invalidateSchemaCache 跨实例同步失效（内存模式行为与原实现一致）。
 * 同时返回数据源 status，作为数据源级"AI 问数开关"（disconnected 拒绝问数）。
 */
import { getPool } from './db';
import { getStateStore } from './stateStore';
import { applyDataScope, rowFiltersByTableName } from './scope';
import { summarizeSchema } from './schemaGuidance';
import { filterSensitiveColumns } from './queryGuard';

const SCHEMA_CACHE_PREFIX = 'sctx:';
const CACHE_TTL_SEC = 5 * 60;

interface CacheEntry {
  schema: any[];
  guidance: string;
  status: string;
  /** 数据源类型（mysql 才走真实 SQL 执行；null = 前端提交 schema 的演示模式） */
  dsType: string | null;
  sensitiveRemoved: string[];
  /** 数据源级数据自省开关（Vanna intermediate_sql 借鉴） */
  allowIntrospection: boolean;
  /** P1-3 行级权限：实际表名 → 行过滤谓词（执行层 AST 强制注入） */
  rowFilters: Record<string, string>;
  /** 数据源显示名（注入 prompt 防止 LLM 把库名当数据过滤值） */
  dataSourceName: string;
}

/** 数据源配置/结构变更后调用，使缓存失效（跨实例：Redis 模式下 deleteByPrefix 广播清理） */
export async function invalidateSchemaCache(dataSourceId?: string): Promise<void> {
  const store = getStateStore();
  if (dataSourceId) await store.deleteByPrefix(`${SCHEMA_CACHE_PREFIX}${dataSourceId}`);
  else await store.deleteByPrefix(SCHEMA_CACHE_PREFIX);
}

export interface SchemaContext {
  schema: any[];
  guidance: string;
  /** null 表示数据源未落库（使用前端提交的 schema，不缓存） */
  status: string | null;
  /** 数据源类型；null 表示未落库（演示模式） */
  dsType: string | null;
  sensitiveRemoved: string[];
  /** 数据自省开关；演示模式恒关 */
  allowIntrospection: boolean;
  /** P1-3 行级权限（实际表名 → 谓词）；演示模式恒空 */
  rowFilters: Record<string, string>;
  /** 数据源显示名；演示模式为空串 */
  dataSourceName: string;
}

function parseJson(v: any, fallback: any) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function fromClientSchema(clientSchema: unknown): SchemaContext {
  const filtered = filterSensitiveColumns(Array.isArray(clientSchema) ? clientSchema : []);
  return {
    schema: filtered.schema,
    guidance: summarizeSchema(filtered.schema),
    status: null,
    dsType: null,
    sensitiveRemoved: filtered.removed,
    allowIntrospection: false,
    rowFilters: {},
    dataSourceName: '',
  };
}

export async function loadSchemaContext(dataSourceId: unknown, clientSchema: unknown): Promise<SchemaContext> {
  if (typeof dataSourceId !== 'string' || !dataSourceId) {
    return fromClientSchema(clientSchema);
  }

  const cacheKey = `${SCHEMA_CACHE_PREFIX}${dataSourceId}`;
  const raw = await getStateStore().get(cacheKey);
  if (raw) {
    try {
      const cached = JSON.parse(raw) as CacheEntry;
      return {
        schema: cached.schema,
        guidance: cached.guidance,
        status: cached.status,
        dsType: cached.dsType,
        sensitiveRemoved: cached.sensitiveRemoved,
        allowIntrospection: cached.allowIntrospection,
        rowFilters: cached.rowFilters,
        dataSourceName: cached.dataSourceName || '',
      };
    } catch {
      // 缓存体损坏视为未命中，走查库重建
    }
  }

  try {
    const [rows] = await getPool().query(
      'SELECT name, schema_json, scope_json, status, type, allow_introspection FROM data_sources WHERE id = ?',
      [dataSourceId]
    );
    const ds = (rows as any[])[0];
    if (!ds) return fromClientSchema(clientSchema);

    const scoped = applyDataScope(parseJson(ds.schema_json, []), parseJson(ds.scope_json, null));
    const filtered = filterSensitiveColumns(scoped);
    const entry: CacheEntry = {
      schema: filtered.schema,
      guidance: summarizeSchema(filtered.schema),
      status: String(ds.status || 'connected'),
      dsType: String(ds.type || ''),
      sensitiveRemoved: filtered.removed,
      allowIntrospection: Number(ds.allow_introspection) === 1,
      rowFilters: rowFiltersByTableName(scoped, parseJson(ds.scope_json, null)),
      dataSourceName: String(ds.name || ''),
    };
    await getStateStore().setEx(cacheKey, JSON.stringify(entry), CACHE_TTL_SEC);
    return {
      schema: entry.schema,
      guidance: entry.guidance,
      status: entry.status,
      dsType: entry.dsType,
      sensitiveRemoved: entry.sensitiveRemoved,
      allowIntrospection: entry.allowIntrospection,
      rowFilters: entry.rowFilters,
      dataSourceName: entry.dataSourceName,
    };
  } catch (err) {
    console.warn('[Schema] load datasource schema failed, fallback to client schema:', err);
    return fromClientSchema(clientSchema);
  }
}
