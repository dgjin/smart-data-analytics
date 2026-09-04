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
  Settings2,
} from 'lucide-react';
import { useAnalyticsStore, DEMO_REPORT } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { useEngineInfo } from '../../hooks/useEngineInfo';
import { resolveAmountUnit, AMOUNT_UNITS } from '../../hooks/useAmountUnitStore';
import { AmountUnitSelect } from '../common/AmountUnitSelect';
import { resolveReportGenParams, canRegenerateReport, applyRegenResult } from '../../utils/reportRegen';
import { apiFetch } from '../../api/client';
import { ExecutiveReportCard } from './ExecutiveReportCard';
import { SavedReport } from '../../types/analytics';
import { generateSchemaSuggestions } from '../../utils/querySuggestions';

import { scanReportForAnomalies } from '../../utils/anomalyDetector';
import { pollTask } from '../../utils/asyncTask';
import { useDataVersion } from '../../hooks/useDataVersion';

// v0.5.4 金额单位：由 useAmountUnitStore 统一管理（全局默认 + 模块覆盖），
// 报表模块生效单位 = 模块内选择（优先）或全局设置（Header 维护）；提交时实时读取，避免闭包过期
const readAmountUnit = (): string => resolveAmountUnit('report');

export const ReportGenerator: React.FC = () => {
  const {
    savedReports,
    createSavedReportRemote,
    updateSavedReportRemote,
    removeSavedReportRemote,
    initSavedReports,
    demoReportDismissed,
    dismissDemoReport,
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

  // v0.9.22 历史报表维护：修改条件重新生成编辑器状态（作用于当前选中的历史报表）
  const [regenEditor, setRegenEditor] = useState<{
    reportId: string;
    templateType: string;
    customPrompt: string;
    amountUnit: string;
  } | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

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

  // v0.9.23 服务端持久化：登录就绪后初始化历史报表（迁移本地遗留 → 拉取服务端权威列表，会话内一次）
  useEffect(() => {
    if (user) void initSavedReports();
  }, [user, initSavedReports]);

  // v0.9.23：服务端无报表且未手动隐藏时，展示内置演示报表（纯前端，不落库）
  const displayReports = useMemo(
    () => (savedReports.length > 0 ? savedReports : demoReportDismissed ? [] : [DEMO_REPORT]),
    [savedReports, demoReportDismissed]
  );

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);

  // v0.4.8 自主更新：监测当前查看的 live 报表所属数据源，检测到数据变化时按原自定义要求重新生成并就地替换
  const activeReport = displayReports[activeReportIndex];
  const watchedReportDsId =
    canGenerate && activeReport && activeReport.dataProvenance === 'live' ? activeReport.dataSourceId : undefined;
  const [autoRegenerating, setAutoRegenerating] = useState(false);
  const [autoRegenMsg, setAutoRegenMsg] = useState<string | null>(null);
  const reportGenStateRef = useRef({ isGenerating, pendingPlan, regenBusy, regenEditorOpen: regenEditor !== null });
  reportGenStateRef.current = { isGenerating, pendingPlan, regenBusy, regenEditorOpen: regenEditor !== null };
  const activeReportRef = useRef(activeReport);
  activeReportRef.current = activeReport;
  useDataVersion(watchedReportDsId, () => {
    void autoRegenerateActiveReport();
  });

  async function autoRegenerateActiveReport(): Promise<void> {
    // 与手动生成/待批准计划/重新生成编辑器互斥，避免并发重复生成或覆盖用户正在编辑的条件
    const st = reportGenStateRef.current;
    if (st.isGenerating || st.pendingPlan || st.regenBusy || st.regenEditorOpen) return;
    const original = activeReportRef.current;
    if (!original || original.dataProvenance !== 'live' || !original.dataSourceId) return;
    setAutoRegenerating(true);
    setAutoRegenMsg(null);
    try {
      // v0.9.22：按原报表生成条件快照重新生成（修复此前错用组件当前模板 state 的口径漂移）；
      // 旧版报表无快照时回退当前模板与模块生效单位
      const params = resolveReportGenParams(original, templateType, readAmountUnit());
      // v0.9.2 异步化：提交即返回 taskId，后台 worker 执行后轮询取结果
      const response = await apiFetch('/api/report/generate/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateType: params.templateType,
          customPrompt: params.customPrompt,
          dataSourceId: params.dataSourceId,
          amountUnit: params.amountUnit, // v0.5.2 金额单位与问数选定口径一致
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
        // v0.9.22：统一走 applyRegenResult（就地替换、保留批注、同步更新条件快照）
        const fresh = applyRegenResult(original, data.report, params, data.dataProvenance === 'simulated' ? 'simulated' : 'live');
        // v0.9.23 服务端持久化：就地替换并同步服务端，失败回滚本地
        updateSavedReportRemote(original.id, scanReportForAnomalies(fresh))
          .then(() => setAutoRegenMsg(`检测到数据变化，已自动重新生成报表「${original.title}」`))
          .catch(() => setAutoRegenMsg('检测到数据变化，已重新生成但同步到服务器失败（可手动重新生成重试）'));
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
          // v0.9.22 报表维护：完整生成条件快照（主题/要求/金额单位），供「修改条件重新生成」预填与自动重生成取参
          genParams: { templateType, customPrompt: customPrompt.trim(), amountUnit: readAmountUnit() },
          dataProvenance: data.dataProvenance === 'simulated' ? 'simulated' : 'live',
        };

        const scannedReport = scanReportForAnomalies(rawReport);
        // v0.9.23 服务端持久化：生成成本高，保存失败保留本地并明确提示（刷新后未保存的报表将丢失）
        createSavedReportRemote(scannedReport).catch((err) => {
          setGenerateError(`报表已生成，但保存到服务器失败（刷新后将丢失）：${err?.message || err}`);
        });
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

  // ---------- v0.9.22 历史报表维护：修改条件重新生成 + 删除 ----------

  /** 打开「修改条件重新生成」编辑器：以该报表的生成条件快照预填（旧报表回退当前模板与模块生效单位） */
  const openRegenEditor = (rep: SavedReport) => {
    const params = resolveReportGenParams(rep, templateType, readAmountUnit());
    // 防御：快照主题不在模板列表内时回退首个模板（历史模板下线等场景）
    const validTemplate = templates.some((t) => t.id === params.templateType) ? params.templateType : templates[0].id;
    setRegenEditor({ reportId: rep.id, templateType: validTemplate, customPrompt: params.customPrompt, amountUnit: params.amountUnit || '亿元' });
    setRegenError(null);
  };

  /** 提交修改后的条件重新生成：复用异步生成端点，成功后就地替换原报表（保留 id 与批注） */
  const submitRegen = async () => {
    if (!regenEditor || regenBusy) return;
    const target = savedReports.find((r) => r.id === regenEditor.reportId);
    if (!canRegenerateReport(target, canGenerate)) {
      setRegenError('仅真实数据源生成的报表支持重新生成（演示报表请重新新建）');
      return;
    }
    setRegenBusy(true);
    setRegenError(null);
    try {
      const response = await apiFetch('/api/report/generate/async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateType: regenEditor.templateType,
          customPrompt: regenEditor.customPrompt,
          dataSourceId: target!.dataSourceId,
          amountUnit: regenEditor.amountUnit,
        }),
      });
      const submitted = await response.json().catch(() => null);
      if (!response.ok || !submitted?.taskId) {
        setRegenError(submitted?.error || '重新生成任务提交失败，请稍后重试');
        return;
      }
      const task = await pollTask(submitted.taskId);
      const data = task.result || {};
      if (data.success && data.report) {
        const fresh = applyRegenResult(
          target!,
          data.report,
          { templateType: regenEditor.templateType, customPrompt: regenEditor.customPrompt, amountUnit: regenEditor.amountUnit, dataSourceId: target!.dataSourceId },
          data.dataProvenance === 'simulated' ? 'simulated' : 'live'
        );
        // v0.9.23 服务端持久化：就地替换并同步服务端（失败回滚本地并提示）
        updateSavedReportRemote(target!.id, scanReportForAnomalies(fresh))
          .then(() => setRegenEditor(null))
          .catch((err) => setRegenError(`已重新生成，但同步到服务器失败：${err?.message || err}`));
      } else {
        setRegenError(data.error || '重新生成失败，请稍后重试');
      }
    } catch (err: any) {
      setRegenError(err?.message || '网络异常，重新生成失败');
    } finally {
      setRegenBusy(false);
    }
  };

  /** 删除历史报表：确认后删除（演示报表仅本地隐藏）；服务端删除失败时回滚本地并提示；删除后当前查看索引前移钳制 */
  const handleDeleteReport = (rep: SavedReport) => {
    if (!window.confirm(`确定删除报表「${rep.title}」吗？删除后不可恢复。`)) return;
    if (regenEditor?.reportId === rep.id) setRegenEditor(null);
    // v0.9.23：内置演示报表不落库，删除仅本地隐藏（persist 标记，刷新不再出现）
    if (rep.id === DEMO_REPORT.id) {
      dismissDemoReport();
      setActiveReportIndex(0);
      return;
    }
    removeSavedReportRemote(rep.id).catch((err) => alert(err?.message || '删除失败，请稍后重试'));
    const newLen = displayReports.length - 1;
    if (activeReportIndex > newLen - 1) setActiveReportIndex(Math.max(0, newLen - 1));
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

          {/* 金额单位：默认跟随全局，可单独选择本模块口径（优先于全局设置） */}
          <AmountUnitSelect module="report" />

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
      {displayReports.length > 0 ? (
        <div className="space-y-4">
          {/* Saved Reports Tab Selector + v0.9.22 维护操作（作用于当前选中报表） */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-3 gap-3 flex-wrap">
            <div className="flex items-center space-x-2 text-slate-300 font-bold text-sm flex-wrap gap-y-2">
              <History className="w-4 h-4 text-indigo-400" />
              <span>已生成的历史报表列表 ({displayReports.length})</span>
              {/* 维护操作：修改条件重新生成（仅 live 报表）+ 删除 */}
              {activeReport && (
                <span className="flex items-center space-x-1.5 ml-2">
                  <button
                    onClick={() => openRegenEditor(activeReport)}
                    disabled={!canRegenerateReport(activeReport, canGenerate) || isGenerating || regenBusy || regenEditor !== null}
                    title={
                      canRegenerateReport(activeReport, canGenerate)
                        ? '修改报表主题/关注点/金额单位后重新生成，就地替换当前报表（数据源不变，批注保留）'
                        : '仅真实数据源生成的报表支持重新生成（演示报表请重新新建）'
                    }
                    className="px-2.5 py-1 rounded-lg bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-600/35 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-semibold flex items-center space-x-1 transition-colors"
                  >
                    <Settings2 className="w-3 h-3" />
                    <span>修改条件重新生成</span>
                  </button>
                  <button
                    onClick={() => handleDeleteReport(activeReport)}
                    disabled={regenBusy}
                    title="删除该历史报表（不可恢复）"
                    className="px-2.5 py-1 rounded-lg bg-rose-600/15 border border-rose-500/40 text-rose-300 hover:bg-rose-600/30 disabled:opacity-40 text-[11px] font-semibold flex items-center space-x-1 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>删除</span>
                  </button>
                </span>
              )}
            </div>

            <div className="flex items-center space-x-1 overflow-x-auto">
              {displayReports.map((rep, idx) => (
                <button
                  key={rep.id}
                  onClick={() => { setActiveReportIndex(idx); setRegenEditor(null); setRegenError(null); }}
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

          {/* v0.9.22 修改条件重新生成编辑器：预填该报表生成条件快照，提交后就地替换 */}
          {regenEditor && (
            <div className="p-4 rounded-2xl bg-cyan-950/25 border border-cyan-500/30 space-y-3 animate-fadeIn">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center space-x-2 text-cyan-200 text-xs font-bold">
                  <Settings2 className="w-4 h-4" />
                  <span>修改条件重新生成（就地替换当前报表，数据源不变，已有批注保留）</span>
                </div>
                <span className="text-[10px] text-slate-500">
                  数据源：{dataSources.find((d) => d.id === displayReports.find((r) => r.id === regenEditor.reportId)?.dataSourceId)?.name || '原报表数据源'}
                </span>
              </div>
              <div className="flex flex-col lg:flex-row lg:items-center gap-2 text-xs">
                <select
                  value={regenEditor.templateType}
                  onChange={(e) => setRegenEditor({ ...regenEditor, templateType: e.target.value })}
                  disabled={regenBusy}
                  title="报表主题模板"
                  className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={regenEditor.customPrompt}
                  onChange={(e) => setRegenEditor({ ...regenEditor, customPrompt: e.target.value })}
                  placeholder="自定义关注侧重点（可选）"
                  maxLength={500}
                  disabled={regenBusy}
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 disabled:opacity-60"
                />
                <select
                  value={regenEditor.amountUnit}
                  onChange={(e) => setRegenEditor({ ...regenEditor, amountUnit: e.target.value })}
                  disabled={regenBusy}
                  title="金额单位（本次重新生成生效）"
                  className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                >
                  {AMOUNT_UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
                <button
                  onClick={() => void submitRegen()}
                  disabled={regenBusy}
                  className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center space-x-1.5 transition-colors shrink-0"
                >
                  {regenBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  <span>{regenBusy ? 'AI 正在重新生成…' : '按新条件重新生成'}</span>
                </button>
                <button
                  onClick={() => { setRegenEditor(null); setRegenError(null); }}
                  disabled={regenBusy}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs shrink-0"
                >
                  取消
                </button>
              </div>
              {regenError && (
                <p className="text-xs text-rose-400 flex items-center space-x-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{regenError}</span>
                </p>
              )}
            </div>
          )}

          {/* Active Report Card */}
          {activeReport && (
            <ExecutiveReportCard
              report={activeReport}
              onDelete={() => handleDeleteReport(activeReport)}
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
