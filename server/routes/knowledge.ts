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
 * 二、真实导入/导出（操作 knowledge_base 表）：
 * - GET  /api/knowledge/export?dataSourceId=xxx   导出该数据源全部知识文档为 JSON 备份文件（ADMIN）
 * - POST /api/knowledge/import                    从 JSON 备份恢复知识文档，真正切块入库（ADMIN）
 *        body: { fileData, dataSourceId?, mergeStrategy: skip|overwrite|append, dryRun }
 *        冲突按「同数据源下同 title」判定；dryRun=true 只预检不写库
 *
 * 三、条目模型种子数据（P3-1 遗留展示）：
 * - GET  /api/knowledge/seed-entries   预置知识条目列表（种子数据）
 *
 * 注意路由注册顺序：/export、/seed-entries 等静态路径必须注册在 /:docId 参数路径之前。
 */

import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { saveKnowledgeDoc, CHUNK_OVERLAP } from '../knowledgeBase';
import { DATA_RESOURCE_KNOWLEDGE_BASE, DATA_RESOURCE_DS_ID } from '../seedDataResources';

/**
 * 将知识文档的切块序列还原为完整原文：
 * chunkText 切块时相邻块保留 CHUNK_OVERLAP 字符重叠（块 i+1 以块 i 的末尾片段开头），
 * 直接拼接会产生重复内容，这里按「最长后缀-前缀匹配」去重叠。
 */
function stitchChunks(chunks: string[]): string {
  if (chunks.length === 0) return '';
  let out = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i];
    const maxK = Math.min(CHUNK_OVERLAP, out.length, next.length);
    let k = 0;
    for (let kk = maxK; kk > 0; kk--) {
      if (out.endsWith(next.slice(0, kk))) { k = kk; break; }
    }
    out += next.slice(k);
  }
  return out;
}

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
 * GET /api/knowledge/export?dataSourceId=xxx（ADMIN）
 * 导出指定数据源在 knowledge_base 表中的全部知识文档为 JSON 备份文件。
 * 每个文档导出还原后的完整原文（content）与原始切块（chunks，保真参考）。
 */
router.get('/export', requireRole('ADMIN'), async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    const [dsRows] = await getPool().query('SELECT name FROM data_sources WHERE id = ?', [dataSourceId]);
    const dsName = String((dsRows as any[])[0]?.name || dataSourceId);

    const [rows] = await getPool().query(
      `SELECT doc_id, title, chunk_text, created_by, created_at
       FROM knowledge_base WHERE data_source_id = ? ORDER BY doc_id ASC, id ASC`,
      [dataSourceId]
    );

    // 按 doc 聚合（保持切块入库顺序）
    const docMap = new Map<string, { title: string; chunks: string[]; createdBy: string; createdAt: any }>();
    for (const r of rows as any[]) {
      const docId = String(r.doc_id);
      if (!docMap.has(docId)) {
        docMap.set(docId, {
          title: String(r.title || ''),
          chunks: [],
          createdBy: String(r.created_by || ''),
          createdAt: r.created_at,
        });
      }
      docMap.get(docId)!.chunks.push(String(r.chunk_text || ''));
    }

    const docs = Array.from(docMap.entries()).map(([docId, d]) => ({
      docId,
      title: d.title,
      content: stitchChunks(d.chunks),
      chunkCount: d.chunks.length,
      createdBy: d.createdBy,
      createdAt: d.createdAt,
    }));

    const exportData = {
      version: '2.0',
      type: 'knowledge-docs',
      exportedAt: new Date().toISOString(),
      exportedBy: String((req as any).user?.username || 'unknown'),
      dataSourceId,
      dataSourceName: dsName,
      docCount: docs.length,
      docs,
    };

    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `知识库-${dsName}-${dateStr}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="knowledge-docs-${dataSourceId}-${dateStr}.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    console.error('[KB Export Error]', err);
    res.status(500).json({ error: `导出失败：${err?.message || '未知错误'}` });
  }
});

/**
 * POST /api/knowledge/import（ADMIN）
 * 从 JSON 备份文件恢复知识文档，真正切块 + embedding 写入 knowledge_base 表。
 * body: {
 *   fileData: object,                                  // 导出文件的完整 JSON 内容（必填）
 *   dataSourceId?: string,                             // 目标数据源（缺省用文件中的来源数据源）
 *   mergeStrategy?: 'skip' | 'overwrite' | 'append',   // 冲突处理：跳过/覆盖/重复新增（默认 skip）
 *   dryRun?: boolean                                   // 仅预检不写库（默认 false）
 * }
 * 冲突判定：目标数据源下已存在相同 title 的知识文档。
 * 兼容 v2（knowledge-docs）与 v1（knowledgeBase 条目数组）两种文件格式。
 */
router.post('/import', requireRole('ADMIN'), async (req, res) => {
  try {
    const { fileData, mergeStrategy = 'skip', dryRun = false } = req.body || {};
    if (!fileData || typeof fileData !== 'object') {
      return res.status(400).json({ error: '缺少 fileData（备份文件的 JSON 内容）' });
    }
    if (!['skip', 'overwrite', 'append'].includes(mergeStrategy)) {
      return res.status(400).json({ error: 'mergeStrategy 必须是 skip / overwrite / append' });
    }

    // 格式识别与归一化为 { title, content } 列表
    let sourceDsId = '';
    let docs: Array<{ title: string; content: string }> = [];
    if (fileData.type === 'knowledge-docs' && Array.isArray(fileData.docs)) {
      sourceDsId = String(fileData.dataSourceId || '');
      docs = fileData.docs.map((d: any) => ({
        title: String(d?.title || '').trim(),
        content: String(d?.content || '').trim(),
      }));
    } else if (Array.isArray(fileData.knowledgeBase)) {
      // v1 旧格式（条目模型导出文件）：每个条目转为一篇知识文档
      sourceDsId = String(fileData?.dataResourceInfo?.dataSourceId || '');
      docs = fileData.knowledgeBase.map((kb: any) => ({
        title: String(kb?.title || '').trim(),
        content: String(kb?.content || '').trim(),
      }));
    } else {
      return res.status(400).json({ error: '无法识别的文件格式：应为知识库导出文件（含 docs 或 knowledgeBase 字段）' });
    }

    // 过滤非法条目
    const invalidCount = docs.filter((d) => !d.title || !d.content).length;
    docs = docs.filter((d) => d.title && d.content);
    if (docs.length === 0) {
      return res.status(400).json({ error: `文件中没有可导入的有效知识文档${invalidCount > 0 ? `（${invalidCount} 条缺少标题或内容）` : ''}` });
    }

    const dataSourceId = String(req.body.dataSourceId || sourceDsId || '');
    if (!dataSourceId) return res.status(400).json({ error: '缺少目标数据源 dataSourceId（文件中也没有来源信息）' });

    // 校验目标数据源存在
    const [dsRows] = await getPool().query('SELECT id, name FROM data_sources WHERE id = ?', [dataSourceId]);
    if ((dsRows as any[]).length === 0) {
      return res.status(404).json({ error: `目标数据源不存在：${dataSourceId}` });
    }

    // 现有文档 title 集合（冲突判定依据）
    const [titleRows] = await getPool().query(
      'SELECT DISTINCT title FROM knowledge_base WHERE data_source_id = ?',
      [dataSourceId]
    );
    const existingTitles = new Set((titleRows as any[]).map((r) => String(r.title)));

    const username = String((req as any).user?.username || 'admin');
    const result = {
      success: true,
      dryRun: !!dryRun,
      mergeStrategy,
      dataSourceId,
      dataSourceName: String((dsRows as any[])[0].name || dataSourceId),
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      errors: [] as Array<{ title: string; message: string }>,
      summary: {
        totalDocs: docs.length,
        newDocs: 0,
        conflictDocs: 0,
        invalidDocs: invalidCount,
      },
    };

    for (const doc of docs) {
      const conflict = existingTitles.has(doc.title);
      try {
        if (conflict) {
          result.summary.conflictDocs++;
          if (mergeStrategy === 'skip') {
            result.skippedCount++;
            continue;
          }
          if (mergeStrategy === 'overwrite') {
            if (!dryRun) {
              await getPool().query(
                'DELETE FROM knowledge_base WHERE data_source_id = ? AND title = ?',
                [dataSourceId, doc.title]
              );
              const { chunkCount } = await saveKnowledgeDoc(dataSourceId, doc.title, doc.content, username);
              if (chunkCount === 0) throw new Error('内容为空，无法切块');
            }
            result.updatedCount++;
            continue;
          }
          // append：同 title 也照常新建（新 docId）
        } else {
          result.summary.newDocs++;
        }
        if (!dryRun) {
          const { chunkCount } = await saveKnowledgeDoc(dataSourceId, doc.title, doc.content, username);
          if (chunkCount === 0) throw new Error('内容为空，无法切块');
        }
        result.importedCount++;
        // 文件内部重复 title 时，后续条目按冲突策略处理（语义与库内已有保持一致）
        existingTitles.add(doc.title);
      } catch (err: any) {
        result.errorCount++;
        result.errors.push({ title: doc.title, message: err?.message || '未知错误' });
      }
    }

    result.success = result.errorCount === 0;
    console.log('[KB Import]', {
      dryRun: result.dryRun,
      strategy: mergeStrategy,
      dataSourceId,
      imported: result.importedCount,
      updated: result.updatedCount,
      skipped: result.skippedCount,
      errors: result.errorCount,
    });
    res.json(result);
  } catch (err: any) {
    console.error('[KB Import Error]', err);
    res.status(500).json({ error: `导入失败：${err?.message || '未知错误'}` });
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
