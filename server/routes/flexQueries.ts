/**
 * v0.9.24 灵活查询固定报表 + 最近查询历史服务端持久化
 * 固定报表（SavedFlexQuery）：团队共享查询模板——GET 全员可见；保存/删除限 ADMIN/ANALYST（删除需本人或 ADMIN）。
 * 查询历史（FlexHistoryItem）：个人行为记录——仅本人可见，整组替换语义（前端按配置去重、上限 8 条）。
 */
import { Router } from 'express';
import type mysql from 'mysql2/promise';
import { getPool } from '../db';
import { authMiddleware, requireRole } from '../auth';
import { writeAudit } from '../auditLog';
import { ERROR_CODES } from '../errorCodes';

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
  created_at: Date;
}

/** 行记录 → API 响应（query_data JSON 展开为 query 字段） */
export function toFlexQueryRecord(row: FlexQueryRow) {
  let query: SavedFlexQueryPayload | null = null;
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
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// GET /api/flex-queries —— 全员可见（团队查询模板复用），可按数据源过滤
router.get('/', authMiddleware, async (req, res) => {
  try {
    const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : '';
    const [rows] = dataSourceId
      ? await getPool().query<FlexQueryRow[]>(
          'SELECT query_id, user_id, username, data_source_id, query_data, created_at FROM flex_queries WHERE data_source_id = ? ORDER BY created_at DESC',
          [dataSourceId],
        )
      : await getPool().query<FlexQueryRow[]>(
          'SELECT query_id, user_id, username, data_source_id, query_data, created_at FROM flex_queries ORDER BY created_at DESC',
        );
    res.json({ success: true, queries: rows.map(toFlexQueryRecord) });
  } catch (err) {
    console.error('[flex-queries] 列表查询失败:', err);
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
    console.error('[flex-queries] 历史查询失败:', err);
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
    console.error('[flex-queries] 历史保存失败:', err);
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
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', dataSourceId: parsed.query.dataSourceId, status: 'SUCCESS', detail: `保存固定报表「${parsed.query.name}」（${parsed.query.id}）` });
    res.status(201).json({ success: true, queryId: parsed.query.id });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: ERROR_CODES.CONFLICT, error: '固定报表已存在' });
    }
    console.error('[flex-queries] 保存失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '固定报表保存失败' });
  }
});

// DELETE /api/flex-queries/:queryId —— 本人或 ADMIN
router.delete('/:queryId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const queryId = String(req.params.queryId || '');
  try {
    const [rows] = await getPool().query<FlexQueryRow[]>(
      'SELECT query_id, user_id, username, data_source_id, query_data, created_at FROM flex_queries WHERE query_id = ?',
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
    writeAudit({ userId: user.id, username: user.username, endpoint: 'flex_query', status: 'SUCCESS', detail: `删除固定报表 ${queryId}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[flex-queries] 删除失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '固定报表删除失败' });
  }
});

export default router;
