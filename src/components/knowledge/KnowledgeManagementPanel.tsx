/**
 * P3-1 知识库管理面板（导入/导出功能）
 */

import React, { useState } from 'react';
import { Download, Upload, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import apiFetch from '../../utils/apiFetch';

export const KnowledgeManagementPanel: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [importStatus, setImportStatus] = useState<{
    type: 'success' | 'error' | 'warning' | null;
    message: string;
    details?: any;
  } | null>(null);

  // 导出功能
  const handleExport = async () => {
    try {
      setIsLoading(true);
      
      const response = await fetch('/api/knowledge/export', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      });
      
      if (!response.ok) {
        throw new Error('导出失败');
      }
      
      // 触发浏览器下载
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // 生成文件名：knowledge-base-数据资源库-日期.json
      const dateStr = new Date().toISOString().split('T')[0];
      link.download = `knowledge-base-data-resource-${dateStr}.json`;
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      window.URL.revokeObjectURL(url);
      
      setImportStatus({
        type: 'success',
        message: '知识库导出成功！文件已下载',
      });
    } catch (err: any) {
      setImportStatus({
        type: 'error',
        message: err.message || '导出过程中发生错误',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // 导入功能
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsLoading(true);
      setImportStatus(null);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('mergeStrategy', 'append'); // 默认追加模式
      formData.append('dryRun', 'false');

      const response = await apiFetch('/api/knowledge/import', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (result.success) {
        setImportStatus({
          type: 'success',
          message: `导入完成！新增${result.importedCount}条，跳过${result.skippedCount}条`,
          details: result.summary,
        });
      } else {
        setImportStatus({
          type: 'error',
          message: result.error || '导入失败',
        });
      }
    } catch (err: any) {
      setImportStatus({
        type: 'error',
        message: err.message || '导入过程中发生错误',
      });
    } finally {
      setIsLoading(false);
      // 重置 input 值，允许重复上传同一文件
      event.target.value = '';
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
      <h3 className="text-xl font-semibold mb-4 flex items-center">
        <Upload className="mr-2 h-5 w-5" />
        知识库管理
      </h3>

      {/* 状态提示 */}
      {importStatus && (
        <div
          className={`mb-4 p-4 rounded-lg border ${
            importStatus.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-700 dark:text-green-200'
              : importStatus.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-200'
              : 'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-200'
          }`}
        >
          <div className="flex items-start">
            {importStatus.type === 'success' ? (
              <CheckCircle className="h-5 w-5 mr-2 flex-shrink-0" />
            ) : importStatus.type === 'error' ? (
              <XCircle className="h-5 w-5 mr-2 flex-shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 mr-2 flex-shrink-0" />
            )}
            <div className="flex-1">
              <p className="font-medium">{importStatus.message}</p>
              {importStatus.details && (
                <ul className="mt-2 text-sm list-disc list-inside">
                  <li>总条目数：{importStatus.details.totalItems}</li>
                  <li>新入库：{importStatus.details.newItems}</li>
                  <li>已更新：{importStatus.details.updatedItems}</li>
                  <li>冲突跳过：{importStatus.details.conflictItems}</li>
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 导出按钮 */}
      <div className="mb-6">
        <h4 className="text-lg font-medium mb-2">导出知识库</h4>
        <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">
          将当前知识库完整备份为 JSON 文件，包含所有知识条目的标题、内容、标签和分类信息
        </p>
        <button
          onClick={handleExport}
          disabled={isLoading}
          className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="mr-2 h-4 w-4" />
          {isLoading ? '导出中...' : '导出知识库'}
        </button>
      </div>

      {/* 导入区域 */}
      <div>
        <h4 className="text-lg font-medium mb-2">导入知识库</h4>
        <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">
          从 JSON 文件恢复知识库数据，支持三种冲突处理策略：追加/替换/跳过
        </p>
        
        <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center">
          <input
            type="file"
            accept=".json,application/json"
            onChange={handleFileSelect}
            disabled={isLoading}
            className="hidden"
            id="kb-file-upload"
          />
          
          <label
            htmlFor="kb-file-upload"
            className={`cursor-pointer flex flex-col items-center ${
              isLoading ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
            }`}
          >
            <Upload className="h-12 w-12 text-gray-400 mb-3" />
            <span className="text-sm text-gray-600 dark:text-gray-400 mb-1">
              点击或拖拽 JSON 文件到此处
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-500">
              支持格式：.json（最大 10MB）
            </span>
          </label>
        </div>

        {/* 导入说明 */}
        <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg text-sm">
          <h5 className="font-medium mb-2">导入说明：</h5>
          <ul className="list-disc list-inside space-y-1 text-gray-600 dark:text-gray-300">
            <li>确保文件格式正确（包含 version、exportedAt、knowledgeBase 字段）</li>
            <li>追加模式：自动添加新条目，跳过 ID 冲突的条目</li>
            <li>替换模式：用导入数据覆盖相同 ID 的现有条目</li>
            <li>跳过模式：遇到 ID 冲突时保留原条目不做修改</li>
            <li>导入前建议先导出数据进行备份</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default KnowledgeManagementPanel;
