/**
 * P1-1 语义指标层管理路由。
 * 读取对所有登录用户开放。
 * P1-8 指标层治理：分析师可提议（PENDING）；创建直接生效 / 审批 / 驳回 / 编辑 / 删除 / 版本回溯仅 ADMIN。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  listMetrics,
  createMetric,
  updateMetric,
  deleteMetric,
  sanitizeMetricInput,
  approveMetric,
  rejectMetric,
  reproposeMetric,
  listMetricVersions,
  restoreMetricVersion,
} from '../metrics';

const router = Router();
router.use(authMiddleware);

// GET /api/metrics?dataSourceId=xxx —— 列出某数据源的全部指标定义
router.get('/', async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    res.json({ metrics: await listMetrics(dataSourceId) });
  } catch (err: any) {
    res.status(500).json({ error: `查询指标失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics —— 新建指标。ADMIN 直接生效（ACTIVE）；分析师提交为提议（PENDING）待审批
router.post('/', async (req, res) => {
  const cleaned = sanitizeMetricInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  const user = (req as any).user || {};
  const username = String(user.username || 'unknown');
  const isAdmin = user.role === 'ADMIN';
  try {
    const r = await createMetric(cleaned.metric, username, { autoApprove: isAdmin });
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id, status: isAdmin ? 'ACTIVE' : 'PENDING' });
  } catch (err: any) {
    res.status(500).json({ error: `创建失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/metrics/:id（ADMIN）—— 更新指标（数据源归属不可变）
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  const cleaned = sanitizeMetricInput({ ...(req.body || {}), dataSourceId: 'placeholder' });
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const { dataSourceId: _ignored, ...rest } = cleaned.metric;
    const r = await updateMetric(id, rest, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `更新失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/approve（ADMIN）—— 审批通过：PENDING → ACTIVE
router.post('/:id/approve', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    const r = await approveMetric(id, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `审批失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/reject（ADMIN）—— 驳回：PENDING → REJECTED
router.post('/:id/reject', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    const r = await rejectMetric(id, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `驳回失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/repropose —— 被驳回指标重新提议：REJECTED → PENDING（提议人本人或 ADMIN）
router.post('/:id/repropose', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    const r = await reproposeMetric(id, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `重新提议失败：${err?.message || '未知错误'}` });
  }
});

// GET /api/metrics/:id/versions —— 版本历史（新→旧）
router.get('/:id/versions', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    res.json({ versions: await listMetricVersions(id) });
  } catch (err: any) {
    res.status(500).json({ error: `查询版本历史失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/restore（ADMIN）—— 回溯到指定版本 {version}
router.post('/:id/restore', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const version = Number(req.body?.version);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: '非法版本号' });
  try {
    const r = await restoreMetricVersion(id, version, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `回溯失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/metrics/:id（ADMIN）
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    if (!(await deleteMetric(id))) return res.status(404).json({ error: '指标不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

export default router;
