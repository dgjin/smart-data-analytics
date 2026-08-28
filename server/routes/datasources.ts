/**
 * 数据源管理路由。
 * 读取对所有登录用户开放（查询页需要 schema）；写入与连接测试仅 ADMIN。
 * mysql/postgresql/greenplum 类型执行真实连接探测与 Schema 提取，其余类型返回模拟结果。
 */
import { Router } from 'express';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { sanitizeDataScope } from '../scope';
import { canAccessDataSource, checkDataSourceAccess, parseAcl, sanitizeAcl } from '../accessControl';
import { invalidateSchemaCache } from '../schemaContext';
import { invalidateExecutorPool } from '../sqlExecutor';
import { computeDataVersion } from '../dataVersion';
import { decryptSecret, encryptConfigPassword } from '../secretsCrypto';

const router = Router();
router.use(authMiddleware);

const VALID_TYPES = ['mysql', 'postgresql', 'greenplum', 'csv', 'json', 'api', 'demo'];

/** 支持真实 Schema 提取/同步的数据库类型 */
function isDbType(type: string): boolean {
  return type === 'mysql' || type === 'postgresql' || type === 'greenplum';
}

function rowToDataSource(row: any) {
  const config = safeJson(row.config_json, {});
  // 连接密码不下发给前端（列表对所有登录用户可见）
  const { password: _pw, ...safeConfig } = config;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    config: safeConfig,
    tables: safeJson(row.schema_json, []),
    scope: safeJson(row.scope_json, null),
    // P2-11 访问控制清单（仅 ADMIN 下发；非管理员由列表接口剥离）
    acl: parseAcl(row.acl_json),
    // 管理员登记的专业快速问题推荐（优先于前端通用 Schema 推导）
    quickQuestions: safeJson(row.quick_questions_json, null),
    allowIntrospection: Number(row.allow_introspection) === 1,
    lastSyncedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

// MySQL data_type → 前端 ColumnSchema.type
export function mapMysqlType(dataType: string): string {
  const t = String(dataType).toLowerCase();
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year'].includes(t)) return 'number';
  if (['date', 'datetime', 'timestamp', 'time'].includes(t)) return 'date';
  if (['enum', 'set'].includes(t)) return 'category';
  if (['bit', 'bool', 'boolean'].includes(t)) return 'boolean';
  return 'string';
}

// PostgreSQL / Greenplum data_type（information_schema 完整写法）→ 前端 ColumnSchema.type
export function mapPgType(dataType: string): string {
  const t = String(dataType).toLowerCase();
  if (['smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision', 'serial', 'bigserial', 'smallserial', 'money'].includes(t)) return 'number';
  if (t === 'date' || t.startsWith('timestamp') || t.startsWith('time')) return 'date';
  if (['boolean', 'bool'].includes(t)) return 'boolean';
  // 短文本（varchar/char ≤64 字符）是否维度由 deriveColumnRole 依据 maxLength 判定
  return 'string';
}

/**
 * 依据列的真实特征自动推导指标/维度角色（管理员可在"指标维度维护"中调整）：
 * - 主键与 id 形态的数字外键列 → 两者都不是（技术性字段，不参与分析）
 * - 数值列 → 指标；日期/枚举/布尔 → 维度
 * - 短字符串（≤64 字符）→ 维度；长文本/JSON/BLOB → 两者都不是
 */
export function deriveColumnRole(
  name: string,
  type: string,
  isPK: boolean,
  dataType: string,
  maxLength: number | null
): { isMetric: boolean; isDimension: boolean } {
  const lower = String(name).toLowerCase();
  const isIdLike = isPK || lower === 'id' || lower.endsWith('_id') || /Id$/.test(name);
  if (isIdLike) return { isMetric: false, isDimension: false };
  if (type === 'number') return { isMetric: true, isDimension: false };
  if (['date', 'category', 'boolean'].includes(type)) return { isMetric: false, isDimension: true };
  const rawType = String(dataType).toLowerCase();
  const isLongText =
    ['text', 'tinytext', 'mediumtext', 'longtext', 'json', 'jsonb', 'blob', 'bytea', 'xml'].includes(rawType) ||
    (maxLength != null && maxLength > 64);
  return { isMetric: false, isDimension: !isLongText };
}

// 表/列元数据组装（MySQL 与 PG 系共用）：列按表分组、推导角色、拼 TableSchema
function assembleTables(tableRows: any[], colRows: any[], mapType: (dataType: string) => string) {
  const colsByTable = new Map<string, any[]>();
  for (const c of colRows) {
    const type = mapType(c.dataType);
    const isPK = c.columnKey === 'PRI';
    const role = deriveColumnRole(c.name, type, isPK, c.dataType, c.maxLength != null ? Number(c.maxLength) : null);
    const col = {
      name: c.name,
      type,
      description: c.comment || '',
      isPrimaryKey: isPK || undefined,
      ...role,
    };
    if (!colsByTable.has(c.tableName)) colsByTable.set(c.tableName, []);
    colsByTable.get(c.tableName)!.push(col);
  }

  return tableRows.map((t) => ({
    id: `tbl_${t.name}`,
    name: t.name,
    displayName: t.comment ? String(t.comment).split(';')[0].split('\n')[0] || t.name : t.name,
    description: t.comment || `数据表 ${t.name}`,
    rowCount: Number(t.rowCount || 0),
    columns: colsByTable.get(t.name) || [],
    tableType: (t as any).tableType || undefined,
  }));
}

// 真实连接 MySQL 并提取全部表与列结构（information_schema）
async function extractMysqlSchema(config: any) {
  const conn = await mysql.createConnection({
    host: config?.host || '127.0.0.1',
    port: Number(config?.port) || 3306,
    user: config?.username || 'root',
    password: decryptSecret(config?.password || ''),
    database: config?.database || undefined,
    connectTimeout: 5000,
  });
  try {
    const db = config?.database || '';
    const [tableRows] = await conn.query(
      `SELECT table_name AS name, table_rows AS rowCount, table_comment AS comment
       FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'
       ORDER BY table_name LIMIT 500`,
      [db]
    );
    const [colRows] = await conn.query(
      `SELECT table_name AS tableName, column_name AS name, data_type AS dataType,
              column_key AS columnKey, column_comment AS comment,
              character_maximum_length AS maxLength
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [db]
    );
    return assembleTables(tableRows as any[], colRows as any[], mapMysqlType);
  } finally {
    await conn.end();
  }
}

// 真实连接 PostgreSQL / Greenplum 并提取全部表与列结构。
// 表清单走 pg_catalog（reltuples 行数估算、obj_description 表注释）；
// 列走 information_schema.columns + col_description 列注释 + PRIMARY KEY 子查询。
async function extractPgSchema(type: 'postgresql' | 'greenplum', config: any) {
  const client = new pg.Client({
    host: config?.host || '127.0.0.1',
    port: Number(config?.port) || 5432,
    user: config?.username || 'postgres',
    password: decryptSecret(config?.password || ''),
    database: config?.database || undefined,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    const schema = String(config?.schema || 'public').trim() || 'public';
    
    // PostgreSQL / Greenplum 兼容的表结构提取
    // relkind: r(普通表), p(分区表), v(视图), m(物化视图), f(外部表)
    const { rows: tableRows } = await client.query(
      `SELECT c.relname AS name, 
              COALESCE(c.reltuples, 0)::bigint AS "rowCount",
              obj_description(c.oid, 'pg_class') AS comment,
              CASE 
                WHEN c.relkind IN ('r', 'p', 'f') THEN 'TABLE'
                WHEN c.relkind IN ('v') THEN 'VIEW'
                WHEN c.relkind IN ('m') THEN 'MATERIALIZED_VIEW'
                ELSE 'UNKNOWN'
              END AS "tableType"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND NOT pg_is_other_temp_schema(n.oid)
       ORDER BY c.relname LIMIT 500`,
      [schema]
    );
    
    console.log(`[Schema Extract] Found ${tableRows.length} objects in schema "${schema}"`);
    
    // 列查询统一走 pg_catalog（pg_attribute + pg_description）：
    // 1) 避免 col_description + ::regclass 名称解析失败（大写/特殊字符表名）导致注释为 NULL
    // 2) 通过 attnum 精确匹配列注释，避免 ordinal_position 与 attnum 错位（删列后有空洞）
    // 3) 不依赖 format() 函数，PostgreSQL / Greenplum 一套 SQL 通用
    // 4) 对表、视图、物化视图、外部表的列注释均有效
    // 注意：主键检测仍走 information_schema（已验证 Greenplum 兼容），
    //      避免 pg_index.indkey 的 ANY() 解包在部分 Greenplum 版本上报错
    const colQuery = `
      SELECT c.relname AS "tableName",
             a.attname AS name,
             format_type(a.atttypid, NULL) AS "dataType",
             CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "columnKey",
             d.description AS comment,
             CASE WHEN a.atttypmod > 0 AND t.typname IN ('varchar', 'bpchar')
                  THEN a.atttypmod - 4 ELSE NULL END AS "maxLength"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum
      LEFT JOIN (
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
      ) pk ON pk.table_name = c.relname AND pk.column_name = a.attname
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`;
       
    const { rows: colRows } = await client.query(colQuery, [schema]);
    console.log(`[Schema Extract] Extracted ${colRows.length} columns, ${colRows.filter((r: any) => r.comment).length} with comments`);
    return assembleTables(tableRows, colRows, mapPgType);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** 按数据源类型分派真实 Schema 提取 */
async function extractDbSchema(type: string, config: any) {
  // Greenplum 和 PostgreSQL 需要类型区分以选择正确的 SQL 语法
  const dbType = type === 'mysql' ? 'mysql' : (type as 'postgresql' | 'greenplum');
  
  if (type === 'mysql') {
    return extractMysqlSchema(config);
  } else {
    // PostgreSQL / Greenplum
    return extractPgSchema(dbType, config);
  }
}

/** 判断是否为 PostgreSQL / Greenplum */
function isPostgresLike(type: string): boolean {
  return type === 'postgresql' || type === 'greenplum';
}

function safeJson(text: any, fallback: any) {
  if (text === null || text === undefined) return fallback;
  if (typeof text === 'object') return text; // mysql2 may auto-parse JSON columns
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// GET /api/datasources（所有登录用户）
// 表结构详情（tables）仅 ADMIN 可见；其他角色剥离 tables 并附 tableCount 供徽标展示。
// 问数链路不依赖该字段（服务端 loadSchemaContext 直接读落库 schema），功能不受影响。
// P2-11 访问控制：非 ADMIN 对无权限的数据源仅下发最小信息 + accessDenied 标记（供「申请权限」入口展示）。
router.get('/', async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user?.role === 'ADMIN';
    const [rows] = await getPool().query('SELECT * FROM data_sources ORDER BY created_at ASC');
    return res.json({
      dataSources: (rows as any[]).map((row) => {
        const ds = rowToDataSource(row);
        if (isAdmin) return ds;
        if (!canAccessDataSource(user, ds.acl)) {
          return {
            id: ds.id,
            name: ds.name,
            type: ds.type,
            status: ds.status,
            accessDenied: true,
            config: {},
            tables: [],
            tableCount: 0,
            scope: null,
            quickQuestions: null,
            allowIntrospection: false,
            lastSyncedAt: ds.lastSyncedAt,
          };
        }
        const { tables, acl: _acl, ...rest } = ds;
        return { ...rest, tables: [], tableCount: (tables as any[]).length };
      }),
    });
  } catch (err) {
    console.error('[DataSources] list failed:', err);
    return res.status(500).json({ error: '数据源列表获取失败' });
  }
});

// GET /api/datasources/:id/data-version（所有登录用户）
// v0.4.8 数据版本指纹：看板/决策报表轮询此端检测底层数据变化，变化时自主重放 SQL/重新生成报表。
// 轻量探测（information_schema / pg_stat）+ 服务端 10s 缓存，不写审计避免轮询噪音。
router.get('/:id/data-version', async (req, res) => {
  const dataSourceId = String(req.params.id || '');
  if (!dataSourceId) return res.status(400).json({ error: '数据源 ID 必填' });
  try {
    const out = await computeDataVersion(dataSourceId);
    if (out.reason === 'NOT_FOUND') return res.status(404).json({ error: '数据源不存在' });
    return res.json({ version: out.version, checkedAt: new Date().toISOString(), ...(out.reason ? { reason: out.reason } : {}) });
  } catch (err) {
    console.error('[DataSources] data-version failed:', err);
    return res.status(500).json({ error: '数据版本探测失败' });
  }
});

// GET /api/datasources/:id/flex-schema（ADMIN/ANALYST）
// v0.4.9 灵活查询：拖拉拽构建器需要表/列结构；列表接口对非 ADMIN 不下发 tables 详情，
// 此端点单独开放只读 schema（执行仍受 executeSafeSql 白名单 + 敏感列 + 行级过滤约束）。
// P2-11：同样受数据源 ACL 约束（无权限的分析师不可绕过列表限制读取 schema）。
router.get('/:id/flex-schema', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const dataSourceId = String(req.params.id || '');
  try {
    if (!(await checkDataSourceAccess(req.user!, dataSourceId))) {
      return res.status(403).json({ code: 'DS_ACCESS_DENIED', error: '没有该数据源的访问权限，可向管理员申请开通' });
    }
    const [rows] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [dataSourceId]);
    const list = rows as any[];
    if (!list.length) return res.status(404).json({ error: '数据源不存在' });
    const ds = rowToDataSource(list[0]);
    if (ds.status === 'disconnected') {
      return res.status(403).json({ error: '该数据源已被管理员停用' });
    }
    return res.json({ success: true, tables: ds.tables || [] });
  } catch (err) {
    console.error('[DataSources] flex-schema failed:', err);
    return res.status(500).json({ error: 'Schema 获取失败' });
  }
});

// POST /api/datasources（仅 ADMIN）
// 数据库类型（mysql/postgresql/greenplum）忽略前端提交的 tables，真实连接数据库提取完整 Schema
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { name, type, config, tables } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '数据源名称必填' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: '数据源类型无效' });
  }

  let schemaTables = Array.isArray(tables) ? tables : [];
  if (isDbType(type)) {
    try {
      schemaTables = await extractDbSchema(type, config);
    } catch (err: any) {
      return res.status(400).json({ error: `数据库连接失败，无法提取表结构：${err?.message || '未知错误'}` });
    }
  }

  const id = `ds_${Date.now()}`;
  try {
    await getPool().query(
      'INSERT INTO data_sources (id, name, type, config_json, schema_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        name.trim().slice(0, 128),
        type,
        JSON.stringify(encryptConfigPassword(config && typeof config === 'object' ? config : {})),
        JSON.stringify(schemaTables),
        'connected',
        req.user!.username,
      ]
    );
    const [rows] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.status(201).json({ success: true, id, dataSource: rowToDataSource((rows as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] create failed:', err);
    return res.status(500).json({ error: '数据源创建失败' });
  }
});

// POST /api/datasources/:id/sync-schema（ADMIN，数据库类型）
// 重新连接数据库提取最新表结构并覆盖 schema_json
router.post('/:id/sync-schema', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  try {
    const [rows] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    const ds = (rows as any[])[0];
    if (!ds) {
      return res.status(404).json({ error: '数据源不存在' });
    }
    if (!isDbType(String(ds.type))) {
      return res.status(400).json({ error: '仅 MySQL / PostgreSQL / Greenplum 数据源支持自动同步 Schema' });
    }

    const config = safeJson(ds.config_json, {});
    // 允许前端在本次请求中补充密码（历史数据源可能未保存密码）
    if (req.body?.password && !config.password) {
      config.password = String(req.body.password);
    }

    let tables;
    try {
      tables = await extractDbSchema(String(ds.type), config);
    } catch (err: any) {
      return res.status(400).json({ error: `同步失败，无法连接数据库：${err?.message || '未知错误'}` });
    }

    // 保留管理员在"指标维度维护"中对仍存在列的手工标注（新列用自动推导结果）
    const oldMeta = new Map<string, any>();
    const oldTableNotes = new Map<string, string>();
    for (const t of safeJson(ds.schema_json, []) as any[]) {
      if (t?.businessNote) oldTableNotes.set(String(t.name), String(t.businessNote));
      for (const c of t?.columns || []) {
        oldMeta.set(`${t.name}.${c.name}`, c);
      }
    }
    for (const t of tables) {
      const note = oldTableNotes.get(String(t.name));
      if (note) (t as any).businessNote = note; // 表级业务口径说明同步时保留
      t.columns = (t.columns || []).map((c: any) => {
        const old = oldMeta.get(`${t.name}.${c.name}`);
        if (!old) return c;
        return {
          ...c,
          isMetric: old.isMetric ?? c.isMetric,
          isDimension: old.isDimension ?? c.isDimension,
          description: old.description || c.description,
        };
      });
    }

    // 同步后清洗既有问数范围（剔除已删除的表/字段）
    const cleanedScope = sanitizeDataScope(tables, safeJson(ds.scope_json, null));

    await getPool().query(
      'UPDATE data_sources SET schema_json = ?, config_json = ?, scope_json = ?, status = ? WHERE id = ?',
      [JSON.stringify(tables), JSON.stringify(encryptConfigPassword(config)), cleanedScope ? JSON.stringify(cleanedScope) : null, 'connected', id]
    );
    void invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    const [updated] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.json({ success: true, dataSource: rowToDataSource((updated as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] sync-schema failed:', err);
    return res.status(500).json({ error: 'Schema 同步失败' });
  }
});

// PUT /api/datasources/:id（ADMIN）
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  const { name, type, config, tables, status, allowIntrospection, quickQuestions } = req.body || {};

  const updates: string[] = [];
  const params: any[] = [];
  if (name !== undefined) {
    updates.push('name = ?');
    params.push(String(name).slice(0, 128));
  }
  if (type !== undefined) {
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: '数据源类型无效' });
    }
    updates.push('type = ?');
    params.push(type);
  }
  if (config !== undefined) {
    updates.push('config_json = ?');
    params.push(JSON.stringify(encryptConfigPassword(config && typeof config === 'object' ? config : {})));
  }
  if (tables !== undefined) {
    updates.push('schema_json = ?');
    params.push(JSON.stringify(Array.isArray(tables) ? tables : []));
  }
  if (status !== undefined) {
    if (!['connected', 'disconnected', 'error'].includes(status)) {
      return res.status(400).json({ error: '状态无效' });
    }
    updates.push('status = ?');
    params.push(status);
  }
  if (allowIntrospection !== undefined) {
    updates.push('allow_introspection = ?');
    params.push(allowIntrospection ? 1 : 0);
  }
  if (quickQuestions !== undefined) {
    if (quickQuestions !== null && !Array.isArray(quickQuestions)) {
      return res.status(400).json({ error: 'quickQuestions 必须为字符串数组或 null' });
    }
    const list = Array.isArray(quickQuestions)
      ? quickQuestions.filter((q: any) => typeof q === 'string' && q.trim()).map((q: any) => String(q).trim().slice(0, 200)).slice(0, 12)
      : null;
    updates.push('quick_questions_json = ?');
    params.push(list ? JSON.stringify(list) : null);
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }

  try {
    params.push(id);
    const [result] = await getPool().query(
      `UPDATE data_sources SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({ error: '数据源不存在' });
    }
    void invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[DataSources] update failed:', err);
    return res.status(500).json({ error: '数据源更新失败' });
  }
});

// DELETE /api/datasources/:id（ADMIN）
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  try {
    const [result] = await getPool().query('DELETE FROM data_sources WHERE id = ?', [id]);
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({ error: '数据源不存在' });
    }
    void invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[DataSources] delete failed:', err);
    return res.status(500).json({ error: '数据源删除失败' });
  }
});

// PUT /api/datasources/:id/schema-meta（ADMIN）
// 管理员动态维护列的指标/维度角色与描述，以及表级业务口径说明（businessNote，注入问数 prompt）。
// body: { tables: [{ id, businessNote?, columns: [{ name, isMetric?, isDimension?, description? }] }] }
router.put('/:id/schema-meta', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  const payloadTables = req.body?.tables;
  if (!Array.isArray(payloadTables)) {
    return res.status(400).json({ error: '请求格式无效：tables 必须为数组' });
  }
  try {
    const [rows] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    const ds = (rows as any[])[0];
    if (!ds) {
      return res.status(404).json({ error: '数据源不存在' });
    }

    const tables = safeJson(ds.schema_json, []);
    if (!Array.isArray(tables)) {
      return res.status(500).json({ error: '数据源 Schema 数据异常' });
    }

    let touched = 0;
    for (const pt of payloadTables) {
      if (!pt || typeof pt !== 'object') continue;
      const table = tables.find((t: any) => t.id === pt.id || t.name === pt.name);
      if (!table) continue;
      // 表级业务口径说明（P2）：如"复购率=90天内≥2单客户/总客户"，将随 Schema 注入 LLM 上下文
      if (pt.businessNote !== undefined) {
        if (typeof pt.businessNote !== 'string') return res.status(400).json({ error: 'businessNote 必须为字符串' });
        const note = pt.businessNote.trim().slice(0, 500);
        if (note) table.businessNote = note;
        else delete table.businessNote;
        touched++;
      }
      if (!Array.isArray(pt.columns)) continue;
      for (const pc of pt.columns) {
        if (!pc || typeof pc.name !== 'string') continue;
        const col = (table.columns || []).find((c: any) => c.name === pc.name);
        if (!col) continue;
        if (pc.isMetric !== undefined) {
          if (typeof pc.isMetric !== 'boolean') return res.status(400).json({ error: 'isMetric 必须为布尔值' });
          col.isMetric = pc.isMetric;
        }
        if (pc.isDimension !== undefined) {
          if (typeof pc.isDimension !== 'boolean') return res.status(400).json({ error: 'isDimension 必须为布尔值' });
          col.isDimension = pc.isDimension;
        }
        if (pc.description !== undefined) {
          col.description = String(pc.description).slice(0, 200);
        }
        touched++;
      }
    }

    await getPool().query('UPDATE data_sources SET schema_json = ? WHERE id = ?', [JSON.stringify(tables), id]);
    void invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    const [updated] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.json({ success: true, touched, dataSource: rowToDataSource((updated as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] update schema-meta failed:', err);
    return res.status(500).json({ error: '指标维度维护保存失败' });
  }
});

// PUT /api/datasources/:id/acl（ADMIN）
// P2-11 访问控制清单：body { departments?: string[], userIds?: number[] }，空对象/空数组 = 解除限制（全员可见）
router.put('/:id/acl', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  try {
    const [rows] = await getPool().query('SELECT id FROM data_sources WHERE id = ?', [id]);
    if (!(rows as any[])[0]) return res.status(404).json({ error: '数据源不存在' });

    const acl = sanitizeAcl(req.body);
    await getPool().query('UPDATE data_sources SET acl_json = ? WHERE id = ?', [
      acl ? JSON.stringify(acl) : null,
      id,
    ]);
    const [updated] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.json({ success: true, dataSource: rowToDataSource((updated as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] update acl failed:', err);
    return res.status(500).json({ error: '访问控制保存失败' });
  }
});

// PUT /api/datasources/:id/scope（ADMIN）
// 配置允许纳入智能问数的表与字段；body: { scope: null } 表示不限制
router.put('/:id/scope', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  try {
    const [rows] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    const ds = (rows as any[])[0];
    if (!ds) {
      return res.status(404).json({ error: '数据源不存在' });
    }

    const tables = safeJson(ds.schema_json, []);
    const scope = req.body?.scope === null ? null : sanitizeDataScope(tables, req.body?.scope);
    if (req.body?.scope !== null && req.body?.scope !== undefined && !scope) {
      return res.status(400).json({ error: '问数范围格式无效' });
    }

    await getPool().query('UPDATE data_sources SET scope_json = ? WHERE id = ?', [
      scope ? JSON.stringify(scope) : null,
      id,
    ]);
    void invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    const [updated] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.json({ success: true, dataSource: rowToDataSource((updated as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] update scope failed:', err);
    return res.status(500).json({ error: '问数范围保存失败' });
  }
});

// POST /api/datasources/test-connection（ADMIN）
// mysql/postgresql/greenplum 类型真实探测；其余类型保持模拟响应
router.post('/test-connection', requireRole('ADMIN'), async (req, res) => {
  const { type, config } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: 'Data source type is required.' });
  }

  if (type === 'postgresql' || type === 'greenplum') {
    const startedAt = Date.now();
    const label = type === 'greenplum' ? 'Greenplum' : 'PostgreSQL';
    try {
      const client = new pg.Client({
        host: config?.host || '127.0.0.1',
        port: Number(config?.port) || 5432,
        user: config?.username || 'postgres',
        // 测试连接的密码来自前端表单明文（尚未落库），不做解密
        password: config?.password || '',
        database: config?.database || undefined,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
      await client.connect();
      await client.query('SELECT 1');
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [String(config?.schema || 'public').trim() || 'public']
      );
      await client.end();
      return res.json({
        success: true,
        message: `成功连接 ${label} 数据源 (${config?.database || config?.host})`,
        latencyMs: Date.now() - startedAt,
        tableCount: Number(rows[0]?.cnt || 0),
      });
    } catch (err: any) {
      return res.status(200).json({
        success: false,
        message: `连接失败：${err?.message || '未知错误'}`,
        latencyMs: Date.now() - startedAt,
        tableCount: 0,
      });
    }
  }

  if (type === 'mysql') {
    const startedAt = Date.now();
    try {
      const conn = await mysql.createConnection({
        host: config?.host || '127.0.0.1',
        port: Number(config?.port) || 3306,
        user: config?.username || 'root',
        password: config?.password || '',
        database: config?.database || undefined,
        connectTimeout: 5000,
      });
      await conn.query('SELECT 1');
      const [tables] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = ?',
        [config?.database || '']
      );
      await conn.end();
      return res.json({
        success: true,
        message: `成功连接 MySQL 数据源 (${config?.database || config?.host})`,
        latencyMs: Date.now() - startedAt,
        tableCount: Number((tables as any[])[0]?.cnt || 0),
      });
    } catch (err: any) {
      return res.status(200).json({
        success: false,
        message: `连接失败：${err?.message || '未知错误'}`,
        latencyMs: Date.now() - startedAt,
        tableCount: 0,
      });
    }
  }

  // 非 mysql 类型：保持模拟响应
  setTimeout(() => {
    res.json({
      success: true,
      message: `Successfully connected to ${String(type).toUpperCase()} datasource (${config?.database || config?.url || 'Connected'})`,
      latencyMs: Math.floor(Math.random() * 40) + 15,
      tableCount: Math.floor(Math.random() * 5) + 3,
    });
  }, 600);
});

export default router;
