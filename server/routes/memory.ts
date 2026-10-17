/**
 * 统一记忆体管理路由（一期，全部仅 ADMIN）。
 *
 * - 候选审核：点踩纠正候选的列表、通过（→ memory_items）、驳回；
 * - 记忆条目：列表、编辑内容/期望口径/置信度/状态；
 * - 观测：命中统计、单次问数（traceId）的记忆引用明细、当前开关与预算；
 * - 治理：手动触发归档。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';
import { callEmbedding } from '../llm/llmEmbedding';
import {
  MEMORY_BUDGETS,
  approveCandidate,
  archiveStaleMemories,
  getCandidate,
  isMemoryStatus,
  listCandidates,
  listItems,
  memoryArchiveDays,
  memoryAutoCandidateEnabled,
  memoryRolloutPct,
  memoryRouterMode,
  memoryStats,
  memoryTotalTokenBudget,
  normalizeErrorType,
  rejectCandidate,
  updateItem,
  usageByTrace,
} from '../memory';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// GET /api/admin/memory/config —— 当前开关、灰度与预算（前端页签顶部展示）
router.get('/config', (_req, res) => {
  res.json({
    mode: memoryRouterMode(),
    rolloutPct: memoryRolloutPct(),
    totalTokenBudget: memoryTotalTokenBudget(),
    budgets: MEMORY_BUDGETS,
    autoCandidate: memoryAutoCandidateEnabled(),
    archiveDays: memoryArchiveDays(),
  });
});

// GET /api/admin/memory/stats?dataSourceId=
router.get('/stats', async (req, res) => {
  try {
    const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : undefined;
    res.json(await memoryStats(dataSourceId));
  } catch (err) {
    logger.error('[Memory] stats failed:', err);
    res.status(500).json({ error: `记忆统计查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// GET /api/admin/memory/candidates?status=PENDING&dataSourceId=&errorType=&limit=&offset=
router.get('/candidates', async (req, res) => {
  try {
    const statusRaw = String(req.query.status || 'PENDING').toUpperCase();
    const status =
      statusRaw === 'APPROVED' || statusRaw === 'REJECTED' || statusRaw === 'MERGED' ? statusRaw : 'PENDING';
    const errorType = req.query.errorType ? normalizeErrorType(req.query.errorType) : undefined;
    const result = await listCandidates({
      status,
      dataSourceId: typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : undefined,
      errorType,
      limit: Number(req.query.limit) || 20,
      offset: Number(req.query.offset) || 0,
    });
    res.json(result);
  } catch (err) {
    logger.error('[Memory] list candidates failed:', err);
    res.status(500).json({ error: `候选查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/admin/memory/candidates/:id/approve —— 通过并生成纠错记忆
router.post('/candidates/:id/approve', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '候选 ID 无效' });
  const body = req.body || {};
  const patch: { content?: string; expectedSql?: string; confidence?: number; embeddingJson?: string } = {};
  if (typeof body.content === 'string' && body.content.trim()) patch.content = body.content.trim().slice(0, 4000);
  if (typeof body.expectedSql === 'string') patch.expectedSql = body.expectedSql.trim().slice(0, 2000);
  if (typeof body.confidence === 'number' && Number.isFinite(body.confidence)) {
    patch.confidence = Math.min(1, Math.max(0, body.confidence));
  }
  try {
    // 问题向量（best effort）：引擎不可用时退化为 bigram 召回
    try {
      const cand = await getCandidate(id);
      if (cand) {
        const vector = await callEmbedding(cand.question, 'query');
        if (Array.isArray(vector) && vector.length > 0) patch.embeddingJson = JSON.stringify(vector);
      }
    } catch {
      patch.embeddingJson = undefined;
    }
    const result = await approveCandidate(id, req.user!.username, patch);
    if (result.ok === false) return res.status(409).json({ error: result.error });
    res.json({ success: true, memoryId: result.memoryId });
  } catch (err) {
    logger.error('[Memory] approve candidate failed:', err);
    res.status(500).json({ error: `审核通过失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/admin/memory/candidates/:id/reject
router.post('/candidates/:id/reject', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '候选 ID 无效' });
  try {
    const ok = await rejectCandidate(id, req.user!.username);
    if (!ok) return res.status(409).json({ error: '候选不存在或已处理' });
    res.json({ success: true });
  } catch (err) {
    logger.error('[Memory] reject candidate failed:', err);
    res.status(500).json({ error: `驳回失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// GET /api/admin/memory/items?dataSourceId=&status=&q=&limit=&offset=
router.get('/items', async (req, res) => {
  try {
    const status = isMemoryStatus(req.query.status) ? req.query.status : undefined;
    const result = await listItems({
      dataSourceId: typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : undefined,
      status,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      limit: Number(req.query.limit) || 20,
      offset: Number(req.query.offset) || 0,
    });
    res.json(result);
  } catch (err) {
    logger.error('[Memory] list items failed:', err);
    res.status(500).json({ error: `记忆查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// PATCH /api/admin/memory/items/:id —— 编辑内容 / 期望口径 / 置信度 / 状态
router.patch('/items/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '记忆 ID 无效' });
  const body = req.body || {};
  const patch: { content?: string; expectedSql?: string; confidence?: number; status?: 'ACTIVE' | 'ARCHIVED' | 'DISABLED' } = {};
  if (typeof body.content === 'string') patch.content = body.content.slice(0, 4000);
  if (typeof body.expectedSql === 'string') patch.expectedSql = body.expectedSql.slice(0, 2000);
  if (typeof body.confidence === 'number' && Number.isFinite(body.confidence)) {
    patch.confidence = Math.min(1, Math.max(0, body.confidence));
  }
  if (isMemoryStatus(body.status)) patch.status = body.status;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  try {
    const ok = await updateItem(id, patch);
    if (!ok) return res.status(404).json({ error: '记忆不存在' });
    res.json({ success: true });
  } catch (err) {
    logger.error('[Memory] update item failed:', err);
    res.status(500).json({ error: `更新失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/admin/memory/archive —— 手动触发归档（长期未命中且低置信）
router.post('/archive', async (_req, res) => {
  try {
    res.json({ success: true, archived: await archiveStaleMemories(memoryArchiveDays()) });
  } catch (err) {
    logger.error('[Memory] archive failed:', err);
    res.status(500).json({ error: `归档失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// GET /api/admin/memory/usage/:traceId —— 某次问数的记忆引用明细（推导回放）
router.get('/usage/:traceId', async (req, res) => {
  const traceId = String(req.params.traceId || '').trim();
  if (!traceId) return res.status(400).json({ error: 'traceId 必填' });
  try {
    res.json({ rows: await usageByTrace(traceId) });
  } catch (err) {
    logger.error('[Memory] usage query failed:', err);
    res.status(500).json({ error: `引用明细查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

export default router;
