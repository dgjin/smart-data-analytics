/**
 * v0.9.24 决策数据看板固化图表服务端持久化
 * 看板为团队共享巡检屏：GET 全员可见；固化/布局调整（含排序）限 ADMIN/ANALYST；删除需本人或 ADMIN。
 * 出厂内置 5 个默认图表由 db.ts 启动时 seed（user_id=0 / system，仅 ADMIN 可删）。
 */
import { Router } from 'express';
import type mysql from 'mysql2/promise';
import { getPool } from '../db';
import { authMiddleware, requireRole } from '../auth';
import { writeAudit } from '../auditLog';
import { ERROR_CODES } from '../errorCodes';

const router = Router();

export interface DashboardWidgetPayload {
  id: string;
  title: string;
  chartConfig: Record<string, unknown>;
  data: Record<string, unknown>[];
  dataSourceId?: string;
  sourceSql?: string;
  lastAutoUpdatedAt?: string;
  colSpan?: 1 | 2 | 3;
  height?: number;
}

/** 入站校验：固化图表 JSON 的最低结构要求（宽松透传 chartConfig/data，由前端渲染层兜底） */
export function normalizeDashboardWidgetPayload(
  raw: unknown,
): { ok: true; widget: DashboardWidgetPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '图表数据格式不正确' };
  }
  const w = raw as Record<string, unknown>;
  const id = typeof w.id === 'string' ? w.id.trim() : '';
  if (!id) return { ok: false, error: '缺少图表标识' };
  if (id.length > 64) return { ok: false, error: '图表标识过长' };
  const title = typeof w.title === 'string' ? w.title.trim() : '';
  if (!title) return { ok: false, error: '图表标题不能为空' };
  if (title.length > 200) return { ok: false, error: '图表标题过长' };
  if (!w.chartConfig || typeof w.chartConfig !== 'object' || Array.isArray(w.chartConfig)) {
    return { ok: false, error: '缺少图表配置' };
  }
  if (!Array.isArray(w.data)) return { ok: false, error: '图表数据必须为数组' };
  const widget = w as unknown as DashboardWidgetPayload;
  widget.id = id;
  widget.title = title;
  return { ok: true, widget };
}

interface DashboardWidgetRow extends mysql.RowDataPacket {
  widget_id: string;
  user_id: number;
  username: string;
  widget_data: string;
}

/** 行记录 → API 响应（widget_data JSON 展开为 widget 字段） */
export function toDashboardWidgetRecord(row: DashboardWidgetRow) {
  let widget: DashboardWidgetPayload | null = null;
  try {
    widget = JSON.parse(row.widget_data) as DashboardWidgetPayload;
  } catch {
    widget = null;
  }
  return {
    widgetId: row.widget_id,
    userId: row.user_id,
    username: row.username,
    widget,
  };
}

// GET /api/dashboard-widgets —— 全员可见（共享巡检屏），按排序字段升序
router.get('/', authMiddleware, async (_req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query<DashboardWidgetRow[]>(
      'SELECT widget_id, user_id, username, widget_data FROM dashboard_widgets ORDER BY sort_order ASC, created_at ASC',
    );
    res.json({ success: true, widgets: rows.map(toDashboardWidgetRecord) });
  } catch (err) {
    console.error('[dashboard-widgets] 列表查询失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '看板图表列表获取失败' });
  }
});

// POST /api/dashboard-widgets —— 固化新图表（需问数权限），widget_id 唯一冲突返回 409（迁移幂等）
router.post('/', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const parsed = normalizeDashboardWidgetPayload(req.body?.widget ?? req.body);
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO dashboard_widgets (widget_id, user_id, username, widget_data, sort_order)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(t.sort_order), -1) + 1 FROM (SELECT sort_order FROM dashboard_widgets) AS t))`,
      [parsed.widget.id, user.id, user.username, JSON.stringify(parsed.widget)],
    );
    writeAudit({ userId: user.id, username: user.username, endpoint: 'dashboard_widget', status: 'SUCCESS', detail: `固化看板图表「${parsed.widget.title}」（${parsed.widget.id}）` });
    res.status(201).json({ success: true, widgetId: parsed.widget.id });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: ERROR_CODES.CONFLICT, error: '图表已存在' });
    }
    console.error('[dashboard-widgets] 固化失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '看板图表固化失败' });
  }
});

// PUT /api/dashboard-widgets/order —— 批量排序（需在 /:widgetId 之前注册）
router.put('/order', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || !x)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '排序参数格式不正确' });
  }
  try {
    const pool = getPool();
    for (let i = 0; i < ids.length; i++) {
      await pool.query('UPDATE dashboard_widgets SET sort_order = ? WHERE widget_id = ?', [i, ids[i]]);
    }
    writeAudit({ userId: user.id, username: user.username, endpoint: 'dashboard_widget', status: 'SUCCESS', detail: `调整看板图表排序（${ids.length} 项）` });
    res.json({ success: true });
  } catch (err) {
    console.error('[dashboard-widgets] 排序失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '看板图表排序失败' });
  }
});

// PUT /api/dashboard-widgets/:widgetId —— 整体替换（标题/布局调整、v0.4.8 自动重放快照更新）
router.put('/:widgetId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const widgetId = String(req.params.widgetId || '');
  const parsed = normalizeDashboardWidgetPayload(req.body?.widget ?? req.body);
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  if (parsed.widget.id !== widgetId) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '路径与图表标识不一致' });
  }
  try {
    const pool = getPool();
    const [result] = await pool.query<mysql.ResultSetHeader>(
      'UPDATE dashboard_widgets SET widget_data = ? WHERE widget_id = ?',
      [JSON.stringify(parsed.widget), widgetId],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '图表不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[dashboard-widgets] 更新失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '看板图表更新失败' });
  }
});

// DELETE /api/dashboard-widgets/:widgetId —— 本人或 ADMIN（出厂内置 user_id=0 仅 ADMIN 可删）
router.delete('/:widgetId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const widgetId = String(req.params.widgetId || '');
  try {
    const pool = getPool();
    const [rows] = await pool.query<DashboardWidgetRow[]>(
      'SELECT widget_id, user_id, username, widget_data FROM dashboard_widgets WHERE widget_id = ?',
      [widgetId],
    );
    const row = rows[0];
    if (!row || (row.user_id !== user.id && user.role !== 'ADMIN')) {
      if (row) {
        writeAudit({ userId: user.id, username: user.username, endpoint: 'dashboard_widget', status: 'DENIED_AUTH', detail: `越权删除看板图表 ${widgetId}` });
      }
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '图表不存在' });
    }
    await pool.query('DELETE FROM dashboard_widgets WHERE widget_id = ?', [widgetId]);
    writeAudit({ userId: user.id, username: user.username, endpoint: 'dashboard_widget', status: 'SUCCESS', detail: `移除看板图表 ${widgetId}` });
    res.json({ success: true });
  } catch (err) {
    console.error('[dashboard-widgets] 删除失败:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '看板图表删除失败' });
  }
});

export default router;
