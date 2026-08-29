import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  FileSpreadsheet,
  TrendingUp,
  ShieldAlert,
  Coins,
  Building2,
  Plus,
  Loader2,
  History,
  Trash2,
  AlertTriangle,
  ClipboardList,
  CheckCircle2,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { useEngineInfo } from '../../hooks/useEngineInfo';
import { apiFetch } from '../../api/client';
import { ExecutiveReportCard } from './ExecutiveReportCard';
import { SavedReport } from '../../types/analytics';
import { generateSchemaSuggestions } from '../../utils/querySuggestions';

import { scanReportForAnomalies } from '../../utils/anomalyDetector';
import { pollTask } from '../../utils/asyncTask';
import { useDataVersion } from '../../hooks/useDataVersion';

// v0.5.2 金额单位：读取问数页选定的口径（localStorage 共享键），报告生成沿用同一单位
const AMOUNT_UNIT_KEY = 'app-amount-unit';
const readAmountUnit = (): string | undefined => {
  try {
    const v = localStorage.getItem(AMOUNT_UNIT_KEY) || '';
    return ['亿元', '百万元', '万元', '元'].includes(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

export const ReportGenerator: React.FC = () => {
  const {
    savedReports,
    addSavedReport,
    replaceSavedReport,
    deleteSavedReport,
    activeDataSourceId,
    dataSources,
  } = useAnalyticsStore();
  const user = useAuthStore((s) => s.user);
  const engine = useEngineInfo();
  const engineName = engine?.model || 'AI';
  // VIEWER 只读角色无报表生成权限（服务端同样强制 403）
  const canGenerate = user?.role === 'ADMIN' || user?.role === 'ANALYST';

  const [templateType, setTemplateType] = useState('综合经营分析');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [activeReportIndex, setActiveReportIndex] = useState<number>(0);

  // M4 报告计划模式：先生成查询计划供批准，再携带 reportPlanId 生成报表（localStorage 持久化）
  const REPORT_PLAN_MODE_KEY = 'app-report-plan-mode';
  const [planMode, setPlanMode] = useState<boolean>(() => localStorage.getItem(REPORT_PLAN_MODE_KEY) === '1');
  const [isPlanning, setIsPlanning] = useState<boolean>(false);
  const [pendingPlan, setPendingPlan] = useState<{
    reportPlanId: string;
    plan: { reportTitle: string; plans: { title: string; sql: string; chartType: string; purpose: string }[] };
  } | null>(null);

  useEffect(() => {
    localStorage.setItem(REPORT_PLAN_MODE_KEY, planMode ? '1' : '0');
  }, [planMode]);

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);

  // v0.4.8 自主更新：监测当前查看的 live 报表所属数据源，检测到数据变化时按原自定义要求重新生成并就地替换
  const activeReport = savedReports[activeReportIndex];
  const watchedReportDsId =
    canGenerate && activeReport && activeReport.dataProvenance === 'live' ? activeReport.dataSourceId : undefined;
  const [autoRegenerating, setAutoRegenerating] = useState(false);
  const [autoRegenMsg, setAutoRegenMsg] = useState<string | null>(null);
  const reportGenStateRef = useRef({ isGenerating, pendingPlan });
  reportGenStateRef.current = { isGenerating, pendingPlan };
  const activeReportRef = useRef(activeReport);
  activeReportRef.current = activeReport;
  useDataVersion(watchedReportDsId, () => {
    void autoRegenerateActiveReport();
  });

  async function autoRegenerateActiveReport(): Promise<void> {
    // 与手动生成/待批准计划互斥，避免并发重复生成
    if (reportGenStateRef.current.isGenerating || reportGenStateRef.current.pendingPlan) return;
    const original = activeReportRef.current;
    if (!original || original.dataProvenance !== 'live' || !original.dataSourceId) return;
    setAutoRegenerating(true);
    setAutoRegenMsg(null);
    try {
      // v0.9.2 异步化：提交即返回 taskId，后台 worker 执行后轮询取结果
      const response = await apiFetch('/api/report/generate/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateType,
          customPrompt: original.customPrompt || '',
          dataSourceId: original.dataSourceId,
          amountUnit: readAmountUnit(), // v0.5.2 金额单位与问数选定口径一致
        }),
      });
      const submitted = await response.json().catch(() => null);
      if (!response.ok || !submitted?.taskId) {
        setAutoRegenMsg('检测到数据变化，但报表自动重生成提交失败（可点击生成手动重试）');
        return;
      }
      const task = await pollTask(submitted.taskId);
      const data = task.result || {};
      if (data.success && data.report) {
        const fresh: SavedReport = {
          ...original,
          title: data.report.title || original.title,
          summary: data.report.summary || original.summary,
          createdAt: data.report.createdAt || new Date().toISOString().split('T')[0],
          insights: data.report.insights || [],
          kpiList: data.report.kpiList || [],
          charts: data.report.charts || [],
          ...(Array.isArray(data.report.executedSqls) ? { executedSqls: data.report.executedSqls } : {}),
          comments: original.comments, // 数据刷新不清空已有批注
        };
        replaceSavedReport(original.id, scanReportForAnomalies(fresh));
        setAutoRegenMsg(`检测到数据变化，已自动重新生成报表「${original.title}」`);
      } else {
        setAutoRegenMsg('检测到数据变化，但报表自动重生成失败（可点击生成手动重试）');
      }
    } catch {
      setAutoRegenMsg('检测到数据变化，但报表自动重生成失败（可点击生成手动重试）');
    } finally {
      setAutoRegenerating(false);
    }
  }
  // 仅数据库型且未停用的数据源支持报表计划模式（与服务端 canPlan 判定一致）
  const canPlanMode = !!activeDS && ['mysql', 'postgresql', 'greenplum'].includes(activeDS.type) && activeDS.status !== 'disconnected';
  // L7 AI 开关：数据源被停用（disconnected）时禁用报表生成入口（服务端同样强制 403）
  const aiSwitchOff = activeDS?.status === 'disconnected';
  // 自定义侧重点占位示例：取自所选数据源的真实表结构（应用问数范围过滤）
  const promptHint = useMemo(() => {
    if (!activeDS) return '';
    const first = generateSchemaSuggestions(activeDS.tables, activeDS.scope, 1)[0] || '';
    return first.length > 30 ? `${first.slice(0, 30)}...` : first;
  }, [activeDS]);

  // 报表模板：贴合不良资产经营分析场景，templateType 会作为报表主题传给 LLM 规划查询
  const templates = [
    {
      id: '综合经营分析',
      label: '不良资产综合经营分析简报',
      icon: TrendingUp,
      desc: '投放规模与逐月趋势、业务分类结构、机构分布及长龄/逾期资产质量的月末快照综合盘点。',
    },
    {
      id: '资产质量与风险监控',
      label: '资产质量与风险监控简报',
      icon: ShieldAlert,
      desc: '聚焦长龄业务占比与机构分布、逾期金额按业务分类分布及风险项目机构分布。',
    },
    {
      id: '投资收益与财务分析',
      label: '投资收益与财务效能简报',
      icon: Coins,
      desc: '基于财务宽表（核算版），按科目一级分类与月度分析投资收益、利息收入等财务效能指标。',
    },
    {
      id: '企业战略决策简报',
      label: '高管季度战略决策报告',
      icon: Building2,
      desc: '面向CEO/CFO的高管摘要，包含不良资产业务归因诊断、风险预警与战略落地方案。',
    },
  ];

  const handleGenerateReport = async (reportPlanId?: string) => {
    setIsGenerating(true);
    setGenerateError(null);

    try {
      // v0.9.2 异步化（改进计划 2-1）：提交即返回 taskId，worker 独立并发执行，前端轮询进度；
      // 生成期间不占用户交互并发槽
      const response = await apiFetch('/api/report/generate/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateType,
          customPrompt,
          dataSourceId: activeDataSourceId,
          amountUnit: readAmountUnit(), // v0.5.2 金额单位与问数选定口径一致
          ...(reportPlanId ? { reportPlanId } : {}),
        }),
      });

      const submitted = await response.json().catch(() => null);
      if (!response.ok || !submitted?.taskId) {
        // 透出服务端防御层拒绝原因（注入/频率超限/在途任务过多等）
        setGenerateError(submitted?.error || '报表任务提交失败，请稍后重试');
        return;
      }

      let data: any;
      try {
        const task = await pollTask(submitted.taskId);
        data = task.result || {};
      } catch (taskErr: any) {
        // 计划失效（409 等价场景在 worker 内发生）：清空待批准计划，允许重新制定
        if (reportPlanId) setPendingPlan(null);
        throw taskErr;
      }

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
          // P2-2 下钻：live 链路各图表对应的原聚合 SQL（与 charts 顺序对齐）
          ...(Array.isArray(data.report.executedSqls) ? { executedSqls: data.report.executedSqls } : {}),
          // v0.4.8 自主更新：记录自定义要求与数据来源，数据变化时按同参数重新生成
          ...(customPrompt.trim() ? { customPrompt: customPrompt.trim() } : {}),
          dataProvenance: data.dataProvenance === 'simulated' ? 'simulated' : 'live',
        };

        const scannedReport = scanReportForAnomalies(rawReport);
        addSavedReport(scannedReport);
        setActiveReportIndex(0);
        setPendingPlan(null);
      } else {
        // 透出任务结果中的失败原因
        setGenerateError(data.error || '报表生成失败，请稍后重试');
        if (reportPlanId) setPendingPlan(null);
      }
    } catch (err: any) {
      console.error('Report Generation Failed:', err);
      setGenerateError(err?.message || '网络异常，报表生成失败');
    } finally {
      setIsGenerating(false);
    }
  };

  // M4：计划模式下先请求报表查询计划（不执行），展示卡片待批准
  const handleRequestPlan = async () => {
    setIsPlanning(true);
    setGenerateError(null);
    try {
      const response = await apiFetch('/api/report/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateType, customPrompt, dataSourceId: activeDataSourceId, amountUnit: readAmountUnit() }),
      });
      const data = await response.json();
      if (data.success && data.reportPlanId && data.plan) {
        setPendingPlan({ reportPlanId: data.reportPlanId, plan: data.plan });
      } else {
        setGenerateError(data.error || '报表查询计划生成失败，请稍后重试');
      }
    } catch (err: any) {
      console.error('Report Plan Failed:', err);
      setGenerateError(err?.message || '网络异常，计划生成失败');
    } finally {
      setIsPlanning(false);
    }
  };

  // 生成入口：计划模式先制定计划，否则直接生成
  const handleStartGenerate = () => {
    if (pendingPlan) return;
    if (planMode && canPlanMode) {
      handleRequestPlan();
    } else {
      handleGenerateReport();
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
          {/* v0.4.8 自主更新：数据源变化自动重新生成报表的状态标识 */}
          {(autoRegenerating || autoRegenMsg) && (
            <span
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${
                autoRegenerating
                  ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30 animate-pulse'
                  : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
              }`}
            >
              {autoRegenerating ? '检测到数据变化，正在自动重新生成报表…' : autoRegenMsg}
            </span>
          )}
        </div>
        <h1 className="text-2xl md:text-3xl font-extrabold text-slate-100 tracking-tight">
          智能报表构建器 (Visual Report Studio)
        </h1>
        <p className="text-xs md:text-sm text-slate-300 max-w-3xl leading-relaxed">
          依托 {engine?.label || 'AI 大模型'} 自然语言能力与全量数仓 Schema，选择报告模版并定制关切指标，系统将自动聚合并生成包含高管摘要、KPI指标卡、归因洞察及可视化图表的印刷级决策简报。
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

          {/* M4 报表计划模式开关（仅数据库型数据源可用，localStorage 持久化） */}
          {canPlanMode && (
            <button
              onClick={() => setPlanMode((v) => !v)}
              disabled={isGenerating || isPlanning}
              title="开启后先生成查询计划供你批准，再执行生成报表"
              className={`px-3.5 py-3 rounded-xl border text-xs font-bold flex items-center space-x-1.5 transition-all shrink-0 ${
                planMode
                  ? 'bg-violet-600/25 border-violet-500 text-violet-200 shadow-sm'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              <span>{planMode ? '先制定计划：开' : '先制定计划：关'}</span>
            </button>
          )}

          <button
            onClick={handleStartGenerate}
            disabled={isGenerating || isPlanning || !canGenerate || aiSwitchOff || !!pendingPlan}
            title={aiSwitchOff ? '该数据源的智能问数已被管理员停用' : canGenerate ? '' : '只读角色无报表生成权限'}
            className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-cyan-500 hover:from-indigo-500 hover:to-cyan-400 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/30 transition-all shrink-0"
          >
            {isGenerating || isPlanning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isPlanning ? 'AI 正在制定查询计划...' : 'AI 正在计算生成报表...'}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>{planMode && canPlanMode ? '制定报表计划' : '立即生成决策报表'}</span>
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

        {/* M4 报表查询计划卡片：批准后携带 reportPlanId 生成，10 分钟内有效 */}
        {pendingPlan && (
          <div className="p-4 rounded-2xl bg-violet-950/40 border border-violet-500/40 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center space-x-2 text-violet-200 text-xs font-bold">
                <ClipboardList className="w-4 h-4" />
                <span>报表查询计划{pendingPlan.plan.reportTitle ? `：${pendingPlan.plan.reportTitle}` : ''}（批准后执行，10 分钟内有效）</span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => handleGenerateReport(pendingPlan.reportPlanId)}
                  disabled={isGenerating}
                  className="px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold flex items-center space-x-1.5"
                >
                  {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>{isGenerating ? '正在按计划生成...' : '批准并生成报表'}</span>
                </button>
                <button
                  onClick={() => setPendingPlan(null)}
                  disabled={isGenerating}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs"
                >
                  取消
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {pendingPlan.plan.plans.map((q, i) => (
                <div key={i} className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 text-[11px] space-y-1">
                  <div className="text-slate-200 font-bold">
                    {i + 1}. {q.title}
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 text-[10px]">{q.chartType}</span>
                  </div>
                  {q.purpose && <div className="text-slate-400">目的：{q.purpose}</div>}
                  <pre className="text-cyan-300/90 bg-slate-900 rounded-lg p-1.5 overflow-x-auto whitespace-pre-wrap break-all">{q.sql}</pre>
                </div>
              ))}
            </div>
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
            请在上方选择一个模版并点击“立即生成决策报表”，{engineName} 将为你自动分析并构建包含图表与策略建议的完整简报。
          </p>
        </div>
      )}
    </div>
  );
};
