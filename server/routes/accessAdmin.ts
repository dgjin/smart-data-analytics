/**
 * v0.9.107 访问统计管理端路由（仅 ADMIN）：
 * GET /stats?days=7|30 返回对外计数器 + 近 N 天模块热度排行。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { accessStats } from '../access/counter';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

router.get('/stats', async (req, res) => {
  try {
    return res.json({ success: true, ...(await accessStats(req.query.days)) });
  } catch (err) {
    logger.error('[AccessAdmin] 访问统计查询失败:', getErrorMessage(err));
    return res.status(500).json({ error: '访问统计获取失败' });
  }
});

export default router;
