/**
 * P3-1 知识库管理面板（导入/导出功能）
 * 操作 knowledge_base 表中的真实知识文档：导出为 JSON 备份 / 从备份恢复（切块入库）。
 */

import React, { useState } from 'react';
import { Download, Upload, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import apiFetch from '../../utils/apiFetch';

interface Props {
  /** 目标数据源 ID（问数页当前选中的数据源） */
  dataSourceId?: string;
}

export const KnowledgeManagementPanel: React.FC<Props> = ({ dataSourceId }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<'skip' | 'overwrite' | 'append'>('skip');
  const [dryRun, setDryRun] = useState(false);
  const [importStatus, setImportStatus] = useState<{
    type: 'success' | 'error' | 'warning' | null;
    message: string;
    details?: any;
  } | null>(null);

  // 导出功能：下载当前数据源全部知识文档的 JSON 备份
  const handleExport = async () => {
    if (!dataSourceId) {
      setImportStatus({ type: 'error', message: '未选择数据源，无法导出' });
      return;
    }
    try {
      setIsLoading(true);
      setImportStatus(null);

      const response = await apiFetch(`/api/knowledge/export?dataSourceId=${encodeURIComponent(dataSourceId)}`);

      if (!response.ok) {
        const d = await response.json().catch(() => ({}));
        throw new Error((d as any).error || '导出失败');
      }

      // 触发浏览器下载
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      const dateStr = new Date().toISOString().split('T')[0];
      link.download = `knowledge-docs-${dataSourceId}-${dateStr}.json`;

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

  // 导入功能：读取 JSON 备份文件，POST JSON body 到服务端切块入库
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsLoading(true);
      setImportStatus(null);

      const text = await file.text();
      let fileData: any;
      try {
        fileData = JSON.parse(text);
      } catch {
        throw new Error('文件不是有效的 JSON，请选择知识库导出文件');
      }

      const response = await apiFetch('/api/knowledge/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileData,
          dataSourceId,
          mergeStrategy,
          dryRun,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || '导入失败');
      }

      setImportStatus({
        type: result.success ? 'success' : 'warning',
        message: result.dryRun
          ? `预检完成（未写入）：将新增 ${result.importedCount} 篇，覆盖更新 ${result.updatedCount} 篇，跳过 ${result.skippedCount} 篇`
          : `导入完成！新增 ${result.importedCount} 篇，覆盖更新 ${result.updatedCount} 篇，跳过 ${result.skippedCount} 篇`,
        details: result.summary,
      });
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
                  <li>文件知识文档数：{importStatus.details.totalDocs}</li>
                  <li>其中新文档：{importStatus.details.newDocs}</li>
                  <li>与现有知识同名冲突：{importStatus.details.conflictDocs}</li>
                  {importStatus.details.invalidDocs > 0 && <li>无效条目（缺标题/内容）：{importStatus.details.invalidDocs}</li>}
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
          将当前数据源已登记的全部知识文档（含完整原文）备份为 JSON 文件
        </p>
        <button
          onClick={handleExport}
          disabled={isLoading || !dataSourceId}
          className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="mr-2 h-4 w-4" />
          {isLoading ? '处理中...' : '导出知识库'}
        </button>
      </div>

      {/* 导入区域 */}
      <div>
        <h4 className="text-lg font-medium mb-2">导入知识库</h4>
        <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">
          从 JSON 备份文件恢复知识文档到当前数据源，导入后自动切块并生成检索向量
        </p>

        {/* 冲突策略与预检 */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-3">
          <select
            value={mergeStrategy}
            onChange={(e) => setMergeStrategy(e.target.value as any)}
            disabled={isLoading}
            className="flex-1 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="skip">跳过：保留现有知识，忽略同名条目</option>
            <option value="overwrite">覆盖：用文件内容替换现有同名知识</option>
            <option value="append">新增：同名也照常导入（产生重复条目）</option>
          </select>
          <label className="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              disabled={isLoading}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>仅预检（Dry Run）</span>
          </label>
        </div>

        <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center">
          <input
            type="file"
            accept=".json,application/json"
            onChange={handleFileSelect}
            disabled={isLoading || !dataSourceId}
            className="hidden"
            id="kb-file-upload"
          />

          <label
            htmlFor="kb-file-upload"
            className={`cursor-pointer flex flex-col items-center ${
              isLoading || !dataSourceId ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'
            }`}
          >
            <Upload className="h-12 w-12 text-gray-400 mb-3" />
            <span className="text-sm text-gray-600 dark:text-gray-400 mb-1">
              点击或拖拽 JSON 文件到此处
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-500">
              支持格式：知识库导出 JSON（最大 10MB）
            </span>
          </label>
        </div>

        {/* 导入说明 */}
        <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg text-sm">
          <h5 className="font-medium mb-2">导入说明：</h5>
          <ul className="list-disc list-inside space-y-1 text-gray-600 dark:text-gray-300">
            <li>冲突按「同名知识文档」判定（当前数据源范围内）</li>
            <li>跳过模式：同名条目保留现有内容，不做修改</li>
            <li>覆盖模式：删除现有同名知识，用文件内容重新切块入库</li>
            <li>新增模式：同名也照常导入，列表中会出现重复标题</li>
            <li>建议先勾选「仅预检」确认变更范围，再取消勾选执行真实导入</li>
            <li>导入前建议先导出当前知识库进行备份</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default KnowledgeManagementPanel;
