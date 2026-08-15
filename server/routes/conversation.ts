/**
 * P1-4 对话历史路由（从 server.ts 拆出，挂载于 /api/conversations 前缀下）：
 * - GET    /           检索本人在当前数据源的问数对话（关键词匹配问题/结论摘要）
 * - DELETE /:id        删除单条对话（仅限本人记录，越权删除返回 404）
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { rateLimiter } from '../rateLimiter';
import { searchConversations, deleteConversation } from '../conversationHistory';

const router = Router();

// 3b-1. 对话历史管理：检索本人在当前数据源的问数对话（关键词匹配问题/结论摘要）
router.get('/', authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : '';
  if (!dataSourceId) return res.status(400).json({ error: '缺少数据源' });
  const keyword = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const conversations = await searchConversations(req.user!.id, dataSourceId, keyword);
    return res.json({ success: true, conversations });
  } catch (err) {
    console.error('[Conversations] search failed:', err);
    return res.status(500).json({ error: '对话历史查询失败' });
  }
});

// 3b-2. 对话历史管理：删除单条对话（仅限本人记录，越权删除返回 404）
router.delete('/:id', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '对话记录 ID 无效' });
  try {
    const ok = await deleteConversation(id, req.user!.id);
    if (!ok) return res.status(404).json({ error: '对话记录不存在或无权删除' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Conversations] delete failed:', err);
    return res.status(500).json({ error: '对话记录删除失败' });
  }
});

export default router;
