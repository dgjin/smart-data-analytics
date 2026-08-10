import React, { useMemo, useState } from 'react';
import {
  Sparkles,
  FileSpreadsheet,
  TrendingUp,
  Boxes,
  Users,
  Building2,
  Plus,
  Loader2,
  History,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { apiFetch } from '../../api/client';
import { ExecutiveReportCard } from './ExecutiveReportCard';
import { SavedReport } from '../../types/analytics';
import { generateSchemaSuggestions } from '../../utils/querySuggestions';

import { scanReportForAnomalies } from '../../utils/anomalyDetector';

export const ReportGenerator: React.FC = () => {
  const {
    savedReports,
    addSavedReport,
    deleteSavedReport,
    activeDataSourceId,
    dataSources,
  } = useAnalyticsStore();
  const user = useAuthStore((s) => s.user);
  // VIEWER 只读角色无报表生成权限（服务端同样强制 403）
  const canGenerate = user?.role === 'ADMIN' || user?.role === 'ANALYST';

  const [templateType, setTemplateType] = useState('综合经营分析');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [activeReportIndex, setActiveReportIndex] = useState<number>(0);

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);
  // L7 AI 开关：数据源被停用（disconnected）时禁用报表生成入口（服务端同样强制 403）
  const aiSwitchOff = activeDS?.status === 'disconnected';
  // 自定义侧重点占位示例：取自所选数据源的真实表结构（应用问数范围过滤）
  const promptHint = useMemo(() => {
    if (!activeDS) return '';
    const first = generateSchemaSuggestions(activeDS.tables, activeDS.scope, 1)[0] || '';
    return first.length > 30 ? `${first.slice(0, 30)}...` : first;
  }, [activeDS]);

  const templates = [
    {
      id: '综合经营分析',
      label: '综合经营与营收增长简报',
      icon: TrendingUp,
      desc: '全面评估月度销售额、净利润、毛利率及多渠道营收贡献比。',
    },
    {
      id: '营销ROI评估',
      label: '营销渠道投放与ROI评估',
      icon: Users,
      desc: '诊断信息流、搜索竞价、社媒种草各渠道线索获取成本与回报率。',
    },
    {
      id: '供应链与库存分析',
      label: '供应链效率与库存风险',
      icon: Boxes,
      desc: '识别低于安全水位的缺货SKU，评估周转天数与滞销品清理方案。',
    },
    {
      id: '企业战略决策简报',
      label: '高管季度战略决策报告',
      icon: Building2,
      desc: '面向CEO/CFO的高管摘要，包含归因诊断、风险预警与战略落地方案。',
    },
  ];

  const handleGenerateReport = async () => {
    setIsGenerating(true);
    setGenerateError(null);

    try {
      const response = await apiFetch('/api/report/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateType,
          customPrompt,
          dataSourceId: activeDataSourceId,
        }),
      });

      const data = await response.json();

      if (data.success && data.report) {
        const rawReport: SavedReport = {
          id: `report-${Date.now()}`,
          title: data.report.title || `${templateType} - 决策简报`,
          summary: data.report.summary || '已根据数据源生成AI可视化分析报告。',
          createdAt: data.report.createdAt || new Date().toISOString().split('T')[0],
          dataSourceId: activeDataSourceId,
          templateType: 'executive',
          insights: data.report.insights || [],
          kpiList: data.report.kpiList || [],
          charts: data.report.charts || [],
        };

        const scannedReport = scanReportForAnomalies(rawReport);
        addSavedReport(scannedReport);
        setActiveReportIndex(0);
      } else {
        // 透出服务端防御层拒绝原因（注入/频率超限/数据源停用等）
        setGenerateError(data.error || '报表生成失败，请稍后重试');
      }
    } catch (err: any) {
      console.error('Report Generation Failed:', err);
      setGenerateError(err?.message || '网络异常，报表生成失败');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 md:p-8 space-y-8">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-indigo-950 via-slate-900 to-slate-900 border border-indigo-500/30 rounded-3xl p-6 md:p-8 space-y-4 shadow-2xl">
        <div className="flex items-center space-x-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider flex-wrap gap-y-1">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span>AI 自动生成高管可视化报表</span>
          <span className="text-slate-600">|</span>
          <span className="px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-bold">
            一键同比 / 环比分析与差异百分比标记
          </span>
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">
            2x 矢量高清 PDF 文档导出
          </span>
        </div>
        <h1 className="text-2xl md:text-3xl font-extrabold text-slate-100 tracking-tight">
          智能报表构建器 (Visual Report Studio)
        </h1>
        <p className="text-xs md:text-sm text-slate-300 max-w-3xl leading-relaxed">
          依托 Gemini AI 自然语言与全量数仓 Schema，选择报告模版并定制关切指标，系统将自动聚合并生成包含高管摘要、KPI指标卡、归因洞察及可视化图表的印刷级决策简报。
        </p>

        {/* Template Selector Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
          {templates.map((tpl) => {
            const Icon = tpl.icon;
            const isSelected = templateType === tpl.id;
            return (
              <div
                key={tpl.id}
                onClick={() => setTemplateType(tpl.id)}
                className={`p-4 rounded-2xl border cursor-pointer transition-all space-y-2 ${
                  isSelected
                    ? 'bg-indigo-600/20 border-indigo-500 text-slate-100 shadow-lg shadow-indigo-500/10'
                    : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div
                    className={`p-2 rounded-xl ${
                      isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  {isSelected && (
                    <span className="text-[10px] bg-indigo-500 text-white px-2 py-0.5 rounded-full font-bold">
                      已选择
                    </span>
                  )}
                </div>
                <div className="font-bold text-xs text-slate-200">{tpl.label}</div>
                <div className="text-[11px] text-slate-400 leading-snug">{tpl.desc}</div>
              </div>
            );
          })}
        </div>

        {/* Custom Prompt & Trigger */}
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <input
            type="text"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={
              aiSwitchOff
                ? '该数据源的问数功能已停用'
                : promptHint
                  ? `自定义关注侧重点（如：${promptHint}）`
                  : '自定义关注侧重点（可选）'
            }
            maxLength={500}
            disabled={aiSwitchOff}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <button
            onClick={handleGenerateReport}
            disabled={isGenerating || !canGenerate || aiSwitchOff}
            title={aiSwitchOff ? '该数据源的智能问数已被管理员停用' : canGenerate ? '' : '只读角色无报表生成权限'}
            className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-cyan-500 hover:from-indigo-500 hover:to-cyan-400 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/30 transition-all shrink-0"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>AI 正在计算生成报表...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>立即生成决策报表</span>
              </>
            )}
          </button>
        </div>

        {/* Generation Error Notice（透出服务端防御层拒绝原因） */}
        {generateError && (
          <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{generateError}</span>
          </div>
        )}
      </div>

      {/* Generated Reports List & Active View */}
      {savedReports.length > 0 ? (
        <div className="space-y-4">
          {/* Saved Reports Tab Selector */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center space-x-2 text-slate-300 font-bold text-sm">
              <History className="w-4 h-4 text-indigo-400" />
              <span>已生成的历史报表列表 ({savedReports.length})</span>
            </div>

            <div className="flex items-center space-x-1 overflow-x-auto">
              {savedReports.map((rep, idx) => (
                <button
                  key={rep.id}
                  onClick={() => setActiveReportIndex(idx)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    activeReportIndex === idx
                      ? 'bg-indigo-600 text-white shadow'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  {rep.title.slice(0, 12)}...
                </button>
              ))}
            </div>
          </div>

          {/* Active Report Card */}
          {savedReports[activeReportIndex] && (
            <ExecutiveReportCard
              report={savedReports[activeReportIndex]}
              onDelete={() => deleteSavedReport(savedReports[activeReportIndex].id)}
            />
          )}
        </div>
      ) : (
        <div className="p-12 text-center bg-slate-900/50 border border-slate-800 rounded-3xl space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-800 text-indigo-400 flex items-center justify-center mx-auto">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-slate-200 text-sm">暂无已生成的报表</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            请在上方选择一个模版并点击“立即生成决策报表”，Gemini 将为你自动分析并构建包含图表与策略建议的完整简报。
          </p>
        </div>
      )}
    </div>
  );
};
