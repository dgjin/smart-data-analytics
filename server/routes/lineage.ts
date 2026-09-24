/**
 * 数据血缘路由（P0 血缘管理优化）。
 * GET /api/lineage/graph：聚合数据源 / 报表 / 图表 / 指标构建全量血缘图（节点 + 边 + 统计）。
 * 只读端点：仅 ADMIN（与血缘视图入口的可见性保持一致）。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { getLineageGraph } from '../lineage/service';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

// GET /api/lineage/graph —— 全量血缘图（30s 服务端缓存；失败由前端降级本地估算）
router.get('/graph', async (_req, res) => {
  try {
    const graph = await getLineageGraph();
    res.json({ success: true, ...graph });
  } catch (err) {
    logger.error(`[Lineage] 血缘图构建失败: ${getErrorMessage(err)}`);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '血缘图构建失败' });
  }
});

export default router;
