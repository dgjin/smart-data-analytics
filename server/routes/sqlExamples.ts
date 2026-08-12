/**
 * SQL 样例库（训练语料）管理路由（Vanna training data CRUD 借鉴）。
 * 读取对所有登录用户开放；登记 / 编辑 / 剔除 / 批量导入仅 ADMIN，
 * 保证 few-shot 语料质量可由管理员持续治理（劣质样例可剔除）。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  listSqlExamples,
  createSqlExample,
  updateSqlExample,
  deleteSqlExample,
  validateExampleInput,
  generateQuestionsForSqls,
} from '../queryFeedback';

const router = Router();
router.use(authMiddleware);

// GET /api/sql-examples?dataSourceId=xxx —— 列出某数据源的全部样例
router.get('/', async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    const examples = await listSqlExamples(dataSourceId);
    res.json({ examples });
  } catch (err: any) {
    res.status(500).json({ error: `查询样例库失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/sql-examples（ADMIN）—— 手工登记样例 {dataSourceId,question,sql}
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { dataSourceId, question, sql } = req.body || {};
  if (typeof dataSourceId !== 'string' || !dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  const invalid = validateExampleInput({ question, sql });
  if (invalid) return res.status(400).json({ error: invalid });
  const username = String((req as any).user?.username || 'admin');
  try {
    const example = await createSqlExample({ dataSourceId, question, sql }, username);
    res.json({ ok: true, example });
  } catch (err: any) {
    res.status(500).json({ error: `登记失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/sql-examples/generate-questions（ADMIN）—— 给一批 SQL 反推问题（冷启动，不入库）
router.post('/generate-questions', requireRole('ADMIN'), async (req, res) => {
  const { sqls } = req.body || {};
  if (!Array.isArray(sqls) || sqls.length === 0) return res.status(400).json({ error: '缺少 sqls 数组' });
  const list = sqls.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim());
  if (list.length === 0) return res.status(400).json({ error: '没有有效的 SQL' });
  if (list.length > 10) return res.status(400).json({ error: '单次最多导入 10 条 SQL' });
  try {
    const pairs = await generateQuestionsForSqls(list);
    res.json({ pairs });
  } catch (err: any) {
    res.status(500).json({ error: `问题反推失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/sql-examples/bulk（ADMIN）—— 批量保存样例 {dataSourceId, examples:[{question,sql}]}
router.post('/bulk', requireRole('ADMIN'), async (req, res) => {
  const { dataSourceId, examples } = req.body || {};
  if (typeof dataSourceId !== 'string' || !dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  if (!Array.isArray(examples) || examples.length === 0) return res.status(400).json({ error: '缺少 examples 数组' });
  if (examples.length > 10) return res.status(400).json({ error: '单次最多保存 10 条样例' });
  const username = String((req as any).user?.username || 'admin');
  let saved = 0;
  try {
    for (const ex of examples) {
      if (validateExampleInput(ex)) continue;
      await createSqlExample({ dataSourceId, question: String(ex.question), sql: String(ex.sql) }, username, 'IMPORT');
      saved++;
    }
    if (saved === 0) return res.status(400).json({ error: '没有可保存的合法样例' });
    res.json({ ok: true, saved });
  } catch (err: any) {
    res.status(500).json({ error: `批量保存失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/sql-examples/:id（ADMIN）—— 编辑样例 {question,sql}
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的样例 ID' });
  const invalid = validateExampleInput(req.body || {});
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const { question, sql } = req.body;
    const updated = await updateSqlExample(id, { question, sql });
    if (!updated) return res.status(404).json({ error: '样例不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `保存失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/sql-examples/:id（ADMIN）—— 剔除劣质样例
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的样例 ID' });
  try {
    const deleted = await deleteSqlExample(id);
    if (!deleted) return res.status(404).json({ error: '样例不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

export default router;
