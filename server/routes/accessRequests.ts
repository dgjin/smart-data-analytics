/**
 * P2-11 权限申请审批流路由：
 * - POST   /api/access-requests          登录用户申请某数据源访问权（任何角色，含 VIEWER）
 * - GET    /api/access-requests/mine     我的申请列表
 * - GET    /api/access-requests          ADMIN 查看全部（?status=PENDING 过滤）
 * - POST   /api/access-requests/:id/approve  ADMIN 通过 → 自动并入数据源 acl_json.userIds
 * - POST   /api/access-requests/:id/reject   ADMIN 驳回（可附备注）
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { rateLimiter } from '../rateLimiter';
import { checkDataSourceAccess, grantUserAccess } from '../accessControl';

const router = Router();
router.use(authMiddleware);

function rowToRequest(row: any) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: row.username,
    department: row.department || '',
    dataSourceId: row.data_source_id,
    dataSourceName: row.ds_name || '',
    reason: row.reason,
    status: row.status,
    approver: row.approver || '',
    decideNote: row.decide_note || '',
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

// POST /api/access-requests { dataSourceId, reason }
router.post('/', rateLimiter, async (req, res) => {
  const user = req.user!;
  const dataSourceId = String(req.body?.dataSourceId || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!dataSourceId) return res.status(400).json({ error: 'dataSourceId 必填' });
  if (!reason) return res.status(400).json({ error: '请填写申请理由' });

  try {
    const [dsRows] = await getPool().query('SELECT id FROM data_sources WHERE id = ? LIMIT 1', [dataSourceId]);
    if (!(dsRows as any[])[0]) return res.status(404).json({ error: '数据源不存在' });

    if (await checkDataSourceAccess(user, dataSourceId)) {
      return res.status(409).json({ error: '你已拥有该数据源的访问权限' });
    }
    const [dup] = await getPool().query(
      "SELECT id FROM permission_requests WHERE user_id = ? AND data_source_id = ? AND status = 'PENDING' LIMIT 1",
      [user.id, dataSourceId]
    );
    if ((dup as any[])[0]) {
      return res.status(409).json({ error: '已有待审批的申请，请等待管理员处理' });
    }

    const [result] = await getPool().query(
      'INSERT INTO permission_requests (user_id, username, department, data_source_id, reason) VALUES (?, ?, ?, ?, ?)',
      [user.id, user.username, user.department || '', dataSourceId, reason]
    );
    return res.status(201).json({ success: true, id: Number((result as any).insertId) });
  } catch (err) {
    console.error('[AccessRequests] create failed:', err);
    return res.status(500).json({ error: '申请提交失败' });
  }
});

// GET /api/access-requests/mine
router.get('/mine', async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT r.*, d.name AS ds_name FROM permission_requests r
       LEFT JOIN data_sources d ON d.id = r.data_source_id
       WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 100`,
      [req.user!.id]
    );
    return res.json({ success: true, requests: (rows as any[]).map(rowToRequest) });
  } catch (err) {
    console.error('[AccessRequests] mine failed:', err);
    return res.status(500).json({ error: '申请列表获取失败' });
  }
});

// GET /api/access-requests?status=PENDING（ADMIN）
router.get('/', requireRole('ADMIN'), async (req, res) => {
  const status = String(req.query.status || '').toUpperCase();
  const where = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? 'WHERE r.status = ?' : '';
  const params = where ? [status] : [];
  try {
    const [rows] = await getPool().query(
      `SELECT r.*, d.name AS ds_name FROM permission_requests r
       LEFT JOIN data_sources d ON d.id = r.data_source_id
       ${where} ORDER BY r.status = 'PENDING' DESC, r.id DESC LIMIT 500`,
      params
    );
    return res.json({ success: true, requests: (rows as any[]).map(rowToRequest) });
  } catch (err) {
    console.error('[AccessRequests] list failed:', err);
    return res.status(500).json({ error: '审批列表获取失败' });
  }
});

// 审批共用：加载 PENDING 申请 → 执行决策 → 留痕
async function decide(req: any, res: any, action: 'APPROVED' | 'REJECTED') {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '申请 ID 无效' });
  const note = String(req.body?.note || '').trim().slice(0, 300);

  try {
    const [rows] = await getPool().query('SELECT * FROM permission_requests WHERE id = ? LIMIT 1', [id]);
    const request = (rows as any[])[0];
    if (!request) return res.status(404).json({ error: '申请不存在' });
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: `该申请已被 ${request.approver || '其他管理员'} 处理（${request.status}）` });
    }

    if (action === 'APPROVED') {
      await grantUserAccess(String(request.data_source_id), Number(request.user_id));
    }
    await getPool().query(
      'UPDATE permission_requests SET status = ?, approver = ?, decide_note = ?, decided_at = NOW() WHERE id = ?',
      [action, req.user!.username, note, id]
    );
    return res.json({ success: true });
  } catch (err: any) {
    console.error(`[AccessRequests] ${action} failed:`, err);
    return res.status(500).json({ error: err?.message === '数据源不存在' ? '数据源已被删除，无法授权' : '审批操作失败' });
  }
}

// POST /api/access-requests/:id/approve（ADMIN）
router.post('/:id/approve', requireRole('ADMIN'), (req, res) => decide(req, res, 'APPROVED'));

// POST /api/access-requests/:id/reject（ADMIN）{ note? }
router.post('/:id/reject', requireRole('ADMIN'), (req, res) => decide(req, res, 'REJECTED'));

export default router;
