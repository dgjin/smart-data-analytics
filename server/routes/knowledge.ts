/**
 * P1-A 知识库管理路由（借鉴 DB-GPT RAG 知识库）。
 * 读取对所有登录用户开放；登记 / 删除仅 ADMIN。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { saveKnowledgeDoc } from '../knowledgeBase';

const router = Router();
router.use(authMiddleware);

// GET /api/knowledge?dataSourceId=xxx —— 列出某数据源的知识文档（按 doc 聚合）
router.get('/', async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    const [rows] = await getPool().query(
      `SELECT doc_id, title, COUNT(*) AS chunk_count, MAX(created_by) AS created_by, MAX(created_at) AS created_at
       FROM knowledge_base WHERE data_source_id = ? GROUP BY doc_id, title ORDER BY MAX(created_at) DESC`,
      [dataSourceId]
    );
    res.json({
      docs: (rows as any[]).map((r) => ({
        docId: r.doc_id,
        title: r.title,
        chunkCount: Number(r.chunk_count),
        createdBy: r.created_by,
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: `查询知识库失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/knowledge（ADMIN）—— 登记知识文档 {dataSourceId,title,content}
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { dataSourceId, title, content } = req.body || {};
  if (typeof dataSourceId !== 'string' || !dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: '标题必填' });
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '内容必填' });
  const username = String((req as any).user?.username || 'admin');
  try {
    const { docId, chunkCount } = await saveKnowledgeDoc(dataSourceId, title.trim(), content, username);
    if (chunkCount === 0) return res.status(400).json({ error: '内容为空，无法切块' });
    res.json({ ok: true, docId, chunkCount });
  } catch (err: any) {
    res.status(500).json({ error: `登记失败：${err?.message || '未知错误'}` });
  }
});

// GET /api/knowledge/:docId —— 知识文档详情（元信息 + 切块明细，按入库顺序）
router.get('/:docId', async (req, res) => {
  const docId = String(req.params.docId);
  try {
    const [rows] = await getPool().query(
      `SELECT doc_id, data_source_id, title, chunk_text, created_by, created_at
       FROM knowledge_base WHERE doc_id = ? ORDER BY id ASC`,
      [docId]
    );
    const list = rows as any[];
    if (list.length === 0) return res.status(404).json({ error: '知识文档不存在' });
    res.json({
      doc: {
        docId,
        dataSourceId: list[0].data_source_id,
        title: list[0].title,
        createdBy: list[0].created_by,
        createdAt: list[0].created_at,
        chunkCount: list.length,
        chunks: list.map((r, i) => ({ index: i + 1, text: r.chunk_text })),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: `查询详情失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/knowledge/:docId（ADMIN）—— 编辑知识文档 {title,content}：删除旧块后按原 docId 重新切块入库
router.put('/:docId', requireRole('ADMIN'), async (req, res) => {
  const docId = String(req.params.docId);
  const { title, content } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: '标题必填' });
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '内容必填' });
  const username = String((req as any).user?.username || 'admin');
  try {
    const [metaRows] = await getPool().query(
      'SELECT data_source_id FROM knowledge_base WHERE doc_id = ? LIMIT 1',
      [docId]
    );
    const meta = (metaRows as any[])[0];
    if (!meta) return res.status(404).json({ error: '知识文档不存在' });
    // 先清旧块再以同一 docId 重新切块（embedding 重新生成）
    await getPool().query('DELETE FROM knowledge_base WHERE doc_id = ?', [docId]);
    const { chunkCount } = await saveKnowledgeDoc(meta.data_source_id, title.trim(), content, username, docId);
    if (chunkCount === 0) return res.status(400).json({ error: '内容为空，无法切块' });
    res.json({ ok: true, docId, chunkCount });
  } catch (err: any) {
    res.status(500).json({ error: `保存失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/knowledge/:docId（ADMIN）
router.delete('/:docId', requireRole('ADMIN'), async (req, res) => {
  const docId = String(req.params.docId);
  try {
    const [result] = (await getPool().query('DELETE FROM knowledge_base WHERE doc_id = ?', [docId])) as any;
    if (!result || result.affectedRows === 0) return res.status(404).json({ error: '知识文档不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

export default router;
