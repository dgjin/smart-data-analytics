/**
 * P3-1 知识库导入导出工具函数
 * 功能：支持知识条目的 JSON 格式导出/导入，包含完整的元数据和版本信息
 */

import { KnowledgeBaseItem, KnowledgeExportFormat, KnowledgeImportResult } from '../src/types/analytics';

/**
 * 导出指定数据源的知识库内容为 JSON 文件
 * @param dataSourceId 数据源 ID
 * @param dataSourceName 数据源名称
 * @param tables 表列表
 * @param knowledgeBase 知识条目数组
 * @param currentUser 当前用户（用于记录导出者）
 * @param systemVersion 系统版本号
 * @returns KnowledgeExportFormat 格式的对象
 */
export function exportKnowledgeBase(
  dataSourceId: string,
  dataSourceName: string,
  tables: string[],
  knowledgeBase: KnowledgeBaseItem[],
  currentUser?: { username: string },
  systemVersion: string = '0.9.0'
): KnowledgeExportFormat {
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    exportBy: currentUser?.username || 'system',
    systemVersion,
    dataResourceInfo: {
      dataSourceId,
      dataSourceName,
      tables,
      knowledgeCount: knowledgeBase.length,
    },
    knowledgeBase: knowledgeBase.map(kb => ({
      ...kb,
      createdAt: kb.createdAt || new Date().toISOString(),
      updatedAt: kb.updatedAt || new Date().toISOString(),
    })),
  };
}

/**
 * 将知识库导出内容转换为 Blob 并触发浏览器下载
 * @param exportData 导出的知识库数据
 * @param fileName 文件名（不含路径）
 */
export function downloadKnowledgeBaseFile(
  exportData: KnowledgeExportFormat,
  fileName: string = 'knowledge-base-backup.json'
): void {
  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  // 清理 URL
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * 解析导入的 JSON 文件并验证格式
 * @param file JSON 文件
 * @returns Promise<{valid: boolean, data?: any, error?: string}>
 */
export async function parseImportFile(file: File): Promise<{
  valid: boolean;
  data?: KnowledgeExportFormat;
  error?: string;
}> {
  try {
    const text = await file.text();
    const jsonData = JSON.parse(text);
    
    // 验证基本结构
    if (!jsonData.version || !jsonData.exportedAt || !jsonData.knowledgeBase) {
      return { 
        valid: false, 
        error: '无效的文件格式：缺少必需的字段（version/exportedAt/knowledgeBase）' 
      };
    }
    
    // 验证知识条目格式
    for (const [index, item] of jsonData.knowledgeBase.entries()) {
      if (!item.id || !item.title || typeof item.content !== 'string') {
        return { 
          valid: false, 
          error: `第${index + 1}个知识条目格式错误：必须包含 id/title/content 字段` 
        };
      }
    }
    
    return { valid: true, data: jsonData as KnowledgeExportFormat };
  } catch (err: any) {
    return { valid: false, error: `JSON 解析失败：${err.message}` };
  }
}

/**
 * 执行知识库导入逻辑（实际业务层）
 * @param importedData 导入的数据
 * @param existingKnowledgeBase 现有知识库
 * @param strategy 冲突处理策略
 * @param dryRun 是否仅预检
 * @returns 导入结果
 */
export function executeKnowledgeImport(
  importedData: KnowledgeExportFormat,
  existingKnowledgeBase: KnowledgeBaseItem[],
  strategy: 'replace' | 'append' | 'skip',
  dryRun: boolean = false
): KnowledgeImportResult {
  const result: KnowledgeImportResult = {
    success: true,
    importedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    errors: [],
    summary: {
      totalItems: importedData.knowledgeBase.length,
      newItems: 0,
      updatedItems: 0,
      conflictItems: 0,
    },
  };
  
  const existingMap = new Map(existingKnowledgeBase.map(item => [item.id, item]));
  const operationLog: Array<{type: 'new' | 'updated' | 'skipped', itemId: string}> = [];
  
  for (const newItem of importedData.knowledgeBase) {
    const existingItem = existingMap.get(newItem.id);
    
    if (!existingItem) {
      // 新条目
      result.importedCount++;
      result.summary.newItems++;
      operationLog.push({ type: 'new', itemId: newItem.id });
      
      if (!dryRun) {
        existingKnowledgeBase.push({
          ...newItem,
          createdAt: newItem.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } else if (strategy === 'replace') {
      // 替换模式：更新现有条目
      result.importedCount++;
      result.summary.updatedItems++;
      operationLog.push({ type: 'updated', itemId: newItem.id });
      
      if (!dryRun) {
        const index = existingKnowledgeBase.findIndex(item => item.id === newItem.id);
        if (index !== -1) {
          existingKnowledgeBase[index] = {
            ...existingItem,
            content: newItem.content,
            title: newItem.title,
            tags: newItem.tags,
            category: newItem.category,
            updatedAt: new Date().toISOString(),
          };
        }
      }
    } else if (strategy === 'skip') {
      // 跳过模式：保留现有条目
      result.skippedCount++;
      result.summary.conflictItems++;
      operationLog.push({ type: 'skipped', itemId: newItem.id });
      
      result.errors?.push({
        itemId: newItem.id,
        message: '已存在相同 ID 的知识条目，按 skip 策略保留原内容',
        severity: 'warning' as const,
      });
    }
  }
  
  if (result.errorCount > 0) {
    result.success = false;
  }
  
  console.log('[KB Import]', {
    dryRun,
    strategy,
    summary: result.summary,
    operationLog,
  });
  
  return result;
}
