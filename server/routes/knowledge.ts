/**
 * 知识库管理路由（合并版）
 *
 * 一、doc/chunk 模型 CRUD（P1-A，借鉴 DB-GPT RAG 知识库）：
 * - GET    /api/knowledge?dataSourceId=xxx   列出某数据源的知识文档（按 doc 聚合）
 * - POST   /api/knowledge                    登记知识文档 {dataSourceId,title,content}（ADMIN）
 * - GET    /api/knowledge/:docId             知识文档详情（元信息 + 切块明细）
 * - PUT    /api/knowledge/:docId             编辑知识文档 {title,content}（ADMIN，原 docId 重新切块）
 * - DELETE /api/knowledge/:docId             删除知识文档（ADMIN）
 * 该模型对应 knowledge_base 表，是前端知识库面板与问数链路（liveQuery → retrieveKnowledgeSnippets）
 * 实际使用的存储。读取对所有登录用户开放；登记 / 编辑 / 删除仅 ADMIN。
 *
 * 二、条目模型备份/恢复（P3-1）：
 * - GET  /api/knowledge/seed-entries   预置知识条目列表（种子数据）
 * - GET  /api/knowledge/export         导出指定数据源的知识库（ADMIN）
 * - POST /api/knowledge/import         导入知识库文件（ADMIN）
 *
 * 注意路由注册顺序：/export、/seed-entries 等静态路径必须注册在 /:docId 参数路径之前。
 */

import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { saveKnowledgeDoc } from '../knowledgeBase';
import { DATA_RESOURCE_KNOWLEDGE_BASE, DATA_RESOURCE_DS_ID } from '../seedDataResources';
import { exportKnowledgeBase, parseImportFile, executeKnowledgeImport } from '../knowledgeBaseTools';

const router = Router();

// 验证中间件（读取对所有登录用户开放，写操作在各自路由上单独要求 ADMIN）
router.use(authMiddleware);

// ==================== doc/chunk 模型 CRUD ====================

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

// ==================== P3-1 条目模型：种子列表 / 导出 / 导入 ====================
// 注意：静态路径必须先于 /:docId 注册，否则 "export" 会被当作 docId 匹配

/**
 * GET /api/knowledge/seed-entries
 * 获取预置知识条目列表（种子数据，用于展示与导出演示）
 */
router.get('/seed-entries', (req, res) => {
  try {
    const knowledgeList = DATA_RESOURCE_KNOWLEDGE_BASE.map(kb => ({
      id: kb.id,
      title: kb.title,
      content: kb.content.substring(0, 200) + '...', // 摘要
      tags: kb.tags,
      category: kb.category,
      fullContentAvailable: true,
    }));

    res.json({
      success: true,
      dataResourceInfo: {
        dataSourceId: DATA_RESOURCE_DS_ID,
        dataSourceName: '数据资源库',
        tableCount: 2,
        knowledgeCount: knowledgeList.length,
      },
      knowledgeList,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/knowledge/export（ADMIN）
 * 导出知识库为 JSON 文件
 */
router.get('/export', requireRole('ADMIN'), async (req, res) => {
  try {
    const { dataSourceId = DATA_RESOURCE_DS_ID } = req.query;

    // 构建导出数据结构
    const exportData = exportKnowledgeBase(
      dataSourceId as string,
      '数据资源库',
      ['fct_jc_main_biz_stat', 'fct_jc_financial_stat'],
      DATA_RESOURCE_KNOWLEDGE_BASE,
      req.user!,
      '0.9.0'
    );

    // 转换为 JSON 字符串
    const jsonString = JSON.stringify(exportData, null, 2);

    // 设置响应头触发下载
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="knowledge-base-${dataSourceId}-${new Date().toISOString().split('T')[0]}.json"`
    );

    res.send(jsonString);
  } catch (err: any) {
    console.error('[KB Export Error]', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/knowledge/import（ADMIN）
 * 导入知识库文件
 */
router.post('/import', requireRole('ADMIN'), async (req, res) => {
  try {
    // 检查是否为 multipart/form-data
    if (!req.files || !('file' in req.files)) {
      return res.status(400).json({
        success: false,
        error: '未找到上传的文件',
      });
    }

    const fileUpload = req.files['file'];
    const file = fileUpload as Express.Multer.File;
    const mergeStrategy = (req.body.mergeStrategy as 'replace' | 'append' | 'skip') || 'append';
    const dryRun = req.body.dryRun === 'true';

    // 解析文件内容
    const parseResult = await parseImportFile(file);

    if (!parseResult.valid || !parseResult.data) {
      return res.status(400).json({
        success: false,
        error: parseResult.error,
      });
    }

    const importedData = parseResult.data;

    // 执行导入逻辑
    // 注意：实际部署时，这里应该更新数据库或持久化存储
    // 目前仅模拟处理过程并返回结果
    const importResult = executeKnowledgeImport(
      importedData,
      [...DATA_RESOURCE_KNOWLEDGE_BASE], // 使用副本避免污染当前内存
      mergeStrategy,
      dryRun
    );

    res.json({
      success: importResult.success,
      message: dryRun ? '预检完成，未实际导入' : '导入完成',
      ...importResult,
      importMetadata: {
        strategy: mergeStrategy,
        dryRun,
        sourceVersion: importedData.version,
        exportedAt: importedData.exportedAt,
        exportedBy: importedData.exportBy,
      },
    });
  } catch (err: any) {
    console.error('[KB Import Error]', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ==================== doc/chunk 模型：参数路径路由（必须在静态路径之后） ====================

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
