/**
 * 数据源管理路由。
 * 读取对所有登录用户开放（查询页需要 schema）；写入与连接测试仅 ADMIN。
 * mysql 类型执行真实连接探测，其余类型返回模拟结果。
 */
import { Router } from 'express';
import mysql from 'mysql2/promise';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { sanitizeDataScope } from '../scope';
import { invalidateSchemaCache } from '../schemaContext';
import { invalidateExecutorPool } from '../sqlExecutor';

const router = Router();
router.use(authMiddleware);

const VALID_TYPES = ['mysql', 'postgresql', 'csv', 'json', 'api', 'demo'];

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
    ['text', 'tinytext', 'mediumtext', 'longtext', 'json', 'blob'].includes(rawType) ||
    (maxLength != null && maxLength > 64);
  return { isMetric: false, isDimension: !isLongText };
}

// 真实连接 MySQL 并提取全部表与列结构（information_schema）
async function extractMysqlSchema(config: any) {
  const conn = await mysql.createConnection({
    host: config?.host || '127.0.0.1',
    port: Number(config?.port) || 3306,
    user: config?.username || 'root',
    password: config?.password || '',
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

    const colsByTable = new Map<string, any[]>();
    for (const c of colRows as any[]) {
      const type = mapMysqlType(c.dataType);
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

    return (tableRows as any[]).map((t) => ({
      id: `tbl_${t.name}`,
      name: t.name,
      displayName: t.comment ? String(t.comment).split(';')[0].split('\n')[0] || t.name : t.name,
      description: t.comment || `数据表 ${t.name}`,
      rowCount: Number(t.rowCount || 0),
      columns: colsByTable.get(t.name) || [],
    }));
  } finally {
    await conn.end();
  }
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
router.get('/', async (_req, res) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM data_sources ORDER BY created_at ASC');
    return res.json({ dataSources: (rows as any[]).map(rowToDataSource) });
  } catch (err) {
    console.error('[DataSources] list failed:', err);
    return res.status(500).json({ error: '数据源列表获取失败' });
  }
});

// POST /api/datasources（ADMIN）
// mysql 类型忽略前端提交的 tables，真实连接数据库提取完整 Schema
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { name, type, config, tables } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '数据源名称必填' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: '数据源类型无效' });
  }

  let schemaTables = Array.isArray(tables) ? tables : [];
  if (type === 'mysql') {
    try {
      schemaTables = await extractMysqlSchema(config);
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
        JSON.stringify(config && typeof config === 'object' ? config : {}),
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

// POST /api/datasources/:id/sync-schema（ADMIN，仅 mysql）
// 重新连接数据库提取最新表结构并覆盖 schema_json
router.post('/:id/sync-schema', requireRole('ADMIN'), async (req, res) => {
  const id = String(req.params.id);
  try {
    const [rows] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    const ds = (rows as any[])[0];
    if (!ds) {
      return res.status(404).json({ error: '数据源不存在' });
    }
    if (ds.type !== 'mysql') {
      return res.status(400).json({ error: '仅 MySQL 数据源支持自动同步 Schema' });
    }

    const config = safeJson(ds.config_json, {});
    // 允许前端在本次请求中补充密码（历史数据源可能未保存密码）
    if (req.body?.password && !config.password) {
      config.password = String(req.body.password);
    }

    let tables;
    try {
      tables = await extractMysqlSchema(config);
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
      if (note) t.businessNote = note; // 表级业务口径说明同步时保留
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
      [JSON.stringify(tables), JSON.stringify(config), cleanedScope ? JSON.stringify(cleanedScope) : null, 'connected', id]
    );
    invalidateSchemaCache(id);
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
  const { name, type, config, tables, status } = req.body || {};

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
    params.push(JSON.stringify(config && typeof config === 'object' ? config : {}));
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
    invalidateSchemaCache(id);
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
    invalidateSchemaCache(id);
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
    invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    const [updated] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.json({ success: true, touched, dataSource: rowToDataSource((updated as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] update schema-meta failed:', err);
    return res.status(500).json({ error: '指标维度维护保存失败' });
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
    invalidateSchemaCache(id);
    invalidateExecutorPool(id);
    const [updated] = await getPool().query('SELECT * FROM data_sources WHERE id = ?', [id]);
    return res.json({ success: true, dataSource: rowToDataSource((updated as any[])[0]) });
  } catch (err) {
    console.error('[DataSources] update scope failed:', err);
    return res.status(500).json({ error: '问数范围保存失败' });
  }
});

// POST /api/datasources/test-connection（ADMIN）
// mysql 类型真实探测；其余类型保持模拟响应
router.post('/test-connection', requireRole('ADMIN'), async (req, res) => {
  const { type, config } = req.body || {};
  if (!type) {
    return res.status(400).json({ error: 'Data source type is required.' });
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
