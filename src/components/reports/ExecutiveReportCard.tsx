import React, { useState, useEffect, useRef } from 'react';
import {
  FileText,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  Info,
  Sparkles,
  Download,
  Printer,
  Share2,
  Zap,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Activity,
  RefreshCw,
  Palette,
  FileDown,
  Loader2,
  Check,
  X,
  Sliders,
  CheckSquare,
  Square,
  FileCheck2,
  GitCompare,
  Percent,
  Presentation,
} from 'lucide-react';
import { SavedReport, AnomalyItem, ChartComment, ChartCommentReply } from '../../types/analytics';
import { DynamicChart, ComparisonMode } from '../charts/DynamicChart';
import { scanReportForAnomalies } from '../../utils/anomalyDetector';
import { ChartCommentSection } from './ChartCommentSection';
import { DrillModal } from './DrillModal';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { CHART_THEMES } from '../../utils/chartThemes';
import { apiFetch } from '../../api/client';

interface ExecutiveReportCardProps {
  report: SavedReport;
  onDelete?: () => void;
}

export const ExecutiveReportCard: React.FC<ExecutiveReportCardProps> = ({
  report,
  onDelete,
}) => {
  const [activeReport, setActiveReport] = useState<SavedReport>(report);
  const [isScanning, setIsScanning] = useState(false);
  const [showAnomalyPanel, setShowAnomalyPanel] = useState(true);
  const [globalThemeId, setGlobalThemeId] = useState<string>('cyber');
  const [globalAutoContrast, setGlobalAutoContrast] = useState<boolean>(true);
  const [globalComparisonMode, setGlobalComparisonMode] = useState<ComparisonMode>('none');
  const [globalShowDiffBadges, setGlobalShowDiffBadges] = useState<boolean>(true);

  // PDF Export States
  const [showPdfExportModal, setShowPdfExportModal] = useState<boolean>(false);
  const [isExportingPDF, setIsExportingPDF] = useState<boolean>(false);
  const [pdfExportSuccess, setPdfExportSuccess] = useState<boolean>(false);
  const [pdfOrientation, setPdfOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [includeComments, setIncludeComments] = useState<boolean>(true);

  // M4 PPT Export States（服务端 pptxgenjs 组装，图表转 base64 PNG 提交）
  const [isExportingPPT, setIsExportingPPT] = useState<boolean>(false);
  const [pptError, setPptError] = useState<string | null>(null);

  const reportRef = useRef<HTMLDivElement>(null);

  const { addReportComment, addReportCommentReply, toggleReportCommentResolve } =
    useAnalyticsStore();

  useEffect(() => {
    // Automatically perform initial AI anomaly scan on the report
    const scanned = scanReportForAnomalies(report);
    setActiveReport({
      ...scanned,
      comments: report.comments || scanned.comments || [],
    });
  }, [report]);

  const handleAddComment = (comment: ChartComment) => {
    addReportComment(activeReport.id, comment);
    setActiveReport((prev) => ({
      ...prev,
      comments: [comment, ...(prev.comments || [])],
    }));
  };

  const handleAddReply = (commentId: string, reply: ChartCommentReply) => {
    addReportCommentReply(activeReport.id, commentId, reply);
    setActiveReport((prev) => ({
      ...prev,
      comments: (prev.comments || []).map((cmt) => {
        if (cmt.id !== commentId) return cmt;
        return { ...cmt, replies: [...cmt.replies, reply] };
      }),
    }));
  };

  const handleToggleResolve = (commentId: string) => {
    toggleReportCommentResolve(activeReport.id, commentId);
    setActiveReport((prev) => ({
      ...prev,
      comments: (prev.comments || []).map((cmt) => {
        if (cmt.id !== commentId) return cmt;
        return { ...cmt, isResolved: !cmt.isResolved };
      }),
    }));
  };

  const handleReScanAnomalies = () => {
    setIsScanning(true);
    setTimeout(() => {
      const scanned = scanReportForAnomalies(report);
      setActiveReport(scanned);
      setIsScanning(false);
    }, 600);
  };

  const [drillOpen, setDrillOpen] = useState(false);
  const [drillTarget, setDrillTarget] = useState<{ idx: number; dimKey: string; dimValue: string | number } | null>(null);

  const handlePrint = () => {
    setGlobalThemeId('print');
    setTimeout(() => {
      window.print();
    }, 150);
  };

  // Recharts 渲染的是 SVG，转 PNG：序列化 svg → Image → 2x canvas → toDataURL
  const svgToPng = (svg: SVGSVGElement, bgColor = '#ffffff'): Promise<string | null> => {
    return new Promise((resolve) => {
      try {
        const rect = svg.getBoundingClientRect();
        const w = Math.max(Math.round(rect.width), 400);
        const h = Math.max(Math.round(rect.height), 260);
        const cloned = svg.cloneNode(true) as SVGSVGElement;
        cloned.setAttribute('width', String(w));
        cloned.setAttribute('height', String(h));
        cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        const xml = new XMLSerializer().serializeToString(cloned);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = w * 2;
          canvas.height = h * 2;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
        img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
      } catch {
        resolve(null);
      }
    });
  };

  // M4：下载 PPT（服务端组装 PPTX，图表按顺序与 activeReport.charts 对齐）
  const handleExportPPT = async () => {
    if (!reportRef.current || isExportingPPT) return;
    setIsExportingPPT(true);
    setPptError(null);
    try {
      const svgs = Array.from(reportRef.current.querySelectorAll('svg.recharts-surface'));
      const charts = await Promise.all(
        activeReport.charts.map(async (chartBlock, idx) => {
          const svg = svgs[idx];
          const imageBase64 = svg ? await svgToPng(svg as SVGSVGElement) : null;
          return {
            title: chartBlock.title,
            commentary: chartBlock.commentary || '',
            ...(imageBase64 ? { imageBase64 } : {}),
          };
        })
      );

      const response = await apiFetch('/api/report/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: activeReport.title,
          summary: activeReport.summary,
          createdAt: activeReport.createdAt,
          templateType: activeReport.templateType,
          kpiList: activeReport.kpiList || [],
          insights: activeReport.insights || [],
          charts,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error || `导出失败（${response.status}）`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeReport.title.replace(/[\\/:*?"<>|\s]+/g, '_')}_分析简报_${activeReport.createdAt}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('PPT Export Error:', err);
      setPptError(err?.message || 'PPT 导出失败，请稍后重试');
      setTimeout(() => setPptError(null), 5000);
    } finally {
      setIsExportingPPT(false);
    }
  };

  // v0.5.3 PDF 导出：服务端 ReportLab 原生排版（替代 html2pdf.js 截图方案），图表 SVG→PNG 随数据提交
  const handleExportPDF = async () => {
    if (!reportRef.current || isExportingPDF) return;
    setIsExportingPDF(true);
    setPdfExportSuccess(false);
    try {
      setShowPdfExportModal(false);
      // 截取图表（recharts SVG → PNG base64，深色底与报告卡片一致）
      const svgs = Array.from(reportRef.current.querySelectorAll('svg.recharts-surface'));
      const charts = await Promise.all(
        activeReport.charts.map(async (chartBlock, idx) => {
          const svg = svgs[idx];
          const imageBase64 = svg ? await svgToPng(svg as SVGSVGElement, '#0f172a') : null;
          return {
            title: chartBlock.title,
            commentary: chartBlock.commentary || '',
            ...(imageBase64 ? { imageBase64 } : {}),
          };
        })
      );

      const response = await apiFetch('/api/report/export-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: activeReport.title,
          summary: activeReport.summary,
          createdAt: activeReport.createdAt,
          templateType: activeReport.templateType,
          kpiList: activeReport.kpiList || [],
          insights: activeReport.insights || [],
          charts,
          orientation: pdfOrientation,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error || `导出失败（${response.status}）`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeReport.title.replace(/[\\/:*?"<>|\s]+/g, '_')}_分析简报_${activeReport.createdAt}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPdfExportSuccess(true);
      setTimeout(() => setPdfExportSuccess(false), 2000);
    } catch (err: any) {
      console.error('PDF Export Error:', err);
      alert(`PDF 导出失败：${err?.message || '未知错误'}`);
    } finally {
      setIsExportingPDF(false);
    }
  };

  const allAnomalies: AnomalyItem[] = activeReport.anomalies || [];
  const highSeverityCount = allAnomalies.filter((a) => a.severity === 'high').length;

  return (
    <div
      ref={reportRef}
      className={`border rounded-3xl p-6 md:p-8 space-y-6 shadow-xl transition-colors print:p-0 print:border-none print:shadow-none print:bg-white print:text-black ${
        globalThemeId === 'light'
          ? 'bg-white border-slate-200 text-slate-900'
          : 'bg-slate-900 border-slate-800 text-slate-100'
      }`}
    >
      {/* Report Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="space-y-1">
          <div className="flex items-center space-x-2 flex-wrap gap-y-1">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              AI 高管决策简报
            </span>
            <span className="text-xs text-slate-400 flex items-center space-x-1">
              <Calendar className="w-3.5 h-3.5" />
              <span>{report.createdAt}</span>
            </span>
            {allAnomalies.length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center space-x-1 animate-pulse">
                <Zap className="w-3 h-3 text-amber-400" />
                <span>监测到 {allAnomalies.length} 项数据异常波动</span>
              </span>
            )}
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold tracking-tight">
            {report.title}
          </h2>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2 print:hidden shrink-0 flex-wrap gap-y-2">
          <button
            onClick={handleReScanAnomalies}
            disabled={isScanning}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold transition-all shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-amber-400 ${isScanning ? 'animate-spin' : ''}`} />
            <span>{isScanning ? 'AI算法扫描中...' : '重新扫描异常'}</span>
          </button>

          {/* High Quality PDF Export Button */}
          <button
            onClick={() => setShowPdfExportModal(true)}
            className="flex items-center space-x-1.5 px-4 py-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white border border-indigo-400/30 text-xs font-bold transition-all shadow-md shadow-indigo-600/20"
          >
            <FileDown className="w-4 h-4" />
            <span>导出高清 PDF 文档</span>
          </button>

          {/* M4 PPT Export Button（服务端 pptxgenjs 组装，图表自动转 PNG 嵌入） */}
          <button
            onClick={handleExportPPT}
            disabled={isExportingPPT}
            className="flex items-center space-x-1.5 px-4 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white border border-emerald-400/30 text-xs font-bold transition-all shadow-md shadow-emerald-600/20"
          >
            {isExportingPPT ? <Loader2 className="w-4 h-4 animate-spin" /> : <Presentation className="w-4 h-4" />}
            <span>{isExportingPPT ? '正在生成 PPT...' : '下载 PPT 简报'}</span>
          </button>

          <button
            onClick={handlePrint}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition-colors"
            title="自动转换为打印友好模式"
          >
            <Printer className="w-3.5 h-3.5 text-cyan-400" />
            <span>打印</span>
          </button>
        </div>
      </div>

      {/* M4 PPT 导出失败提示 */}
      {pptError && (
        <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex items-center space-x-2 print:hidden">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{pptError}</span>
        </div>
      )}

      {/* Global Chart Theme & YoY/MoM Comparison Toolbar */}
      <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3 flex flex-col xl:flex-row xl:items-center justify-between gap-3 text-xs print:hidden">
        <div className="flex items-center space-x-2 overflow-x-auto">
          <Palette className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="font-bold text-slate-200 shrink-0">图表全局配色:</span>
          <div className="flex items-center space-x-1 py-0.5 shrink-0">
            {Object.values(CHART_THEMES).map((theme) => {
              const isActive = globalThemeId === theme.id;
              return (
                <button
                  key={theme.id}
                  onClick={() => setGlobalThemeId(theme.id)}
                  className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold flex items-center space-x-1.5 shrink-0 transition-all ${
                    isActive
                      ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 shadow-sm'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="flex items-center space-x-0.5">
                    {theme.colors.slice(0, 3).map((c, i) => (
                      <span
                        key={i}
                        className="w-2 h-2 rounded-full inline-block"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                  <span>{theme.name.split(' ')[0]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center space-x-3 shrink-0 text-[11px] text-slate-400 flex-wrap gap-y-2">
          {/* Global YoY / MoM Analysis Mode Switcher */}
          <div className="flex items-center space-x-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
            <span className="text-[11px] font-bold text-slate-300 px-1 flex items-center space-x-1">
              <GitCompare className="w-3.5 h-3.5 text-indigo-400" />
              <span>同/环比分析:</span>
            </span>
            <button
              type="button"
              onClick={() => setGlobalComparisonMode('none')}
              className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                globalComparisonMode === 'none'
                  ? 'bg-slate-800 text-slate-100 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              原值
            </button>
            <button
              type="button"
              onClick={() => setGlobalComparisonMode('yoy')}
              className={`px-2.5 py-1 rounded-lg font-bold transition-all flex items-center space-x-1 ${
                globalComparisonMode === 'yoy'
                  ? 'bg-indigo-600/40 text-indigo-200 border border-indigo-500/50 shadow'
                  : 'text-slate-400 hover:text-indigo-300'
              }`}
            >
              <span>同比 (YoY)</span>
            </button>
            <button
              type="button"
              onClick={() => setGlobalComparisonMode('mom')}
              className={`px-2.5 py-1 rounded-lg font-bold transition-all flex items-center space-x-1 ${
                globalComparisonMode === 'mom'
                  ? 'bg-cyan-600/40 text-cyan-200 border border-cyan-500/50 shadow'
                  : 'text-slate-400 hover:text-cyan-300'
              }`}
            >
              <span>环比 (MoM)</span>
            </button>
          </div>

          {globalComparisonMode !== 'none' && (
            <button
              type="button"
              onClick={() => setGlobalShowDiffBadges(!globalShowDiffBadges)}
              className={`px-2.5 py-1 rounded-xl border font-bold flex items-center space-x-1 transition-all ${
                globalShowDiffBadges
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300'
              }`}
            >
              <Percent className="w-3.5 h-3.5 text-emerald-400" />
              <span>{globalShowDiffBadges ? '差异标记 ON' : '标记 OFF'}</span>
            </button>
          )}

          <label className="flex items-center space-x-1.5 cursor-pointer hover:text-slate-200">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span>对比度优化</span>
            <input
              type="checkbox"
              checked={globalAutoContrast}
              onChange={(e) => setGlobalAutoContrast(e.target.checked)}
              className="rounded accent-indigo-500 ml-1"
            />
          </label>
        </div>
      </div>

      {/* Executive Summary */}
      <div
        className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-1.5"
        style={{ breakInside: 'avoid' }}
      >
        <div className="text-xs font-bold text-indigo-400 flex items-center space-x-1">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span>高管摘要 (Executive Summary)</span>
        </div>
        <p className="text-xs md:text-sm text-slate-300 leading-relaxed">
          {report.summary}
        </p>
      </div>

      {/* AI Anomaly Highlight Callout Panel */}
      {allAnomalies.length > 0 && showAnomalyPanel && (
        <div
          className="p-4 rounded-2xl bg-slate-950 border border-amber-500/40 space-y-3 shadow-lg shadow-amber-500/5"
          style={{ breakInside: 'avoid' }}
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <div className="flex items-center space-x-2">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="text-xs font-bold text-amber-300 uppercase tracking-wider">
                AI 自动异常数据高亮扫描诊断结果 ({allAnomalies.length} 处)
              </span>
            </div>
            <div className="flex items-center space-x-2 text-[10px] print:hidden">
              {highSeverityCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 font-bold">
                  高风险异常: {highSeverityCount} 项
                </span>
              )}
              <button
                onClick={() => setShowAnomalyPanel(false)}
                className="text-slate-500 hover:text-slate-300 underline"
              >
                收起面板
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {allAnomalies.map((anom) => {
              const isHigh = anom.severity === 'high';
              return (
                <div
                  key={anom.id}
                  className={`p-3 rounded-xl border text-xs space-y-1.5 transition-all ${
                    isHigh
                      ? 'bg-rose-950/20 border-rose-500/40 text-rose-200'
                      : 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold flex items-center space-x-1 truncate">
                      <Zap className={`w-3.5 h-3.5 ${isHigh ? 'text-rose-400' : 'text-amber-400'}`} />
                      <span className="truncate">{anom.metricLabel}</span>
                      {anom.dimensionValue && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                          {anom.dimensionValue}
                        </span>
                      )}
                    </span>
                    <span
                      className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                        anom.deviationPercent > 0
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                      }`}
                    >
                      {anom.deviationPercent > 0 ? '+' : ''}
                      {anom.deviationPercent}% 偏离
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-300 leading-snug">
                    {anom.reasoning}
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5 border-t border-slate-800/80">
                    <span>实际值: <strong className="text-slate-100">{anom.actualValue}</strong></span>
                    <span>参考基准: <strong className="text-slate-300">{anom.expectedValue}</strong></span>
                    {anom.zScore && <span>Z-Score: <strong className="text-amber-300 font-mono">{anom.zScore}σ</strong></span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* KPI Grid with Anomaly Badges */}
      {activeReport.kpiList && activeReport.kpiList.length > 0 && (
        <div className="space-y-2" style={{ breakInside: 'avoid' }}>
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1 flex items-center justify-between">
            <span>核心绩效KPI卡片</span>
            <span className="text-[10px] text-slate-500">自动实时勾勒异常波动指标</span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {activeReport.kpiList.map((kpi, idx) => {
              const isAnomaly = kpi.isAnomaly;
              return (
                <div
                  key={idx}
                  className={`p-4 bg-slate-950/80 border rounded-2xl space-y-1.5 relative overflow-hidden transition-all ${
                    isAnomaly
                      ? 'border-amber-500/60 shadow-lg shadow-amber-500/10 ring-1 ring-amber-500/30'
                      : 'border-slate-800'
                  }`}
                >
                  {isAnomaly && (
                    <div className="absolute top-2 right-2 flex items-center space-x-1 px-1.5 py-0.5 rounded bg-amber-500 text-slate-950 text-[9px] font-extrabold uppercase shadow animate-pulse">
                      <Zap className="w-2.5 h-2.5" />
                      <span>异常高亮</span>
                    </div>
                  )}

                  <div className="text-xs text-slate-400 pr-12 truncate">{kpi.label}</div>
                  <div className="text-xl font-extrabold text-slate-100 font-mono">
                    {kpi.value}
                  </div>
                  <div
                    className={`text-xs font-semibold flex items-center space-x-1 ${
                      kpi.status === 'good'
                        ? 'text-emerald-400'
                        : kpi.status === 'bad'
                        ? 'text-rose-400'
                        : 'text-slate-400'
                    }`}
                  >
                    <span>{kpi.change} 同比/环比</span>
                  </div>

                  {kpi.anomalyNote && (
                    <div className="text-[10px] text-amber-300 font-medium bg-amber-950/40 p-1.5 rounded-lg border border-amber-500/20 leading-tight">
                      {kpi.anomalyNote}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Strategic Insights */}
      {activeReport.insights && activeReport.insights.length > 0 && (
        <div className="space-y-3" style={{ breakInside: 'avoid' }}>
          <h3 className="font-bold text-sm text-slate-200 uppercase tracking-wider">
            核心洞察与行动策略 (Key Insights & Action Items)
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {activeReport.insights.map((item, idx) => {
              const isWarning = item.type === 'warning' || item.type === 'critical';
              return (
                <div
                  key={idx}
                  className={`p-4 rounded-2xl border space-y-2 ${
                    isWarning
                      ? 'bg-rose-950/20 border-rose-500/30'
                      : 'bg-indigo-950/20 border-indigo-500/30'
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    {isWarning ? (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                    <h4 className="font-bold text-xs text-slate-100">{item.title}</h4>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {item.content}
                  </p>
                  {item.actionItem && (
                    <div className="p-2 rounded-xl bg-slate-950/80 border border-slate-800 text-[11px] text-indigo-300 font-medium">
                      <strong>推荐方案:</strong> {item.actionItem}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Visual Charts with Anomaly Annotations */}
      {activeReport.charts && activeReport.charts.length > 0 && (
        <div className="space-y-6">
          <h3 className="font-bold text-sm text-slate-200 uppercase tracking-wider flex items-center justify-between">
            <span>可视化报表图表 (Analytics Charts)</span>
            <span className="text-xs text-slate-400 normal-case font-normal">
              支持滚轮缩放、选区放大与异常数据标注
            </span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {activeReport.charts.map((chartBlock, idx) => {
              const chartAnomalies = chartBlock.anomalies || [];
              return (
                <div
                  key={idx}
                  className="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-3 relative"
                  style={{ breakInside: 'avoid' }}
                >
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-xs text-slate-200 truncate">
                      {chartBlock.title}
                    </h4>
                    {chartAnomalies.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold flex items-center space-x-1 shrink-0">
                        <Zap className="w-3 h-3 text-amber-400" />
                        <span>标注 {chartAnomalies.length} 处波峰/波谷异常</span>
                      </span>
                    )}
                  </div>

                  {/* Render Dynamic Chart */}
                  <DynamicChart
                    config={chartBlock.chartConfig}
                    data={chartBlock.data}
                    height={260}
                    globalThemeId={globalThemeId}
                    autoOptimizeContrast={globalAutoContrast}
                    comparisonMode={globalComparisonMode}
                    showDiffBadges={globalShowDiffBadges}
                    drillable={['bar', 'line', 'area'].includes(chartBlock.chartConfig.type)}
                    onDrill={(dimKey, dimValue) => {
                      setDrillTarget({ idx, dimKey, dimValue });
                      setDrillOpen(true);
                    }}
                  />
                  {['bar', 'line', 'area'].includes(chartBlock.chartConfig.type) && (
                    <div className="text-[10px] text-slate-500 text-center -mt-1">
                      点击图表维度可下钻查看明细
                    </div>
                  )}

                  {/* Anomaly Callout Badges below chart */}
                  {chartAnomalies.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[10px] font-bold text-amber-400 flex items-center space-x-1">
                        <Activity className="w-3 h-3" />
                        <span>检测到的图表异常波动点:</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {chartAnomalies.map((anom) => (
                          <div
                            key={anom.id}
                            className="px-2.5 py-1 rounded-lg bg-amber-950/60 border border-amber-500/40 text-[11px] text-amber-200 flex items-center space-x-1.5"
                          >
                            <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                            <span>
                              <strong>{anom.dimensionValue}</strong>: 偏离均值{' '}
                              <span className="font-mono text-white">
                                {anom.deviationPercent > 0 ? '+' : ''}
                                {anom.deviationPercent}%
                              </span>{' '}
                              ({anom.zScore}σ)
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {chartBlock.commentary && (
                    <p className="text-[11px] text-slate-400 italic bg-slate-900 p-2.5 rounded-xl border border-slate-800/80">
                      💡 解读: {chartBlock.commentary}
                    </p>
                  )}

                  {/* Collaborative Comments & Annotations */}
                  {includeComments && (
                    <ChartCommentSection
                      reportId={activeReport.id}
                      chartTitle={chartBlock.title}
                      availableDataPoints={(chartBlock.data || [])
                        .map((d) => String(d[chartBlock.chartConfig.xAxisKey] || ''))
                        .filter(Boolean)}
                      comments={activeReport.comments || []}
                      onAddComment={handleAddComment}
                      onAddReply={handleAddReply}
                      onToggleResolve={handleToggleResolve}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Interactive PDF Export Modal / Configuration Panel */}
      {showPdfExportModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-indigo-500/40 rounded-3xl p-6 md:p-8 max-w-lg w-full space-y-6 shadow-2xl relative">
            <button
              onClick={() => setShowPdfExportModal(false)}
              className="absolute top-5 right-5 text-slate-400 hover:text-slate-100 p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="space-y-1">
              <div className="flex items-center space-x-2 text-indigo-400 text-xs font-bold uppercase tracking-wider">
                <FileDown className="w-4 h-4 text-indigo-400" />
                <span>高清 PDF 渲染导出配置 (PDF Generator)</span>
              </div>
              <h3 className="text-xl font-extrabold text-slate-100">
                【{activeReport.title}】
              </h3>
              <p className="text-xs text-slate-400">
                将当前简报中的完整矢量图表、KPI绩效指标与策略洞察编译为高质量 PDF 离线文档。
              </p>
            </div>

            {/* Config Form */}
            <div className="space-y-4 text-xs">
              {/* Paper Orientation */}
              <div className="space-y-1.5">
                <label className="font-bold text-slate-200">1. PDF 页面版式方向 (Page Orientation)</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPdfOrientation('portrait')}
                    className={`p-3 rounded-xl border font-bold flex items-center justify-center space-x-2 transition-all ${
                      pdfOrientation === 'portrait'
                        ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 shadow'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    <span>📄 A4 纵向 (Portrait)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPdfOrientation('landscape')}
                    className={`p-3 rounded-xl border font-bold flex items-center justify-center space-x-2 transition-all ${
                      pdfOrientation === 'landscape'
                        ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 shadow'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    <span>🖼️ A4 横向 (Landscape)</span>
                  </button>
                </div>
              </div>

              {/* v0.5.3 服务端 ReportLab 排版：矢量文字 + 图表高清嵌入，无截图错位/遮挡问题 */}
              <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-[11px] text-indigo-300 leading-relaxed">
                2. 渲染引擎已升级为服务端原生排版（ReportLab）：标题/摘要/KPI/洞察为矢量文字，图表按 2x 高清嵌入，不再存在截图错位与遮挡。
              </div>

              {/* Include Options */}
              <div className="space-y-2 pt-1 border-t border-slate-800">
                <label className="font-bold text-slate-200">3. 附带组件内容设置</label>
                <label
                  onClick={() => setIncludeComments(!includeComments)}
                  className="flex items-center space-x-2 cursor-pointer p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 hover:border-slate-700"
                >
                  {includeComments ? (
                    <CheckSquare className="w-4 h-4 text-indigo-400" />
                  ) : (
                    <Square className="w-4 h-4 text-slate-500" />
                  )}
                  <span>包含团队图表标注与协同批注讨论区 (Include Annotations)</span>
                </label>
              </div>
            </div>

            {/* Export Success Message */}
            {pdfExportSuccess && (
              <div className="p-3 bg-emerald-950 border border-emerald-500/50 rounded-xl text-emerald-300 text-xs font-bold flex items-center space-x-2 animate-fadeIn">
                <FileCheck2 className="w-4 h-4 text-emerald-400 shrink-0 animate-bounce" />
                <span>高清 PDF 导出成功！文档已自动下载保存至系统本地。</span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-end space-x-3 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowPdfExportModal(false)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleExportPDF}
                disabled={isExportingPDF}
                className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-500 hover:from-indigo-500 hover:to-cyan-400 text-white font-bold text-xs flex items-center space-x-2 shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
              >
                {isExportingPDF ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>正在渲染高清图表并生成 PDF...</span>
                  </>
                ) : (
                  <>
                    <FileDown className="w-4 h-4" />
                    <span>立即编译导出高清 PDF</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* P2-2 下钻弹层：点击图表维度后展示明细数据（仅 live 报表有原 SQL 可下钻） */}
      {drillTarget && (
        <DrillModal
          open={drillOpen}
          onClose={() => {
            setDrillOpen(false);
            setDrillTarget(null);
          }}
          dataSourceId={activeReport.dataSourceId}
          originalSql={activeReport.executedSqls?.[drillTarget.idx] || ''}
          dimensionKey={drillTarget.dimKey}
          dimensionValue={drillTarget.dimValue}
          dimensionLabel={activeReport.charts[drillTarget.idx]?.chartConfig.xAxisName}
        />
      )}
    </div>
  );
};
