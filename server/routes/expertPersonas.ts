/**
 * 问数专家角色管理路由（v0.9.40）。
 * 全部端点仅 ADMIN：角色配置决定阶段二解读的专家视角（标签/触发关键词/rolePrompt），
 * 修改即时生效（缓存即时失效）；内置角色可编辑不可删除，default 兜底角色不可禁用。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import {
  listPersonas,
  createPersona,
  updatePersona,
  deletePersona,
  sanitizePersonaInput,
} from '../llm/expertPersona';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

// GET /api/expert-personas —— 全部角色列表（含禁用，按匹配优先级排序）
router.get('/', async (_req, res) => {
  try {
    res.json({ personas: await listPersonas() });
  } catch (err: any) {
    res.status(500).json({ error: `查询专家角色失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/expert-personas —— 新建自定义角色（创建即生效）
router.post('/', async (req, res) => {
  const cleaned = sanitizePersonaInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await createPersona(cleaned.persona, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err: any) {
    res.status(500).json({ error: `创建失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/expert-personas/:id —— 更新角色（default 仅可改标签与 rolePrompt）
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法角色 ID' });
  const cleaned = sanitizePersonaInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await updatePersona(id, cleaned.persona);
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `更新失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/expert-personas/:id —— 删除自定义角色（内置角色拒绝）
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法角色 ID' });
  try {
    const r = await deletePersona(id);
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

export default router;
