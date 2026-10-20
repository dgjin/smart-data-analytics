/**
 * v0.9.107 评价中心管理端路由（仅 ADMIN）：
 * - GET /overview?days=30  问数/全站两套指标 + 按天趋势 + 标签 TOP；
 * - GET /items?...         评价明细分页（来源/评分区间/时间范围）；
 * - GET /export?...        评价明细 CSV（UTF-8 BOM，导出写审计）。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import {
  MAX_PAGE_SIZE,
  buildRatingsCsv,
  listRatings,
  ratingOverview,
  type RatingQuery,
} from '../feedback/ratings';
import { writeAudit } from '../infra/auditLog';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

type SourceFilter = 'all' | 'query' | 'app';

function sourceParam(value: unknown): SourceFilter {
  return value === 'query' || value === 'app' ? value : 'all';
}

/** 1-5 的整数评分；非法值按未筛选处理 */
function ratingParam(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

type QueryRequest = { query: Record<string, unknown> };

function queryFrom(req: QueryRequest): RatingQuery {
  const q = req.query;
  return {
    source: sourceParam(q.source),
    minRating: ratingParam(q.minRating),
    maxRating: ratingParam(q.maxRating),
    days: q.days === undefined ? undefined : Number(q.days),
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 20,
  };
}

router.get('/overview', async (req, res) => {
  try {
    return res.json({ success: true, ...(await ratingOverview(req.query.days)) });
  } catch (err) {
    logger.error('[RatingAdmin] 评价概览查询失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评价概览获取失败' });
  }
});

router.get('/items', async (req, res) => {
  try {
    const result = await listRatings(queryFrom(req));
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[RatingAdmin] 评价明细查询失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评价明细获取失败' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const result = await listRatings({ ...queryFrom(req), page: 1, pageSize: MAX_PAGE_SIZE });
    const csv = buildRatingsCsv(result.items);
    const date = new Date().toISOString().slice(0, 10);
    writeAudit({
      userId: req.user!.id,
      username: req.user!.username,
      endpoint: 'admin',
      status: 'SUCCESS',
      detail: `导出评价明细 ${result.items.length} 条`,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ratings-${date}.csv"`);
    return res.send(csv);
  } catch (err) {
    logger.error('[RatingAdmin] 评价导出失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评价导出失败' });
  }
});

export default router;
