import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  FileText,
  RefreshCw,
  Trash2,
  Eye,
  ArrowLeft,
  AlertTriangle,
  BarChart3,
  Lightbulb,
  Gauge,
  MessageSquare,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { apiFetch } from '../../api/client';
import { QueryReport } from '../../types/analytics';
import { ExecutiveReportCard } from './ExecutiveReportCard';

/**
 * v0.5.0 智能问数报告中心
 * 展示智能问数「报告模式」生成的报告列表，支持查看详情（复用 ExecutiveReportCard）与删除。
 * 与「报表中心」区分：报表中心是手动选择模板生成，报告中心是问数对话生成。
 */
export const QueryReportCenter: React.FC = () => {
  const { activeDataSourceId, dataSources, pendingReportId, setPendingReportId } = useAnalyticsStore();
  const user = useAuthStore((s) => s.user);

  const [reports, setReports] = useState<QueryReport[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);

  const loadReports = useCallback(async () => {
    if (!activeDataSourceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/query-reports?dataSourceId=${encodeURIComponent(activeDataSourceId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || '报告列表加载失败');
      }
      setReports(data.reports);
    } catch (err: any) {
      setError(err?.message || '报告列表加载失败');
    } finally {
      setIsLoading(false);
    }
  }, [activeDataSourceId]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  // 从问数对话跳转：列表加载完成后自动进入对应报告详情
  // 用 ref 记录已消费的 reportId，防止 StrictMode 双调用 / 重渲染窗口内重复消费导致跳回详情
  const consumedReportIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingReportId && reports.length > 0 && consumedReportIdRef.current !== pendingReportId) {
      consumedReportIdRef.current = pendingReportId;
      const target = reports.find((r) => r.reportId === pendingReportId);
      if (target) {
        setSelectedReportId(pendingReportId);
      }
      setPendingReportId(null);
    }
  }, [pendingReportId, reports, setPendingReportId]);

  const handleDelete = async (reportId: string) => {
    if (!window.confirm('确定删除该报告吗？删除后不可恢复。')) return;
    setDeletingId(reportId);
    try {
      const res = await apiFetch(`/api/query-reports/${encodeURIComponent(reportId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || '删除失败');
      }
      setReports((prev) => prev.filter((r) => r.reportId !== reportId));
      if (selectedReportId === reportId) {
        setSelectedReportId(null);
      }
    } catch (err: any) {
      alert(err?.message || '删除失败，请稍后重试');
    } finally {
      setDeletingId(null);
    }
  };

  const selectedReport = reports.find((r) => r.reportId === selectedReportId);

  // 详情视图：复用 ExecutiveReportCard 完整展示（含 PDF/PPT 导出）
  if (selectedReport) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-800/60 shrink-0">
          <button
            onClick={() => setSelectedReportId(null)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回报告列表</span>
          </button>
          <div className="flex items-center space-x-2 text-[11px] text-slate-500">
            <MessageSquare className="w-3 h-3" />
            <span className="truncate max-w-md">提问：{selectedReport.question}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <ExecutiveReportCard
            report={selectedReport.reportData}
            onDelete={
              user && (user.id === selectedReport.userId || user.role === 'ADMIN')
                ? () => handleDelete(selectedReport.reportId)
                : undefined
            }
          />
        </div>
      </div>
    );
  }

  // 列表视图
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/60 shrink-0">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center">
            <FileText className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-100">智能问数报告中心</h1>
            <p className="text-[11px] text-slate-500 mt-0.5">
              智能问数「报告模式」生成的分析报告{activeDS ? `（数据源：${activeDS.name}）` : ''}
            </p>
          </div>
        </div>
        <button
          onClick={loadReports}
          disabled={isLoading}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {/* 报告列表 */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="flex items-center space-x-2 p-3 mb-4 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!isLoading && !error && reports.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500">
            <FileText className="w-12 h-12 mb-3 opacity-30" />
            <div className="text-sm font-medium">暂无问数报告</div>
            <div className="text-xs mt-1.5 text-slate-600">
              在智能问数中开启「报告模式」并提问，生成的报告将出现在这里
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {reports.map((r) => (
            <div
              key={r.reportId}
              className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-emerald-500/40 transition-colors space-y-2.5"
            >
              <div className="flex items-start justify-between space-x-2">
                <div className="text-sm font-bold text-slate-100 line-clamp-1">{r.reportData.title}</div>
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-400">
                  {r.templateName || '智能推断'}
                </span>
              </div>
              <div className="text-xs text-slate-400 line-clamp-1">
                提问：{r.question.length > 50 ? `${r.question.slice(0, 50)}…` : r.question}
              </div>
              <div className="flex items-center space-x-3 text-[11px] text-slate-500">
                <span className="flex items-center space-x-1">
                  <Gauge className="w-3 h-3" />
                  <span>KPI {r.reportData.kpiList?.length ?? 0}</span>
                </span>
                <span className="flex items-center space-x-1">
                  <BarChart3 className="w-3 h-3" />
                  <span>图表 {r.reportData.charts?.length ?? 0}</span>
                </span>
                <span className="flex items-center space-x-1">
                  <Lightbulb className="w-3 h-3" />
                  <span>洞察 {r.reportData.insights?.length ?? 0}</span>
                </span>
                <span className="ml-auto">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
              </div>
              <div className="flex items-center space-x-2 pt-1 border-t border-slate-800/60">
                <button
                  onClick={() => setSelectedReportId(r.reportId)}
                  className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium transition-colors"
                >
                  <Eye className="w-3 h-3" />
                  <span>查看详情</span>
                </button>
                {user && (user.id === r.userId || user.role === 'ADMIN') && (
                  <button
                    onClick={() => handleDelete(r.reportId)}
                    disabled={deletingId === r.reportId}
                    className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-950/40 border border-slate-700 hover:border-rose-500/30 text-slate-400 hover:text-rose-300 text-[11px] transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{deletingId === r.reportId ? '删除中…' : '删除'}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
