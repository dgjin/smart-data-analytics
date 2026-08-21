/**
 * v0.5.0 智能问数报告中心路由（挂载于 /api/query-reports 前缀下）：
 * - GET    /           获取当前用户报告列表（按数据源过滤）
 * - GET    /:reportId  获取单条报告详情（仅本人或 ADMIN）
 * - DELETE /:reportId  删除报告（仅本人或 ADMIN）
 */
import { Router } from 'express';
import { authMiddleware } from '../auth';
import { getPool } from '../db';
import { writeAudit } from '../auditLog';
import { ERROR_CODES } from '../errorCodes';

const router = Router();

// 报告记录类型
export interface QueryReportRow {
  id: number;
  report_id: string;
  user_id: number;
  username: string;
  data_source_id: string;
  question: string;
  template_id: number | null;
  template_name: string;
  report_data: string;
  created_at: Date;
}

// 转换为前端格式
export function toQueryReportRecord(row: QueryReportRow) {
  return {
    id: row.id,
    reportId: row.report_id,
    userId: row.user_id,
    username: row.username,
    dataSourceId: row.data_source_id,
    question: row.question,
    templateId: row.template_id,
    templateName: row.template_name,
    reportData: JSON.parse(row.report_data),
    createdAt: row.created_at.toISOString(),
  };
}

// GET /api/query-reports - 获取当前用户报告列表
router.get('/', authMiddleware, async (req, res) => {
  const user = req.user!;
  const { dataSourceId } = req.query;

  if (!dataSourceId || typeof dataSourceId !== 'string') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少数据源 ID' });
  }

  try {
    const pool = getPool();
    // ADMIN 可查看所有报告，其他角色仅查看本人报告
    const isAdmin = user.role === 'ADMIN';
    const sql = isAdmin
      ? 'SELECT * FROM query_reports WHERE data_source_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM query_reports WHERE data_source_id = ? AND user_id = ? ORDER BY created_at DESC';
    const params = isAdmin ? [dataSourceId] : [dataSourceId, user.id];

    const [rows] = await pool.query(sql, params);
    const reports = (rows as QueryReportRow[]).map(toQueryReportRecord);
    res.json({ ok: true, reports });
  } catch (err: any) {
    console.error('GET /api/query-reports error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '获取报告列表失败' });
  }
});

// GET /api/query-reports/:reportId - 获取单条报告详情
router.get('/:reportId', authMiddleware, async (req, res) => {
  const user = req.user!;
  const { reportId } = req.params;

  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM query_reports WHERE report_id = ?', [reportId]);
    const report = (rows as QueryReportRow[])[0];

    if (!report) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报告不存在' });
    }

    // 权限检查：仅本人或 ADMIN 可查看
    if (report.user_id !== user.id && user.role !== 'ADMIN') {
      writeAudit({
        userId: user.id,
        username: user.username,
        endpoint: 'query_report',
        status: 'DENIED_AUTH',
        detail: `尝试访问他人报告：${reportId}`,
      });
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报告不存在' });
    }

    res.json({ ok: true, report: toQueryReportRecord(report) });
  } catch (err: any) {
    console.error('GET /api/query-reports/:reportId error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '获取报告详情失败' });
  }
});

// DELETE /api/query-reports/:reportId - 删除报告
router.delete('/:reportId', authMiddleware, async (req, res) => {
  const user = req.user!;
  const { reportId } = req.params;

  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM query_reports WHERE report_id = ?', [reportId]);
    const report = (rows as QueryReportRow[])[0];

    if (!report) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报告不存在' });
    }

    // 权限检查：仅本人或 ADMIN 可删除
    if (report.user_id !== user.id && user.role !== 'ADMIN') {
      writeAudit({
        userId: user.id,
        username: user.username,
        endpoint: 'query_report',
        status: 'DENIED_AUTH',
        detail: `尝试删除他人报告：${reportId}`,
      });
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '报告不存在' });
    }

    await pool.query('DELETE FROM query_reports WHERE report_id = ?', [reportId]);

    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'query_report',
      status: 'SUCCESS',
      detail: `删除报告：${reportId}`,
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('DELETE /api/query-reports/:reportId error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '删除报告失败' });
  }
});

export default router;
