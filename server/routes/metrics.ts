/**
 * P1-1 语义指标层管理路由。
 * 读取对所有登录用户开放；创建 / 编辑 / 删除仅 ADMIN（口径属权威配置）。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  listMetrics,
  createMetric,
  updateMetric,
  deleteMetric,
  sanitizeMetricInput,
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

// POST /api/metrics（ADMIN）—— 新建指标 {dataSourceId,name,aliases,description,expr,tableName,filters}
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const cleaned = sanitizeMetricInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  const username = String((req as any).user?.username || 'admin');
  try {
    const r = await createMetric(cleaned.metric, username);
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
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
    const r = await updateMetric(id, rest);
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `更新失败：${err?.message || '未知错误'}` });
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
