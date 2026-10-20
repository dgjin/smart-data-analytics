/**
 * v0.9.107 访问计数路由（匿名可调）：
 * - POST /visit       记录一次访问（新会话才计累计/今日）+ 模块热度；
 * - POST /ping        在线心跳（最近 5 分钟活跃会话数）；
 * - GET  /public-stats 对外展示的累计/今日/在线计数。
 * 仅落聚合计数，不采集 IP、User-Agent 或访问明细。
 */
import { Router } from 'express';
import { optionalAuthMiddleware } from '../auth/auth';
import { isValidSessionId, normalizeModule, publicStats, recordVisit, touchSession } from '../access/counter';
import { rateLimiter } from '../infra/rateLimiter';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();

// 访问上报：登录/未登录均可；登录态仅用于标记会话（不记录用户访问明细）
router.post('/visit', optionalAuthMiddleware, async (req, res) => {
  const { sessionId, module } = req.body || {};
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId 格式不正确' });
  }
  await recordVisit(sessionId, normalizeModule(module), req.user?.id);
  return res.json({ success: true });
});

// 在线心跳：仅刷新会话活跃时间
router.post('/ping', optionalAuthMiddleware, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId 格式不正确' });
  }
  await touchSession(sessionId, req.user?.id);
  return res.json({ success: true });
});

// 对外计数器：公开接口，按 IP 限流（默认 30 次/分钟）
router.get('/public-stats', rateLimiter, async (_req, res) => {
  try {
    return res.json({ success: true, ...(await publicStats()) });
  } catch (err) {
    logger.warn('[Access] 公开计数查询失败:', getErrorMessage(err));
    return res.status(500).json({ error: '访问统计获取失败' });
  }
});

export default router;
