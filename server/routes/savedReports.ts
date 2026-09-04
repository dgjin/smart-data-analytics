/**
 * v0.9.23 可视化决策报表服务端持久化路由（挂载于 /api/saved-reports 前缀下）：
 * 历史报表由浏览器 localStorage（zustand persist）迁至 MySQL saved_reports 表，跨设备/清理缓存不丢失。
 * - GET    /                    报表列表（所有登录用户可见，可按数据源过滤；决策报表为团队共享简报）
 * - POST   /                    保存新报表（ADMIN/ANALYST；report_id 冲突返回 409，支撑前端存量迁移幂等重试）
 * - PUT    /:reportId           整体替换报表（重新生成场景；ADMIN/ANALYST 且仅本人或 ADMIN）
 * - PUT    /:reportId/comments  仅更新批注字段（所有登录用户可协同批注）
 * - DELETE /:reportId           删除报表（仅本人或 ADMIN；越权统一 404 防探测）
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { writeAudit } from '../auditLog';
import { ERROR_CODES } from '../errorCodes';

const router = Router();

export interface SavedReportRow {
  id: number;
  report_id: string;
  user_id: number;
  username: string;
  data_source_id: string;
  template_type: string;
  data_provenance: string;
  report_data: string;
  created_at: Date;
  updated_at: Date;
}

/** 前端提交的 SavedReport 最小结构（完整字段存 report_data，服务端只校验关键字段） */
export interface SavedReportPayload {
  id: string;
  title: string;
  dataSourceId: string;
  templateType?: string;
  dataProvenance?: 'live' | 'simulated';
  genParams?: { templateType?: string };
  [key: string]: unknown;
}

/** 入站校验与归一：合法返回 ok+report，否则 ok=false+错误信息（纯函数，独立单测） */
export function normalizeSavedReportPayload(raw: unknown):
  | { ok: true; report: SavedReportPayload }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '报表数据格式不正确' };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id || id.length > 64) return { ok: false, error: '报表 ID 缺失或超长' };
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!title) return { ok: false, error: '报表标题不能为空' };
  const dataSourceId = typeof r.dataSourceId === 'string' ? r.dataSourceId : '';
  return {
    ok: true,
    report: {
      ...(r as object),
      id,
      title: title.slice(0, 500),
      dataSourceId,
      dataProvenance: r.dataProvenance === 'simulated' ? 'simulated' : 'live',
    } as SavedReportPayload,
  };
}

/** 快照字段提取：报表主题取 genParams.templateType 优先（v0.9.22 起为完整条件快照），回退平铺 templateType */
export function extractTemplateType(report: SavedReportPayload): string {
  const snap = report.genParams?.templateType;
  if (typeof snap === 'string' && snap.trim()) return snap.trim().slice(0, 200);
  if (typeof report.templateType === 'string' && report.templateType.trim()) return report.templateType.trim().slice(0, 200);
  return '';
}

/** 行 → API 记录（report 为解析后的完整 SavedReport，createdAt/updatedAt 为服务端时间戳） */
export function toSavedReportRecord(row: SavedReportRow) {
  return {
    reportId: row.report_id,
    userId: row.user_id,
    username: row.username,
    dataSourceId: row.data_source_id,
    templateType: row.template_type,
    dataProvenance: row.data_provenance,
    report: JSON.parse(row.report_data),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// GET /api/saved-reports - 报表列表（所有登录用户可见，可选 ?dataSourceId= 过滤）
router.get('/', authMiddleware, async (req, res) => {
  const { dataSourceId } = req.query;
  try {
    const pool = getPool();
    const hasFilter = typeof dataSourceId === 'string' && dataSourceId.length > 0;
    const [rows] = hasFilter
      ? await pool.query('SELECT * FROM saved_reports WHERE data_source_id = ? ORDER BY created_at DESC', [dataSourceId])
      : await pool.query('SELECT * FROM saved_reports ORDER BY created_at DESC');
    const reports = (rows as SavedReportRow[]).map(toSavedReportRecord);
    res.json({ ok: true, reports });
  } catch (err: any) {
    console.error('GET /api/saved-reports error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '获取历史报表列表失败' });
  }
});

// POST /api/saved-reports - 保存新报表（ADMIN/ANALYST；report_id 冲突 409 供存量迁移幂等）
router.post('/', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const normalized = normalizeSavedReportPayload(req.body?.report);
  if (normalized.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: normalized.error });
  }
  const report = normalized.report;

  try {
    const pool = getPool();
    await pool.query(
      'INSERT INTO saved_reports (report_id, user_id, username, data_source_id, template_type, data_provenance, report_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [report.id, user.id, user.username, report.dataSourceId, extractTemplateType(report), report.dataProvenance, JSON.stringify(report)]
    );
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'saved_report',
      dataSourceId: report.dataSourceId,
      status: 'SUCCESS',
      detail: `保存决策报表：${report.id}`,
    });
    res.json({ ok: true, reportId: report.id });
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      // 幂等：本地存量迁移或多端重复提交时视为已保存
      return res.status(409).json({ code: ERROR_CODES.CONFLICT, error: '报表已存在', reportId: report.id });
    }
    console.error('POST /api/saved-reports error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '保存报表失败' });
  }
});

// PUT /api/saved-reports/:reportId - 整体替换报表（重新生成场景；ADMIN/ANALYST 且仅本人或 ADMIN）
router.put('/:reportId', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const { reportId } = req.params;
  const normalized = normalizeSavedReportPayload(req.body?.report);
  if (normalized.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: normalized.error });
  }
  const report = normalized.report;
  if (report.id !== reportId) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报表 ID 不一致' });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT user_id FROM saved_reports WHERE report_id = ?', [reportId]);
    const existing = (rows as { user_id: number }[])[0];
    if (!existing) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报表不存在' });
    }
    // 权限检查：仅本人或 ADMIN 可替换（越权统一 404 防探测）
    if (existing.user_id !== user.id && user.role !== 'ADMIN') {
      writeAudit({
        userId: user.id,
        username: user.username,
        endpoint: 'saved_report',
        status: 'DENIED_AUTH',
        detail: `尝试替换他人报表：${reportId}`,
      });
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报表不存在' });
    }

    await pool.query(
      'UPDATE saved_reports SET template_type = ?, data_provenance = ?, report_data = ? WHERE report_id = ?',
      [extractTemplateType(report), report.dataProvenance, JSON.stringify(report), reportId]
    );
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'saved_report',
      dataSourceId: report.dataSourceId,
      status: 'SUCCESS',
      detail: `重新生成替换报表：${reportId}`,
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.error('PUT /api/saved-reports/:reportId error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '更新报表失败' });
  }
});

// PUT /api/saved-reports/:reportId/comments - 仅更新批注字段（所有登录用户可协同批注）
router.put('/:reportId/comments', authMiddleware, async (req, res) => {
  const user = req.user!;
  const { reportId } = req.params;
  const comments = req.body?.comments;
  if (!Array.isArray(comments)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '批注数据格式不正确' });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT report_data FROM saved_reports WHERE report_id = ?', [reportId]);
    const existing = (rows as { report_data: string }[])[0];
    if (!existing) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报表不存在' });
    }
    // 读出-替换 comments-整体写回（批注并发极低，且规避 MySQL 对 TEXT 列 JSON_MODIFY 的兼容性问题）
    const parsed = JSON.parse(existing.report_data);
    parsed.comments = comments;
    await pool.query('UPDATE saved_reports SET report_data = ? WHERE report_id = ?', [JSON.stringify(parsed), reportId]);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('PUT /api/saved-reports/:reportId/comments error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '保存批注失败' });
  }
});

// DELETE /api/saved-reports/:reportId - 删除报表（仅本人或 ADMIN；越权统一 404 防探测）
router.delete('/:reportId', authMiddleware, async (req, res) => {
  const user = req.user!;
  const { reportId } = req.params;

  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT user_id FROM saved_reports WHERE report_id = ?', [reportId]);
    const report = (rows as { user_id: number }[])[0];
    if (!report) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报表不存在' });
    }
    if (report.user_id !== user.id && user.role !== 'ADMIN') {
      writeAudit({
        userId: user.id,
        username: user.username,
        endpoint: 'saved_report',
        status: 'DENIED_AUTH',
        detail: `尝试删除他人报表：${reportId}`,
      });
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报表不存在' });
    }

    await pool.query('DELETE FROM saved_reports WHERE report_id = ?', [reportId]);
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'saved_report',
      status: 'SUCCESS',
      detail: `删除决策报表：${reportId}`,
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.error('DELETE /api/saved-reports/:reportId error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '删除报表失败' });
  }
});

export default router;
