/**
 * P3-3 知识库漂移检测 API（仅 ADMIN）：
 * - GET    /api/ops/drift            漂移事件列表（OPEN 优先）+ 观察列总数
 * - POST   /api/ops/drift/scan       手动触发扫描（body.dataSourceId 可选；缺省扫全部数据库型数据源）
 * - POST   /api/ops/drift/watch      登记观察列 { dataSourceId, tableName, columnName }
 * - DELETE /api/ops/drift/watch      移除观察列 { dataSourceId, tableName, columnName }
 * - POST   /api/ops/drift/:id/ack    确认事件（OPEN → ACKED）
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  addWatch,
  ackDriftEvent,
  IDENT_RE,
  listDriftEvents,
  removeWatch,
  scanAllDataSources,
  scanDataSource,
} from '../driftDetector';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

router.get('/drift', async (_req, res) => {
  try {
    const { events, watched } = await listDriftEvents();
    return res.json({ success: true, events, watched });
  } catch (err: any) {
    console.error('[Drift] 列表失败:', err?.message || err);
    return res.status(500).json({ error: '漂移事件获取失败' });
  }
});

router.post('/drift/scan', async (req, res) => {
  const dataSourceId = typeof req.body?.dataSourceId === 'string' ? req.body.dataSourceId.trim() : '';
  try {
    if (dataSourceId) {
      const summary = await scanDataSource(dataSourceId);
      return res.json({ success: true, summaries: [summary] });
    }
    const summaries = await scanAllDataSources();
    return res.json({ success: true, summaries });
  } catch (err: any) {
    console.error('[Drift] 扫描失败:', err?.message || err);
    return res.status(500).json({ error: '漂移扫描失败' });
  }
});

router.post('/drift/watch', async (req, res) => {
  const { dataSourceId, tableName, columnName } = req.body || {};
  if (typeof dataSourceId !== 'string' || !dataSourceId.trim()) return res.status(400).json({ error: 'dataSourceId 必填' });
  if (typeof tableName !== 'string' || !IDENT_RE.test(tableName)) return res.status(400).json({ error: 'tableName 非法' });
  if (typeof columnName !== 'string' || !IDENT_RE.test(columnName)) return res.status(400).json({ error: 'columnName 非法' });
  try {
    await addWatch(dataSourceId.trim(), tableName, columnName);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || '登记失败' });
  }
});

router.delete('/drift/watch', async (req, res) => {
  const { dataSourceId, tableName, columnName } = req.body || {};
  if (typeof dataSourceId !== 'string' || typeof tableName !== 'string' || typeof columnName !== 'string') {
    return res.status(400).json({ error: 'dataSourceId/tableName/columnName 必填' });
  }
  const affected = await removeWatch(dataSourceId.trim(), tableName, columnName);
  if (affected === 0) return res.status(404).json({ error: '观察列不存在' });
  return res.json({ success: true });
});

router.post('/drift/:id/ack', async (req, res) => {
  const ok = await ackDriftEvent(String(req.params.id || ''));
  if (!ok) return res.status(404).json({ error: '事件不存在或已确认' });
  return res.json({ success: true });
});

export default router;
