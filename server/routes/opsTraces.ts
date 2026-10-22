/**
 * P2-1 链路追踪查询 API（仅 ADMIN）：
 * - GET /api/ops/traces        最近链路摘要（耗时倒序，支持按最小耗时过滤与 limit）
 * - GET /api/ops/traces/:traceId  单链路 span 瀑布（按开始时间升序）
 *
 * 数据来源为进程内环形缓冲（server/infra/trace.ts），只保留最近 TRACE_BUFFER_SIZE 条；
 * 完整历史以结构化日志（JSONL 的 traceId 字段）为准。多实例部署时各实例只返回本实例链路。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { getTrace, listTraces } from '../infra/trace';

const router = Router();

router.use(authMiddleware, requireRole('ADMIN'));

/** 链路摘要列表：minDurationMs 用于「只看慢请求」，默认按开始时间倒序 */
router.get('/traces', (req, res) => {
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 50;
  const minRaw = Number(req.query.minDurationMs ?? 0);
  const minDurationMs = Number.isFinite(minRaw) ? Math.max(0, minRaw) : 0;
  const traces = listTraces(limit).filter((t) => t.durationMs >= minDurationMs);
  res.json({ total: traces.length, traces });
});

/** 单链路瀑布：span 已按开始时间排序，前端可直接渲染甘特图/缩进树 */
router.get('/traces/:traceId', (req, res) => {
  const traceId = String(req.params.traceId || '');
  if (!/^[0-9a-f]{32}$/i.test(traceId)) {
    res.status(400).json({ error: 'traceId 格式非法（需 32 位十六进制）' });
    return;
  }
  const trace = getTrace(traceId);
  if (!trace) {
    res.status(404).json({ error: '链路不存在或已超出缓冲窗口（默认保留最近 500 条）' });
    return;
  }
  res.json(trace);
});

export default router;
