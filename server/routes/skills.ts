/**
 * 技能库路由（P2-A Skills 增强）。
 * - GET /           问数面板可见技能（系统库 + 本人个人库的生效技能）
 * - GET /manage     管理视图：我的技能 + 系统库（管理员另附待审核分享列表）
 * - POST /          新建个人技能（所有登录用户）
 * - PUT/DELETE /:id 维护技能（个人技能仅本人；系统技能仅 ADMIN）
 * - 分享流：POST /:id/share（本人发起）、/:id/share/cancel（本人撤回）、
 *   /:id/share/approve 与 /:id/share/reject（ADMIN 审核）
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  listVisibleSkills,
  listManageSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  requestShare,
  cancelShare,
  approveShare,
  rejectShare,
  validateSkillInput,
} from '../skillLibrary';

const router = Router();
router.use(authMiddleware);

/** 技能 → 前端问数面板结构（保留 id/promptTemplate 等既有字段，附加库管理元信息） */
function toApi(sk: {
  skillId: string;
  name: string;
  description: string;
  promptTemplate: string;
  placeholders: string[];
  scope: 'USER' | 'SYSTEM';
  status: 'ACTIVE' | 'PENDING_SHARE';
  createdBy: string;
}) {
  return {
    id: sk.skillId,
    name: sk.name,
    description: sk.description,
    promptTemplate: sk.promptTemplate,
    placeholders: sk.placeholders,
    scope: sk.scope,
    status: sk.status,
    createdBy: sk.createdBy,
  };
}

// GET /api/skills —— 问数面板技能列表（系统库生效技能 + 本人个人库生效技能）
router.get('/', async (req, res) => {
  const skills = await listVisibleSkills(req.user!.username);
  res.json({ skills: skills.map(toApi) });
});

// GET /api/skills/manage —— 技能库管理视图
router.get('/manage', async (req, res) => {
  const user = req.user!;
  const { mySkills, systemSkills, pendingShares } = await listManageSkills(
    user.username,
    user.role === 'ADMIN'
  );
  res.json({
    mySkills: mySkills.map(toApi),
    systemSkills: systemSkills.map(toApi),
    pendingShares: pendingShares.map(toApi),
  });
});

// POST /api/skills —— 新建个人技能
router.post('/', async (req, res) => {
  const err = validateSkillInput(req.body);
  if (err) return res.status(400).json({ error: err });
  const skill = await createSkill(req.user!.username, {
    name: String(req.body.name),
    description: typeof req.body.description === 'string' ? req.body.description : '',
    promptTemplate: String(req.body.promptTemplate),
  });
  res.json({ skill: toApi(skill) });
});

// PUT /api/skills/:id —— 编辑技能（个人：本人；系统：ADMIN）
router.put('/:id', async (req, res) => {
  const err = validateSkillInput(req.body);
  if (err) return res.status(400).json({ error: err });
  const result = await updateSkill(
    req.user!.username,
    req.user!.role === 'ADMIN',
    String(req.params.id),
    {
      name: String(req.body.name),
      description: typeof req.body.description === 'string' ? req.body.description : '',
      promptTemplate: String(req.body.promptTemplate),
    }
  );
  if (result.ok === true) return res.json({ skill: toApi(result.skill) });
  return res.status(result.status).json({ error: result.error });
});

// DELETE /api/skills/:id —— 删除技能（权限同编辑）
router.delete('/:id', async (req, res) => {
  const result = await deleteSkill(req.user!.username, req.user!.role === 'ADMIN', String(req.params.id));
  if (result.ok === true) return res.json({ success: true });
  return res.status(result.status).json({ error: result.error });
});

// POST /api/skills/:id/share —— 本人发起分享至系统库申请
router.post('/:id/share', async (req, res) => {
  const result = await requestShare(req.user!.username, String(req.params.id));
  if (result.ok === true) return res.json({ success: true });
  return res.status(result.status).json({ error: result.error });
});

// POST /api/skills/:id/share/cancel —— 本人撤回分享申请
router.post('/:id/share/cancel', async (req, res) => {
  const result = await cancelShare(req.user!.username, String(req.params.id));
  if (result.ok === true) return res.json({ success: true });
  return res.status(result.status).json({ error: result.error });
});

// POST /api/skills/:id/share/approve —— 管理员批准（复制进系统库）
router.post('/:id/share/approve', requireRole('ADMIN'), async (req, res) => {
  const result = await approveShare(String(req.params.id));
  if (result.ok === true) return res.json({ success: true, skill: toApi(result.skill) });
  return res.status(result.status).json({ error: result.error });
});

// POST /api/skills/:id/share/reject —— 管理员拒绝（退回私有）
router.post('/:id/share/reject', requireRole('ADMIN'), async (req, res) => {
  const result = await rejectShare(String(req.params.id));
  if (result.ok === true) return res.json({ success: true });
  return res.status(result.status).json({ error: result.error });
});

// GET /api/skills/:id —— 单个技能详情
router.get('/:id', async (req, res) => {
  const skills = await listVisibleSkills(req.user!.username);
  const skill = skills.find((s) => s.skillId === String(req.params.id));
  if (!skill) return res.status(404).json({ error: '技能不存在' });
  res.json({ skill: toApi(skill) });
});

export default router;
