/**
 * v0.9.24 灵活查询固定报表 + 最近查询历史服务端持久化
 * 固定报表（SavedFlexQuery）：团队共享查询模板——GET 全员可见；保存/删除限 ADMIN/ANALYST（删除需本人或 ADMIN）。
 * 查询历史（FlexHistoryItem）：个人行为记录——仅本人可见，整组替换语义（前端按配置去重、上限 8 条）。
 * v0.9.77 P2-15：版本历史（快照/回滚，对齐 metric_versions 模式）、使用统计（use_count/last_used_at 打点）、
 * 订阅（{queryId}/subscriptions + /subscriptions/:id 系列，调度器见 server/flexSubscriptions.ts）、
 * Excel 导出（服务端重放固定报表并组装 XLSX，见 server/flexQueryRunner.ts）。
 */
import { Router } from 'express';
import ExcelJS from 'exceljs';
import type mysql from 'mysql2/promise';
import { getPool } from '../infra/db';
import { authMiddleware, requireRole } from '../auth/auth';
import { writeAudit } from '../infra/auditLog';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { runSavedFlexQuery } from '../flexQueryRunner';
import {
  executeSubscription,
  normalizeSubscriptionPayload,
  toSubscriptionRecord,
  type FlexSubscriptionRow,
} from '../flexSubscriptions';

const router = Router();

const HISTORY_LIMIT = 8;

export interface SavedFlexQueryPayload {
  id: string;
  name: string;
  dataSourceId: string;
  config: Record<string, unknown>;
  chartType: string;
  createdAt: string;
}

/** 入站校验：固定报表 JSON 的最低结构要求（config 宽松透传，载入侧有兼容逻辑） */
export function normalizeFlexQueryPayload(
  raw: unknown,
): { ok: true; query: SavedFlexQueryPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '固定报表数据格式不正确' };
  }
  const q = raw as Record<string, unknown>;
  const id = typeof q.id === 'string' ? q.id.trim() : '';
  if (!id) return { ok: false, error: '缺少固定报表标识' };
  if (id.length > 64) return { ok: false, error: '固定报表标识过长' };
  const name = typeof q.name === 'string' ? q.name.trim() : '';
  if (!name) return { ok: false, error: '固定报表名称不能为空' };
  if (name.length > 200) return { ok: false, error: '固定报表名称过长' };
  if (!q.config || typeof q.config !== 'object' || Array.isArray(q.config)) {
    return { ok: false, error: '缺少查询配置' };
  }
  const query = q as unknown as SavedFlexQueryPayload;
  query.id = id;
  query.name = name;
  if (typeof query.dataSourceId !== 'string') query.dataSourceId = '';
  return { ok: true, query };
}

/** 历史整组入站校验：仅保留结构合法条目并裁剪上限（服务端兜底，前端同样去重裁剪） */
export function normalizeFlexHistoryItems(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        !!item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).config === 'object' &&
        (item as Record<string, unknown>).config !== null,
    )
    .slice(0, HISTORY_LIMIT);
}

interface FlexQueryRow extends mysql.RowDataPacket {
  query_id: string;
  user_id: number;
  username: string;
  data_source_id: string;
  query_data: string;
  version?: number;
  use_count?: number;
  last_used_at?: Date | null;
  created_at: Date;
}

/** 固定报表 SELECT 列（列表/单条/更新前置查询共用，改列须同步） */
const FLEX_QUERY_COLS = 'query_id, user_id, username, data_source_id, query_data, version, use_count, last_used_at, created_at';

/** 行记录 → API 响应（query_data JSON 展开为 query 字段） */
export function toFlexQueryRecord(row: FlexQueryRow) {
  let query: SavedFlexQueryPayload | null;
  try {
    query = JSON.parse(row.query_data) as SavedFlexQueryPayload;
  } catch {
    query = null;
  }
  return {
    queryId: row.query_id,
    userId: row.user_id,
    username: row.username,
    dataSourceId: row.data_source_id,
    query,
    version: Number(row.version || 1),
    useCount: Number(row.use_count || 0),
    lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : (row.last_used_at ? String(row.last_used_at) : null),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** 写版本历史快照（创建/更新/回滚均调用；失败仅告警不阻塞主流程——历史是增强能力） */
async function recordFlexVersion(
  queryId: string,
  version: number,
  snapshot: SavedFlexQueryPayload,
  action: 'CREATE' | 'UPDATE' | 'RESTORE',
  actor: string,
  remark = '',
): Promise<void> {
  try {
    await getPool().query(
      'INSERT INTO flex_query_versions (query_id, version, snapshot_json, action, actor, remark) VALUES (?, ?, ?, ?, ?, ?)',
      [queryId, version, JSON.stringify(snapshot), action, actor, remark],
    );
  } catch (err) {
    logger.warn('[flex-queries] 版本快照写入失败:', err);
  }
}

// GET /api/flex-queries —— 全员可见（团队查询模板复用），可按数据源过滤
router.get('/', authMiddleware, async (req, res) => {
  try {
    const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : '';
    const [rows] = dataSourceId
      ? await getPool().query<FlexQueryRow[]>(
          `SELECT ${FLEX_QUERY_COLS} FROM flex_queries WHERE data_source_id = ? ORDER BY created_at DESC`,
          [dataSourceId],
        )
      : await getPool().query<FlexQueryRow[]>(
          `SELECT ${FLEX_QUERY_COLS} FROM flex_queries ORDER BY created_at DESC`,
        );
    res.json({ success: true, queries: rows.map(toFlexQueryRecord) });
  } catch (err) {
    logger.error('[flex-queries] 列表查询失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '固定报表列表获取失败' });
  }
});

// GET /api/flex-queries/history —— 本人最近查询历史（需在 /:queryId 语义之前注册，避免被吞）
router.get('/history', authMiddleware, async (req, res) => {
  const user = req.user!;
  try {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT history_data FROM flex_query_history WHERE user_id = ?',
      [user.id],
    );
    let items: unknown[] = [];
    if (rows[0]?.history_data) {
      try {
        const parsed = JSON.parse(String(rows[0].history_data));
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [];
      }
    }
    res.json({ success: true, items });
  } catch (err) {
    logger.error('[flex-queries] 历史查询失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '查询历史获取失败' });
  }
});

// PUT /api/flex-queries/history —— 本人历史整组替换（去重/裁剪由前端完成，服务端兜底校验）
router.put('/history', authMiddleware, async (req, res) => {
  const user = req.user!;
  const items = normalizeFlexHistoryItems(req.body?.items);
  try {
    await getPool().query(
      `INSERT INTO flex_query_history (user_id, history_data) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE history_data = VALUES(history_data)`,
      [user.id, JSON.stringify(items)],
    );
    res.json({ success: true, count: items.length });
  } catch (err) {
    logger.error('[flex-queries] 历史保存失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '查询历史保存失败' });
  }
});

// POST /api/flex-queries —— 保存固定报表（需灵活查询执行权限），query_id 唯一冲突返回 409（迁移幂等）
router.post('/', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const parsed = normalizeFlexQueryPayload(req.body?.query ?? req.body);
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  try {
    await getPool().query(
      'INSERT INTO flex_queries (query_id, user_id, username, data_source_id, query_data) VALUES (?, ?, ?, ?, ?)',
      [parsed.query.id, user.id, user.username, parsed.query.dataSourceId, JSON.stringify(parsed.query)],
    );
    // v0.9.77 P2-15：初始版本快照（v1），版本历史从创建开始完整可追溯
    await recordFlexVersion(parsed.query.id, 1, parsed.query, 'CREATE', user.username, '初始版本');
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', dataSourceId: parsed.query.dataSourceId, status: 'SUCCESS', detail: `保存固定报表「${parsed.query.name}」（${parsed.query.id}）` });
    res.status(201).json({ success: true, queryId: parsed.query.id });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: ERROR_CODES.CONFLICT, error: '固定报表已存在' });
    }
    logger.error('[flex-queries] 保存失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '固定报表保存失败' });
  }
});

// DELETE /api/flex-queries/:queryId —— 本人或 ADMIN（级联清理版本历史与订阅，避免孤儿数据）
router.delete('/:queryId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const queryId = String(req.params.queryId || '');
  try {
    const [rows] = await getPool().query<FlexQueryRow[]>(
      `SELECT ${FLEX_QUERY_COLS} FROM flex_queries WHERE query_id = ?`,
      [queryId],
    );
    const row = rows[0];
    if (!row || (row.user_id !== user.id && user.role !== 'ADMIN')) {
      if (row) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'DENIED_AUTH', detail: `越权删除固定报表 ${queryId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '固定报表不存在' });
    }
    await getPool().query('DELETE FROM flex_queries WHERE query_id = ?', [queryId]);
    // v0.9.77 P2-15 级联：订阅运行历史 → 订阅 → 版本历史（删主行后残留无意义）
    await getPool().query(
      'DELETE FROM flex_query_subscription_runs WHERE subscription_id IN (SELECT subscription_id FROM flex_query_subscriptions WHERE query_id = ?)',
      [queryId],
    );
    await getPool().query('DELETE FROM flex_query_subscriptions WHERE query_id = ?', [queryId]);
    await getPool().query('DELETE FROM flex_query_versions WHERE query_id = ?', [queryId]);
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'SUCCESS', detail: `删除固定报表 ${queryId}` });
    res.json({ success: true });
  } catch (err) {
    logger.error('[flex-queries] 删除失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '固定报表删除失败' });
  }
});

// PUT /api/flex-queries/:queryId —— 更新固定报表（本人或 ADMIN；queryId 以路径为准）；version+1 并写版本快照
router.put('/:queryId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const queryId = String(req.params.queryId || '');
  const parsed = normalizeFlexQueryPayload(req.body?.query ?? req.body);
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  parsed.query.id = queryId; // 路径为准，防 body.id 与路径不一致造成混淆
  try {
    const [rows] = await getPool().query<FlexQueryRow[]>(
      `SELECT ${FLEX_QUERY_COLS} FROM flex_queries WHERE query_id = ?`,
      [queryId],
    );
    const row = rows[0];
    if (!row || (row.user_id !== user.id && user.role !== 'ADMIN')) {
      if (row) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'DENIED_AUTH', detail: `越权更新固定报表 ${queryId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '固定报表不存在' });
    }
    const nextVersion = Number(row.version || 1) + 1;
    await getPool().query(
      'UPDATE flex_queries SET query_data = ?, data_source_id = ?, version = ? WHERE query_id = ?',
      [JSON.stringify(parsed.query), parsed.query.dataSourceId || '', nextVersion, queryId],
    );
    await recordFlexVersion(queryId, nextVersion, parsed.query, 'UPDATE', user.username, '');
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', dataSourceId: parsed.query.dataSourceId, status: 'SUCCESS', detail: `更新固定报表「${parsed.query.name}」（${queryId} v${nextVersion}）` });
    res.json({ success: true, queryId, version: nextVersion });
  } catch (err) {
    logger.error('[flex-queries] 更新失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '固定报表更新失败' });
  }
});

// POST /api/flex-queries/:queryId/touch —— 使用打点（全员；载入/执行固定报表时调用，失败容忍）
router.post('/:queryId/touch', authMiddleware, async (req, res) => {
  const queryId = String(req.params.queryId || '');
  try {
    await getPool().query(
      'UPDATE flex_queries SET use_count = use_count + 1, last_used_at = NOW() WHERE query_id = ?',
      [queryId],
    );
    res.json({ success: true });
  } catch (err) {
    logger.warn('[flex-queries] 使用打点失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '使用打点失败' });
  }
});

// GET /api/flex-queries/:queryId/versions —— 版本历史（新→旧，含快照内容供前端对比）
router.get('/:queryId/versions', authMiddleware, async (req, res) => {
  const queryId = String(req.params.queryId || '');
  try {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT version, snapshot_json, action, actor, remark, created_at FROM flex_query_versions WHERE query_id = ? ORDER BY version DESC, id DESC LIMIT 50',
      [queryId],
    );
    res.json({
      success: true,
      versions: rows.map((r) => {
        let snapshot: unknown;
        try {
          snapshot = JSON.parse(String(r.snapshot_json || 'null'));
        } catch {
          snapshot = null;
        }
        return {
          version: Number(r.version),
          action: String(r.action || ''),
          actor: String(r.actor || ''),
          remark: String(r.remark || ''),
          snapshot,
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''),
        };
      }),
    });
  } catch (err) {
    logger.error('[flex-queries] 版本历史查询失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '版本历史获取失败' });
  }
});

// POST /api/flex-queries/:queryId/versions/:version/restore —— 回滚到指定版本（本人或 ADMIN；version+1 并记 RESTORE 历史）
router.post('/:queryId/versions/:version/restore', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const queryId = String(req.params.queryId || '');
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '版本号非法' });
  }
  try {
    const [rows] = await getPool().query<FlexQueryRow[]>(
      `SELECT ${FLEX_QUERY_COLS} FROM flex_queries WHERE query_id = ?`,
      [queryId],
    );
    const row = rows[0];
    if (!row || (row.user_id !== user.id && user.role !== 'ADMIN')) {
      if (row) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'DENIED_AUTH', detail: `越权回滚固定报表 ${queryId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '固定报表不存在' });
    }
    const [vRows] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT snapshot_json FROM flex_query_versions WHERE query_id = ? AND version = ? ORDER BY id DESC LIMIT 1',
      [queryId, version],
    );
    if (!vRows[0]) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '版本不存在' });
    }
    let snap: unknown;
    try {
      snap = JSON.parse(String(vRows[0].snapshot_json || '{}'));
    } catch {
      return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '版本快照损坏' });
    }
    const parsed = normalizeFlexQueryPayload({ ...(snap as Record<string, unknown>), id: queryId });
    if (parsed.ok === false) {
      return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: `版本快照校验失败：${parsed.error}` });
    }
    const nextVersion = Number(row.version || 1) + 1;
    await getPool().query(
      'UPDATE flex_queries SET query_data = ?, data_source_id = ?, version = ? WHERE query_id = ?',
      [JSON.stringify(parsed.query), parsed.query.dataSourceId || '', nextVersion, queryId],
    );
    await recordFlexVersion(queryId, nextVersion, parsed.query, 'RESTORE', user.username, `回滚自 v${version}`);
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', dataSourceId: parsed.query.dataSourceId, status: 'SUCCESS', detail: `回滚固定报表 ${queryId} 至 v${version}（生成 v${nextVersion}）` });
    res.json({ success: true, queryId, version: nextVersion, restoredFrom: version });
  } catch (err) {
    logger.error('[flex-queries] 版本回滚失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '版本回滚失败' });
  }
});

// POST /api/flex-queries/:queryId/subscriptions —— 创建订阅（需报表存在；首次执行延后一个周期）
router.post('/:queryId/subscriptions', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const queryId = String(req.params.queryId || '');
  const parsed = normalizeSubscriptionPayload(req.body || {});
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  const p = parsed.payload;
  try {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT query_id FROM flex_queries WHERE query_id = ? LIMIT 1',
      [queryId],
    );
    if (!rows[0]) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '固定报表不存在' });
    }
    const subscriptionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await getPool().query(
      `INSERT INTO flex_query_subscriptions
         (subscription_id, query_id, user_id, username, frequency_minutes, alert_metric, alert_op, alert_threshold, status, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW() + INTERVAL ? MINUTE)`,
      [subscriptionId, queryId, user.id, user.username, p.frequencyMinutes, p.alertMetric, p.alertOp, p.alertThreshold, p.frequencyMinutes],
    );
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'SUCCESS', detail: `创建订阅 ${subscriptionId}（报表 ${queryId}，周期 ${p.frequencyMinutes} 分钟${p.alertMetric ? `，告警 ${p.alertMetric} ${p.alertOp} ${p.alertThreshold}` : ''}）` });
    res.status(201).json({ success: true, subscriptionId });
  } catch (err) {
    logger.error('[flex-queries] 创建订阅失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '订阅创建失败' });
  }
});

// GET /api/flex-queries/:queryId/subscriptions —— 该报表订阅列表（全员可见，团队共享展示）
router.get('/:queryId/subscriptions', authMiddleware, async (req, res) => {
  const queryId = String(req.params.queryId || '');
  try {
    const [rows] = await getPool().query<FlexSubscriptionRow[]>(
      'SELECT * FROM flex_query_subscriptions WHERE query_id = ? ORDER BY created_at DESC LIMIT 100',
      [queryId],
    );
    res.json({ success: true, subscriptions: rows.map(toSubscriptionRecord) });
  } catch (err) {
    logger.error('[flex-queries] 订阅列表查询失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '订阅列表获取失败' });
  }
});

// GET /api/flex-queries/subscriptions/:subscriptionId/runs —— 订阅运行历史（新→旧）
router.get('/subscriptions/:subscriptionId/runs', authMiddleware, async (req, res) => {
  const subscriptionId = String(req.params.subscriptionId || '');
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 100) : 20;
  try {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT status, row_count, alert_value, message, duration_ms, run_at FROM flex_query_subscription_runs WHERE subscription_id = ? ORDER BY id DESC LIMIT ?',
      [subscriptionId, limit],
    );
    res.json({
      success: true,
      runs: rows.map((r) => ({
        status: String(r.status || ''),
        rowCount: Number(r.row_count || 0),
        alertValue: String(r.alert_value || ''),
        message: String(r.message || ''),
        durationMs: Number(r.duration_ms || 0),
        runAt: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at || ''),
      })),
    });
  } catch (err) {
    logger.error('[flex-queries] 订阅运行历史查询失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '订阅运行历史获取失败' });
  }
});

// PUT /api/flex-queries/subscriptions/:subscriptionId —— 更新订阅（本人或 ADMIN；更新即重新排期）
router.put('/subscriptions/:subscriptionId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const subscriptionId = String(req.params.subscriptionId || '');
  const parsed = normalizeSubscriptionPayload(req.body || {});
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  const p = parsed.payload;
  try {
    const [rows] = await getPool().query<FlexSubscriptionRow[]>(
      'SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1',
      [subscriptionId],
    );
    const sub = rows[0];
    if (!sub || (sub.user_id !== user.id && user.role !== 'ADMIN')) {
      if (sub) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'DENIED_AUTH', detail: `越权更新订阅 ${subscriptionId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '订阅不存在' });
    }
    const statusRaw = typeof req.body?.status === 'string' ? String(req.body.status).toUpperCase() : '';
    const status = statusRaw === 'PAUSED' ? 'PAUSED' : statusRaw === 'ACTIVE' ? 'ACTIVE' : String(sub.status || 'ACTIVE');
    await getPool().query(
      'UPDATE flex_query_subscriptions SET frequency_minutes = ?, alert_metric = ?, alert_op = ?, alert_threshold = ?, status = ?, next_run_at = NOW() + INTERVAL ? MINUTE WHERE subscription_id = ?',
      [p.frequencyMinutes, p.alertMetric, p.alertOp, p.alertThreshold, status, p.frequencyMinutes, subscriptionId],
    );
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'SUCCESS', detail: `更新订阅 ${subscriptionId}（周期 ${p.frequencyMinutes} 分钟，状态 ${status}）` });
    res.json({ success: true });
  } catch (err) {
    logger.error('[flex-queries] 更新订阅失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '订阅更新失败' });
  }
});

// DELETE /api/flex-queries/subscriptions/:subscriptionId —— 删除订阅（本人或 ADMIN；级联运行历史）
router.delete('/subscriptions/:subscriptionId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const subscriptionId = String(req.params.subscriptionId || '');
  try {
    const [rows] = await getPool().query<FlexSubscriptionRow[]>(
      'SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1',
      [subscriptionId],
    );
    const sub = rows[0];
    if (!sub || (sub.user_id !== user.id && user.role !== 'ADMIN')) {
      if (sub) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'DENIED_AUTH', detail: `越权删除订阅 ${subscriptionId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '订阅不存在' });
    }
    await getPool().query('DELETE FROM flex_query_subscription_runs WHERE subscription_id = ?', [subscriptionId]);
    await getPool().query('DELETE FROM flex_query_subscriptions WHERE subscription_id = ?', [subscriptionId]);
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'SUCCESS', detail: `删除订阅 ${subscriptionId}` });
    res.json({ success: true });
  } catch (err) {
    logger.error('[flex-queries] 删除订阅失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '订阅删除失败' });
  }
});

// POST /api/flex-queries/subscriptions/:subscriptionId/run —— 立即执行一次（本人或 ADMIN；不改变既有排期）
router.post('/subscriptions/:subscriptionId/run', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const subscriptionId = String(req.params.subscriptionId || '');
  try {
    const [rows] = await getPool().query<FlexSubscriptionRow[]>(
      'SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1',
      [subscriptionId],
    );
    const sub = rows[0];
    if (!sub || (sub.user_id !== user.id && user.role !== 'ADMIN')) {
      if (sub) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'DENIED_AUTH', detail: `越权执行订阅 ${subscriptionId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '订阅不存在' });
    }
    const out = await executeSubscription(subscriptionId);
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'flex_query',
      question: `flex-sub-run:${subscriptionId}`,
      status: out.status === 'FAILED' ? 'ERROR' : 'SUCCESS',
      detail: `手动执行订阅：${out.status} - ${out.message}`,
      rowCount: out.rowCount,
      durationMs: out.durationMs,
    });
    res.json({ success: true, result: out });
  } catch (err) {
    logger.error('[flex-queries] 立即执行订阅失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '订阅执行失败' });
  }
});

/** 导出文件名：报表名-YYYYMMDD-HHmm.xlsx（兼容路径非法字符） */
export function buildFlexExportFilename(name: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const safe = String(name || '灵活查询').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return `${safe}-${stamp}.xlsx`;
}

/** 单元格值归一：null/undefined → 空串；Date → ISO；对象 → JSON 字符串；其余原样 */
function normalizeExcelCell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Excel 组装（纯构建函数可单测）：水印行 + 深色表头 + 数据行 + 自适应列宽，单工作表。
 * 大结果集（最多 10 万行）由 exceljs 流式写入 Buffer；列宽仅采样前 200 行防大表遍历。
 */
export async function buildFlexQueryExcel(opts: {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  exportedBy?: string;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '智能问数据分析系统';
  wb.created = new Date();
  const ws = wb.addWorksheet('查询结果');
  const watermark = `本文件由智能问数据分析系统生成${opts.exportedBy ? ` · 导出人: ${opts.exportedBy}` : ''} · 含访问水印，严禁外传`;
  const wm = ws.addRow([watermark]);
  wm.getCell(1).font = { size: 9, color: { argb: '64748B' }, italic: true };

  const cols = opts.columns;
  if (cols.length === 0) {
    ws.addRow(['（查询结果为空，无列数据）']);
  } else {
    const head = ws.addRow(cols);
    head.eachCell((cell) => {
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };
    });
    for (const r of opts.rows) {
      ws.addRow(cols.map((c) => normalizeExcelCell(r[c])));
    }
    cols.forEach((c, i) => {
      let width = Math.max(8, Math.min(24, c.length + 4));
      for (const r of opts.rows.slice(0, 200)) {
        width = Math.max(width, Math.min(40, String(normalizeExcelCell(r[c])).length + 2));
      }
      ws.getColumn(i + 1).width = width;
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// POST /api/flex-queries/:queryId/export-excel —— 服务端重放固定报表并组装 XLSX（数据完整、统一审计）
router.post('/:queryId/export-excel', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const queryId = String(req.params.queryId || '');
  const startedAt = Date.now();
  try {
    const run = await runSavedFlexQuery(queryId, { scenario: 'export' });
    if (run.ok !== true) {
      writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', question: `export-excel:${queryId}`, status: run.notFound ? 'DENIED_INPUT' : 'ERROR', detail: `导出失败：${run.error}`, durationMs: Date.now() - startedAt });
      return res.status(run.notFound ? 404 : 422).json({ code: run.notFound ? ERROR_CODES.NOT_FOUND : ERROR_CODES.INVALID_INPUT, error: run.error });
    }
    const buffer = await buildFlexQueryExcel({
      title: run.data.name,
      columns: run.data.columns,
      rows: run.data.rows,
      exportedBy: `${user.username}${user.department ? `（${user.department}）` : ''} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    });
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', dataSourceId: run.data.dataSourceId, question: `export-excel:${run.data.name}`, status: 'SUCCESS', detail: `导出固定报表「${run.data.name}」（${run.data.rowCount} 行${run.data.truncated ? '，已截断' : ''}）`, rowCount: run.data.rowCount, durationMs: Date.now() - startedAt });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(buildFlexExportFilename(run.data.name))}`);
    return res.send(buffer);
  } catch (err) {
    logger.error('[flex-queries] Excel 导出失败:', err);
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', question: `export-excel:${queryId}`, status: 'ERROR', detail: 'Excel 生成失败', durationMs: Date.now() - startedAt });
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: 'Excel 生成失败，请稍后重试' });
  }
});

export default router;
