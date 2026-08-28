/**
 * P3-1 知识库管理路由（知识备份/恢复功能）
 * - GET  /api/knowledge/export       导出指定数据源的知识库
 * - POST /api/knowledge/import       导入知识库文件
 * - GET  /api/knowledge              获取当前知识库列表（用于显示）
 */

import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { DATA_RESOURCE_KNOWLEDGE_BASE, DATA_RESOURCE_DS_ID } from '../seedDataResources';
import { exportKnowledgeBase, parseImportFile, executeKnowledgeImport } from '../knowledgeBaseTools';
import { readFileSync } from 'fs';

const router = Router();

// 验证中间件（确保是管理员权限）
router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/**
 * GET /api/knowledge
 * 获取当前配置的知识库条目列表
 */
router.get('/', (req, res) => {
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
 * GET /api/knowledge/export
 * 导出知识库为 JSON 文件
 */
router.get('/export', async (req, res) => {
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
 * POST /api/knowledge/import
 * 导入知识库文件
 */
router.post('/import', async (req, res) => {
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

export default router;
