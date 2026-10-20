/**
 * v0.9.107 评价提交路由：
 * - POST /query  问数回答星级评价（ADMIN/ANALYST，与问数能力一致）；
 * - POST /app    全站满意度（所有登录用户，24h 内重复提交更新最近一条）；
 * - GET  /mine   当前用户最近一次全站满意度（Header 入口回显）；
 * - GET  /public-stats  侧边栏评分统计（登录可见，仅全量均分与条数）。
 * 评价独立于 query_feedback，不参与 few-shot 与统一记忆体。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import {
  MAX_COMMENT_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  latestAppSatisfaction,
  normalizeComment,
  normalizeRating,
  normalizeTags,
  publicRatingStats,
  saveAppSatisfaction,
  saveQueryRating,
} from '../feedback/ratings';
import { rateLimiter } from '../infra/rateLimiter';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();
router.use(authMiddleware);

router.post('/query', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const { dataSourceId, question, sql, traceId, rating, tags, comment } = req.body || {};
  const score = normalizeRating(rating);
  if (score === null) return res.status(400).json({ error: '评分需为 1-5 星' });

  const normalizedTags = normalizeTags(tags);
  if (normalizedTags === null) {
    return res.status(400).json({ error: `标签最多 ${MAX_TAGS} 个，每个不超过 ${MAX_TAG_LENGTH} 字` });
  }
  const normalizedComment = normalizeComment(comment);
  if (normalizedComment === null) {
    return res.status(400).json({ error: `评价内容不能超过 ${MAX_COMMENT_LENGTH} 字` });
  }
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: '缺少问题内容' });
  }

  try {
    await saveQueryRating({
      userId: req.user!.id,
      username: req.user!.username,
      dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
      question: question.trim(),
      executedSql: typeof sql === 'string' ? sql : '',
      traceId: typeof traceId === 'string' ? traceId : '',
      rating: score,
      tags: normalizedTags,
      comment: normalizedComment,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Rating] 问数评价保存失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评价保存失败' });
  }
});

router.post('/app', rateLimiter, async (req, res) => {
  const { page, rating, tags, comment } = req.body || {};
  const score = normalizeRating(rating);
  if (score === null) return res.status(400).json({ error: '评分需为 1-5 星' });

  const normalizedTags = normalizeTags(tags);
  if (normalizedTags === null) {
    return res.status(400).json({ error: `标签最多 ${MAX_TAGS} 个，每个不超过 ${MAX_TAG_LENGTH} 字` });
  }
  const normalizedComment = normalizeComment(comment);
  if (normalizedComment === null) {
    return res.status(400).json({ error: `评价内容不能超过 ${MAX_COMMENT_LENGTH} 字` });
  }

  try {
    await saveAppSatisfaction({
      userId: req.user!.id,
      username: req.user!.username,
      page: typeof page === 'string' ? page : '',
      rating: score,
      tags: normalizedTags,
      comment: normalizedComment,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Rating] 全站满意度保存失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评价保存失败' });
  }
});

router.get('/mine', async (req, res) => {
  try {
    return res.json({ success: true, rating: await latestAppSatisfaction(req.user!.id) });
  } catch (err) {
    logger.warn('[Rating] 最近评价查询失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评价查询失败' });
  }
});

router.get('/public-stats', rateLimiter, async (_req, res) => {
  try {
    return res.json({ success: true, ...(await publicRatingStats()) });
  } catch (err) {
    logger.warn('[Rating] 评分统计查询失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评分统计查询失败' });
  }
});

export default router;
