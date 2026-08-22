/**
 * P2-12 DLP 数据防泄漏：统一 CSV 导出通道。
 *
 * - 水印：文件首行/尾行嵌入导出人、部门、时间、行数（泄漏可溯源）
 * - 下载审批：行数超过 DLP_EXPORT_APPROVE_ROWS（默认 5000）且非 ADMIN → 生成
 *   download_requests 审批单（202 approvalRequired）；ADMIN 通过后 24h 内可导出一次
 *   （导出成功即转 CONSUMED，一次性授权）
 * - 审计：所有导出/拦截均落 query_audit_log（endpoint='export'）
 */
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { authMiddleware, requireRole } from '../auth';
import { rateLimiter } from '../rateLimiter';
import { getPool } from '../db';
import { writeAudit } from '../auditLog';
import { ERROR_CODES } from '../errorCodes';

const router = Router();
router.use(authMiddleware);

/** 审批阈值：超过该行数的导出需 ADMIN 审批（ADMIN 豁免） */
export function exportApproveRows(): number {
  const n = Number(process.env.DLP_EXPORT_APPROVE_ROWS || 5000);
  return Number.isInteger(n) && n > 0 ? n : 5000;
}

/** 硬上限：防止超大导出撑爆内存 */
export function exportMaxRows(): number {
  const n = Number(process.env.DLP_EXPORT_MAX_ROWS || 100000);
  return Number.isInteger(n) && n > 0 ? n : 100000;
}

/** CSV 单元格转义（含逗号/引号/换行/回车时双引号包裹，内部引号双写） */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 生成带水印的 CSV 全文（BOM + 水印首行 + 表头 + 数据 + 水印尾行） */
export function buildCsvWithWatermark(opts: {
  title: string;
  columns: string[];
  rows: unknown[][];
  username: string;
  department: string;
  exportedAt: Date;
}): string {
  const ts = opts.exportedAt.toLocaleString('zh-CN', { hour12: false });
  const who = `${opts.username}${opts.department ? `（${opts.department}）` : ''}`;
  const head = `# 智能问数系统数据导出 | 导出人: ${who} | 导出时间: ${ts} | 数据行数: ${opts.rows.length} | 本文件含访问水印，严禁外传`;
  const tail = `# 导出水印 | ${who} | ${ts} | 如发现数据泄露请联系数据安全管理员溯源`;
  const header = opts.columns.map(csvCell).join(',');
  const body = opts.rows.map((r) => r.map(csvCell).join(','));
  return '﻿' + [head, header, ...body, tail].join('\r\n');
}

interface DownloadReqRow extends RowDataPacket {
  id: number;
  user_id: number;
  username: string;
  department: string;
  data_source_id: string;
  title: string;
  row_count: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED';
  approver: string;
  decide_note: string;
  decided_at: string | null;
  created_at: string | null;
}

function rowToRequest(r: DownloadReqRow, dsName?: string) {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    department: r.department,
    dataSourceId: r.data_source_id,
    dataSourceName: dsName || '',
    title: r.title,
    rowCount: r.row_count,
    status: r.status,
    approver: r.approver,
    decideNote: r.decide_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

// POST /api/export/csv —— 统一 CSV 导出（水印 + 阈值审批）
router.post('/csv', rateLimiter, async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { title, columns, rows, dataSourceId } = req.body || {};
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'export' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  if (!Array.isArray(columns) || columns.length === 0 || !Array.isArray(rows)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'columns 与 rows 必填' });
  }
  if (columns.length > 200 || rows.some((r) => !Array.isArray(r) || r.length !== columns.length)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'columns/rows 形状不合法（列数需一致且 ≤200）' });
  }
  if (rows.length > exportMaxRows()) {
    writeAudit({ ...auditBase, question: `export:${String(title || '').slice(0, 80)}`, status: 'DENIED_INPUT', detail: `导出行数 ${rows.length} 超硬上限 ${exportMaxRows()}`, rowCount: rows.length, durationMs: Date.now() - startedAt });
    return res.status(413).json({ code: ERROR_CODES.INVALID_INPUT, error: `导出行数超过上限（${exportMaxRows()} 行），请筛选后分批导出` });
  }

  const threshold = exportApproveRows();
  const needsApproval = rows.length > threshold && user.role !== 'ADMIN';
  if (needsApproval) {
    const pool = getPool();
    // 已有近 24h 内 APPROVED 的一次性授权 → 放行并消费
    const [approved] = await pool.query<any[]>(
      "SELECT id FROM download_requests WHERE user_id = ? AND data_source_id = ? AND status = 'APPROVED' AND decided_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY id DESC LIMIT 1",
      [user.id, auditBase.dataSourceId],
    );
    if (approved.length > 0) {
      await pool.query("UPDATE download_requests SET status = 'CONSUMED' WHERE id = ?", [approved[0].id]);
    } else {
      // 同用户同数据源已有 PENDING → 返回既有审批单（幂等，不重复建单）
      const [pending] = await pool.query<any[]>(
        "SELECT id FROM download_requests WHERE user_id = ? AND data_source_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1",
        [user.id, auditBase.dataSourceId],
      );
      let reqId: number;
      if (pending.length > 0) {
        reqId = pending[0].id;
      } else {
        const [r] = await pool.query<any>(
          'INSERT INTO download_requests (user_id, username, department, data_source_id, title, row_count) VALUES (?, ?, ?, ?, ?, ?)',
          [user.id, user.username, user.department || '', auditBase.dataSourceId, String(title || '').slice(0, 200), rows.length],
        );
        reqId = r.insertId;
      }
      writeAudit({ ...auditBase, question: `export:${String(title || '').slice(0, 80)}`, status: 'DENIED_AUTH', detail: `导出 ${rows.length} 行超审批阈值 ${threshold}，已生成下载审批单 #${reqId}`, rowCount: rows.length, durationMs: Date.now() - startedAt });
      return res.status(202).json({
        success: false,
        approvalRequired: true,
        requestId: reqId,
        error: `导出 ${rows.length} 行超过免审批阈值（${threshold} 行），已提交管理员审批，通过后可重新导出`,
      });
    }
  }

  const csv = buildCsvWithWatermark({
    title: String(title || 'export').slice(0, 200),
    columns: columns.map((c) => String(c).slice(0, 100)),
    rows,
    username: user.username,
    department: user.department || '',
    exportedAt: new Date(),
  });
  writeAudit({ ...auditBase, question: `export:${String(title || '').slice(0, 80)}`, status: 'SUCCESS', detail: `CSV 导出 ${rows.length} 行（含水印）`, rowCount: rows.length, durationMs: Date.now() - startedAt });

  const fname = encodeURIComponent(`${String(title || 'export').slice(0, 60)}_${Date.now()}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
  return res.send(csv);
});

// GET /api/export/requests/mine —— 我的下载申请
router.get('/requests/mine', async (req, res) => {
  const pool = getPool();
  const [rows] = await pool.query<DownloadReqRow[]>(
    'SELECT * FROM download_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50',
    [req.user!.id],
  );
  return res.json({ success: true, requests: rows.map((r) => rowToRequest(r)) });
});

// GET /api/export/requests —— ADMIN 审批列表
router.get('/requests', requireRole('ADMIN'), async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const pool = getPool();
  const where = ['PENDING', 'APPROVED', 'REJECTED', 'CONSUMED'].includes(status) ? 'WHERE r.status = ?' : '';
  const args: any[] = where ? [status] : [];
  const [rows] = await pool.query<any[]>(
    `SELECT r.*, d.name AS ds_name FROM download_requests r
     LEFT JOIN data_sources d ON d.id = r.data_source_id
     ${where} ORDER BY (r.status = 'PENDING') DESC, r.id DESC LIMIT 200`,
    args,
  );
  return res.json({ success: true, requests: rows.map((r: any) => rowToRequest(r, r.ds_name)) });
});

// 审批共用：加载 PENDING → 置终态
async function decide(id: number, action: 'approve' | 'reject', approver: string, note: string) {
  const pool = getPool();
  const [rows] = await pool.query<DownloadReqRow[]>('SELECT * FROM download_requests WHERE id = ? LIMIT 1', [id]);
  if (rows.length === 0) return { ok: false as const, status: 404, error: '审批单不存在' };
  if (rows[0].status !== 'PENDING') return { ok: false as const, status: 409, error: `该申请已处理（${rows[0].status}）` };
  await pool.query(
    'UPDATE download_requests SET status = ?, approver = ?, decide_note = ?, decided_at = NOW() WHERE id = ?',
    [action === 'approve' ? 'APPROVED' : 'REJECTED', approver, note, id],
  );
  return { ok: true as const, row: rows[0] };
}

router.post('/requests/:id/approve', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'id 不合法' });
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : '';
  const out = await decide(id, 'approve', req.user!.username, note);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  writeAudit({ userId: req.user!.id, username: req.user!.username, endpoint: 'export', dataSourceId: out.row.data_source_id, question: `export-approve:#${id}`, status: 'SUCCESS', detail: `通过 ${out.row.username} 的导出审批（${out.row.row_count} 行）`, rowCount: out.row.row_count });
  return res.json({ success: true });
});

router.post('/requests/:id/reject', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'id 不合法' });
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : '';
  const out = await decide(id, 'reject', req.user!.username, note);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  writeAudit({ userId: req.user!.id, username: req.user!.username, endpoint: 'export', dataSourceId: out.row.data_source_id, question: `export-reject:#${id}`, status: 'SUCCESS', detail: `驳回 ${out.row.username} 的导出审批（${out.row.row_count} 行）`, rowCount: out.row.row_count });
  return res.json({ success: true });
});

export default router;
