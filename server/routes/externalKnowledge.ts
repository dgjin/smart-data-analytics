/**
 * 外部知识库接入管理路由。
 * 接口配置权限仅管理员（requireRole('ADMIN')）：外部源涉及企业凭据与网络边界，
 * 统一由 ADMIN 维护；问数链路自动检索注入，对所有角色的问数生效。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  validateExternalKbInput,
  listExternalKbSources,
  saveExternalKbSource,
  deleteExternalKbSource,
  testExternalKbEndpoint,
} from '../externalKnowledge';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

// GET /api/knowledge-external —— 列出全部外部知识源（api_key 不出明文）
router.get('/', async (_req, res) => {
  try {
    res.json({ sources: await listExternalKbSources() });
  } catch (err: any) {
    res.status(500).json({ error: `查询外部知识源失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/knowledge-external —— 新增 {name,endpoint,authType,apiKey?,timeoutMs,dataSourceId,enabled}
router.post('/', async (req, res) => {
  const input = req.body || {};
  const invalid = validateExternalKbInput(input);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const id = await saveExternalKbSource(input, String((req as any).user?.username || 'admin'));
    res.json({ ok: true, id });
  } catch (err: any) {
    res.status(500).json({ error: `新增失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/knowledge-external/:id —— 编辑（apiKey 留空保留原密钥；authType 改 none 时清空密钥）
router.put('/:id', async (req, res) => {
  const id = String(req.params.id);
  const input = req.body || {};
  const invalid = validateExternalKbInput(input);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const updated = await saveExternalKbSource(input, String((req as any).user?.username || 'admin'), id);
    res.json({ ok: true, id: updated });
  } catch (err: any) {
    res.status(500).json({ error: `保存失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/knowledge-external/:id
router.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteExternalKbSource(String(req.params.id));
    if (!ok) return res.status(404).json({ error: '外部知识源不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/knowledge-external/test —— 连通性测试（用表单当前值即时检索，不落库）
router.post('/test', async (req, res) => {
  const input = req.body || {};
  const invalid = validateExternalKbInput(input);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const result = await testExternalKbEndpoint({
      endpoint: String(input.endpoint),
      authType: input.authType === 'bearer' ? 'bearer' : 'none',
      apiKey: input.apiKey ? String(input.apiKey) : undefined,
      timeoutMs: Number(input.timeoutMs) || 5000,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `测试失败：${err?.message || '未知错误'}` });
  }
});

export default router;
