/**
 * L3 上下文层：加载进入 LLM 上下文的数据源 Schema。
 * 防御链：落库 schema → scope 白名单过滤 → 敏感列过滤 → 摘要生成，结果缓存 5 分钟
 * （对应架构图 Caffeine 缓存；数据源写操作后由路由侧调用 invalidateSchemaCache 失效）。
 * 同时返回数据源 status，作为数据源级"AI 问数开关"（disconnected 拒绝问数）。
 */
import { getPool } from './db';
import { applyDataScope } from './scope';
import { summarizeSchema } from './schemaGuidance';
import { filterSensitiveColumns } from './queryGuard';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  schema: any[];
  guidance: string;
  status: string;
  /** 数据源类型（mysql 才走真实 SQL 执行；null = 前端提交 schema 的演示模式） */
  dsType: string | null;
  sensitiveRemoved: string[];
  /** 数据源级数据自省开关（Vanna intermediate_sql 借鉴） */
  allowIntrospection: boolean;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** 数据源配置/结构变更后调用，使缓存失效 */
export function invalidateSchemaCache(dataSourceId?: string): void {
  if (dataSourceId) cache.delete(dataSourceId);
  else cache.clear();
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
  };
}

export async function loadSchemaContext(dataSourceId: unknown, clientSchema: unknown): Promise<SchemaContext> {
  if (typeof dataSourceId !== 'string' || !dataSourceId) {
    return fromClientSchema(clientSchema);
  }

  const cached = cache.get(dataSourceId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return {
      schema: cached.schema,
      guidance: cached.guidance,
      status: cached.status,
      dsType: cached.dsType,
      sensitiveRemoved: cached.sensitiveRemoved,
      allowIntrospection: cached.allowIntrospection,
    };
  }

  try {
    const [rows] = await getPool().query(
      'SELECT schema_json, scope_json, status, type, allow_introspection FROM data_sources WHERE id = ?',
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
      at: Date.now(),
    };
    cache.set(dataSourceId, entry);
    return {
      schema: entry.schema,
      guidance: entry.guidance,
      status: entry.status,
      dsType: entry.dsType,
      sensitiveRemoved: entry.sensitiveRemoved,
      allowIntrospection: entry.allowIntrospection,
    };
  } catch (err) {
    console.warn('[Schema] load datasource schema failed, fallback to client schema:', err);
    return fromClientSchema(clientSchema);
  }
}
