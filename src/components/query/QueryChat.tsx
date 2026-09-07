import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Send,
  Sparkles,
  Bot,
  Trash2,
  Search,
  ArrowUpRight,
  Mic,
  MicOff,
  Volume2,
  ShieldCheck,
  Library,
  History,
  Download,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { useModelCatalog } from '../../hooks/useModelCatalog';
import { apiFetch } from '../../api/client';
import { applyDataScope } from '../../utils/dataScope';
import { buildQueryPlaceholder, generateSchemaSuggestions } from '../../utils/querySuggestions';
import { SQLPreviewModal } from './SQLPreviewModal';
import { SkillLibraryModal } from './SkillLibraryModal';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { ChatMessageItem } from './ChatMessageItem';
import { QueryModeBar } from './QueryModeBar';
import { SkillMenuButton } from './SkillMenuButton';
import { TraceStepper, TraceStepInfo } from './AnalysisTracePanel';
import { useConversationHistory } from '../../hooks/useConversationHistory';
import { useEffectiveAmountUnit } from '../../hooks/useAmountUnitStore';
import { ReportTemplate } from '../../types/analytics';
import { useSpeechInput } from '../../hooks/useSpeechInput';
import { readSseStream } from '../../utils/sseStream';
import { pollTask } from '../../utils/asyncTask';
import { ChatMessage, QueryPlanData, QueryResultData } from '../../types/analytics';
import { KnowledgeManagementPanel } from '../knowledge/KnowledgeManagementPanel';

// L1 输入层（与服务端 queryGuard.MAX_QUESTION_LENGTH 对齐）：单条提问最大 500 字
const MAX_QUERY_INPUT_LENGTH = 500;
// 模型自选持久化键（值为 "engine::model"，空串表示跟随服务端默认）
const SELECTED_MODEL_KEY = 'app-selected-model';
// 金额单位：由 useAmountUnitStore 统一管理（全局默认 + 模块覆盖，v0.5.4 起）
// M2 计划模式持久化键（'1' = 开启「先制定计划」）
const PLAN_MODE_KEY = 'app-plan-mode';
// M3 深度分析持久化键（'1' = 强制启用中间表清洗链）
const DEEP_ANALYSIS_KEY = 'app-deep-analysis';

export const QueryChat: React.FC = () => {
  const {
    chatMessages,
    addChatMessage,
    currentQuery,
    setCurrentQuery,
    isQueryLoading,
    setQueryLoading,
    dataSources,
    activeDataSourceId,
    loadDataSources,
    pinChartToDashboardRemote,
    updateMessageChartConfig,
    setMessageFeedback,
    clearChat,
    setActiveTab,
    setPendingReportId,
  } = useAnalyticsStore();
  const currentUser = useAuthStore((s) => s.user);

  const [inspectModalResult, setInspectModalResult] = useState<QueryResultData | null>(null);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [toast, setToast] = useState<string | null>(null);
  // P2-A Skills：可复用分析技能（点击填充提问模板，占位符由用户替换后提交）
  const [skills, setSkills] = useState<{ id: string; name: string; description: string; promptTemplate: string }[]>([]);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  // 技能「+」弹出菜单（参照 Qoder IDE「+」交互：点击输入框旁 + 号向上弹出技能选择面板）
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  // 已点选确认的澄清消息 id（确认后禁用选项，防止重复提交）
  const [resolvedClarifications, setResolvedClarifications] = useState<Set<string>>(new Set());
  // P2-7 SSE 流式进度：服务端阶段事件推送的实时状态文案
  const [streamProgress, setStreamProgress] = useState<string | null>(null);
  // P2-1 SQL 先行回显：sql_ready/executed 阶段携带的 SQL，长等待期提前展示
  const [streamPreviewSql, setStreamPreviewSql] = useState<string | null>(null);
  // P1-2 Token 级流式输出：LLM 生成内容的增量缓冲区（打字机效果）
  const [streamingContent, setStreamingContent] = useState<string>('');
  // 当前查询是否正在接收流式内容
  const [isReceivingStream, setIsReceivingStream] = useState<boolean>(false);
  // M1 推导留痕：SSE trace 事件实时追加的步骤链（查询中展示步骤器）
  const [liveTraceSteps, setLiveTraceSteps] = useState<TraceStepInfo[]>([]);
  // M2 计划模式：「先制定计划」开关（localStorage 持久化）；已批准/取消的计划卡片 id 置灰
  const [planMode, setPlanMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PLAN_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [resolvedPlans, setResolvedPlans] = useState<Set<string>>(new Set());
  const togglePlanMode = () => {
    setPlanMode((prev) => {
      const next = !prev;
      try {
        if (next) localStorage.setItem(PLAN_MODE_KEY, '1');
        else localStorage.removeItem(PLAN_MODE_KEY);
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next;
    });
  };
  // P3-1 知识库管理：导入导出面板显示状态
  const [showKnowledgePanel, setShowKnowledgePanel] = useState(false);
  // M3 深度分析：强制启用中间表清洗链（关闭时由服务端复杂度评估自动判定）
  const [deepMode, setDeepMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DEEP_ANALYSIS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleDeepMode = () => {
    setDeepMode((prev) => {
      const next = !prev;
      try {
        if (next) localStorage.setItem(DEEP_ANALYSIS_KEY, '1');
        else localStorage.removeItem(DEEP_ANALYSIS_KEY);
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next;
    });
  };
  // v0.5.0 报告模式：开启后提问直接生成完整报告（支持模板选择或智能推断）
  const REPORT_MODE_KEY = 'app-report-mode';
  const [reportMode, setReportMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(REPORT_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [reportTemplates, setReportTemplates] = useState<ReportTemplate[]>([]);
  const toggleReportMode = () => {
    setReportMode((prev) => {
      const next = !prev;
      try {
        if (next) localStorage.setItem(REPORT_MODE_KEY, '1');
        else localStorage.removeItem(REPORT_MODE_KEY);
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next;
    });
  };
  // 加载报告模板列表
  useEffect(() => {
    if (!reportMode) return;
    (async () => {
      try {
        const res = await apiFetch('/api/report-templates');
        const data = await res.json();
        if (data.ok && Array.isArray(data.templates)) {
          setReportTemplates(data.templates);
        }
      } catch (err) {
        console.error('Failed to load report templates:', err);
      }
    })();
  }, [reportMode]);
  // 模型自选：目录来自 /api/system/models，选择持久化到 localStorage
  const { models: modelCatalog } = useModelCatalog();
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      return localStorage.getItem(SELECTED_MODEL_KEY) || '';
    } catch {
      return '';
    }
  });
  const handleSelectModel = (value: string) => {
    setSelectedModel(value);
    try {
      if (value) localStorage.setItem(SELECTED_MODEL_KEY, value);
      else localStorage.removeItem(SELECTED_MODEL_KEY);
    } catch {
      // 存储不可用时仅本次会话生效
    }
  };

  // 金额单位：模块覆盖优先，未覆盖跟随全局（Header 全局选择器维护），随每次提问生效
  const amountUnit = useEffectiveAmountUnit('query');
  const selectedModelPayload = useMemo(() => {
    const [engine, ...rest] = selectedModel.split('::');
    const model = rest.join('::');
    return engine && model ? { engine, model } : undefined;
  }, [selectedModel]);
  const loadSkills = React.useCallback(() => {
    apiFetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data?.skills)) setSkills(data.skills);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadSkills();
  }, [loadSkills]);
  // 技能「+」菜单：点击面板外部自动关闭
  useEffect(() => {
    if (!skillMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) setSkillMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [skillMenuOpen]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // P1-6 拆分：语音输入 hook（识别文本回填输入框，L1 限 500 字）
  const { isListening, speechError, toggleSpeechRecognition, clearSpeechError } = useSpeechInput((text) =>
    setCurrentQuery(text.slice(0, MAX_QUERY_INPUT_LENGTH))
  );

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  };

  // 复制用户提问到剪贴板（非安全上下文降级 execCommand）
  const handleCopyQuestion = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('问题已复制到剪贴板');
  };

  // 再次编辑：把历史提问回填输入框并聚焦，用户修改后重新发送
  const handleEditQuestion = (content: string) => {
    setCurrentQuery(content);
    inputRef.current?.focus();
  };

  // ---------- 对话历史管理（服务端落库）：P1-6 拆分到 useConversationHistory ----------

  // 导出当前数据源的对话为 Markdown（问题 + 回答 + SQL）
  // —— 已随 useConversationHistory 迁出，见下方 hook 调用

  // P1 反馈闭环：点赞/点踩落库（点赞样例将成为 few-shot 提升后续准确率），成功后置灰
  const handleFeedback = async (msg: ChatMessage, verdict: 'UP' | 'DOWN') => {
    if (msg.feedback) return;
    try {
      const resp = await apiFetch('/api/query/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataSourceId: activeDataSourceId,
          question: msg.question || '',
          sql: msg.queryResult?.generatedSQL || '',
          verdict,
          provenance: msg.dataProvenance || '',
        }),
      });
      if (!resp.ok) throw new Error('feedback failed');
      setMessageFeedback(msg.id, verdict);
      showToast(verdict === 'UP' ? '感谢反馈，该问答已加入样例库' : '感谢反馈，我们会持续优化回答质量');
    } catch {
      showToast('反馈提交失败，请稍后重试');
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);
  // L7 AI 开关：数据源被停用（disconnected）时禁用问数入口（服务端同样强制拒绝）
  const aiSwitchOff = activeDS?.status === 'disconnected';

  // 问数上下文摘要：与实际问数链路同源的服务端单一事实源（scope 白名单 + 敏感列过滤后），
  // 状态条展示的表范围以此为准，避免前端 store 缓存的 tables/scope 过期导致显示与实际不一致
  const [queryContext, setQueryContext] = useState<{
    status: string | null;
    dsType: string | null;
    /** v0.9.34 文件数据源已落应用库物理表（服务端摘要下发），真实执行入口判定与库型源对齐 */
    fileBacked?: boolean;
    tableCount: number;
    tables: { name: string; displayName: string }[];
    sensitiveFiltered: number;
    maxTablesInPrompt: number;
  } | null>(null);
  useEffect(() => {
    if (!activeDataSourceId) return;
    // 进入问数页/切换数据源时顺带刷新 store 数据源（tables/scope 可能已被管理员变更）
    loadDataSources();
    let alive = true;
    apiFetch(`/api/query/context?dataSourceId=${encodeURIComponent(activeDataSourceId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && data?.ok) setQueryContext(data);
      })
      .catch(() => {
        /* 摘要获取失败不影响问数，状态条回退为仅显示数据源名 */
      });
    return () => {
      alive = false;
    };
  }, [activeDataSourceId, loadDataSources]);

  // 对话历史按数据源隔离：仅渲染归属当前源的对话，切换数据源不再混显其他源的问答
  const visibleMessages = useMemo(
    () => chatMessages.filter((m) => (m.dataSourceId ?? '') === (activeDataSourceId || '')),
    [chatMessages, activeDataSourceId]
  );

  // P1-6 拆分：对话历史管理（服务端落库）——搜索 / 重问 / 删除 / 导出，随当前可见对话与数据源联动
  const {
    historyOpen,
    historyItems,
    historyLoading,
    historyKeyword,
    setHistoryKeyword,
    toggleHistoryPanel,
    loadHistory,
    handleDeleteConversation,
    handleExportConversation,
  } = useConversationHistory({ activeDataSourceId, visibleMessages, dataSources, showToast });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [visibleMessages, isQueryLoading]);

  // 推荐问题：管理员登记的专业快速问题优先，其余由真实表结构推导（应用问数范围 scope 过滤，无硬编码示例）
  const schemaSuggestions = useMemo(() => {
    if (!activeDS) return [];
    const curated = Array.isArray(activeDS.quickQuestions) ? activeDS.quickQuestions.filter((q) => typeof q === 'string' && q.trim()) : [];
    const generated = generateSchemaSuggestions(activeDS.tables, activeDS.scope);
    const seen = new Set(curated);
    return [...curated, ...generated.filter((g) => !seen.has(g))];
  }, [activeDS]);

  // Filtered autocomplete suggestions based on current query input prefix
  const filteredSuggestions = useMemo(() => {
    const trimmed = currentQuery.trim().toLowerCase();
    if (!trimmed) return [];

    return schemaSuggestions
      .filter((item) => {
        const itemLower = item.toLowerCase();
        // Match prefix, substring or contains characters
        return (
          itemLower.includes(trimmed) ||
          trimmed.split('').every((char) => itemLower.includes(char))
        );
      })
      .slice(0, 6);
  }, [currentQuery, schemaSuggestions]);

  // 欢迎语跟随当前数据源动态生成（persist 存储的旧欢迎语在渲染时一并被替换）
  const welcomeContent = useMemo(() => {
    if (!activeDS) {
      return '👋 你好！我是企业智能问数据分析助手。请先在「数据源管理」中接入数据库，即可用自然语言直接查询真实业务数据。';
    }
    const examples = schemaSuggestions.slice(0, 3).map((s) => `- "${s}"`).join('\n');
    if (!examples) {
      return `👋 你好！我是企业智能问数据分析助手，已接入【${activeDS.name}】。你可以直接用自然语言向我提问。`;
    }
    return `👋 你好！我是企业智能问数据分析助手，已接入【${activeDS.name}】。你可以直接用自然语言向我提问，例如：\n${examples}`;
  }, [activeDS, schemaSuggestions]);

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(-1);
    if (currentQuery.trim() && filteredSuggestions.length > 0) {
      setIsSuggestionsOpen(true);
    } else {
      setIsSuggestionsOpen(false);
    }
  }, [currentQuery, filteredSuggestions.length]);

  // M2 计划模式：数据库型与已落库文件型数据源均走真实执行链路（与服务端 canPlan 判定一致）
  const canPlanMode = queryContext !== null
    && (['mysql', 'postgresql', 'greenplum'].includes(queryContext.dsType || '') || queryContext.fileBacked === true);

  // Handle NL Query Submission（approvedPlanId：M2 批准计划后携带，服务端校验后按计划执行；
  // options.refreshCache：P1-6 语义缓存命中后用户强制刷新，跳过缓存读取重新走真实链路）
  const handleSendQuery = async (queryText?: string, approvedPlanId?: string, options?: { refreshCache?: boolean }) => {
    const textToSubmit = queryText || currentQuery;
    if (!textToSubmit.trim() || isQueryLoading || aiSwitchOff) return;

    setIsSuggestionsOpen(false);
    setSelectedIndex(-1);

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: 'user',
      content: textToSubmit,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      // 提交时快照归属源：加载期间切换数据源也不会把回答记到新源名下
      dataSourceId: activeDataSourceId,
    };
    const submitDSId = activeDataSourceId;

    // M2 计划模式：开启「先制定计划」且本次未携带已批准 planId 时，先生成分析计划等待批准（不执行）
    if (planMode && !approvedPlanId && canPlanMode) {
      addChatMessage(userMsg);
      setCurrentQuery('');
      setQueryLoading(true);
      try {
        const planResp = await apiFetch('/api/query/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: textToSubmit,
            dataSourceId: activeDataSourceId,
            schema: activeDS ? applyDataScope(activeDS.tables, activeDS.scope) : [],
            ...(selectedModelPayload ? { model: selectedModelPayload } : {}),
            amountUnit,
          }),
        });
        const planData = await planResp.json().catch(() => null);
        if (!planResp.ok || !planData?.success || !planData.plan) {
          throw new Error(planData?.error || '分析计划生成失败');
        }
        addChatMessage({
          id: `msg-plan-${Date.now()}`,
          role: 'assistant',
          content: planData.plan.understanding || '已制定分析计划，请确认后执行。',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          question: textToSubmit,
          queryPlan: planData.plan as QueryPlanData,
          dataSourceId: submitDSId,
        });
      } catch (err: any) {
        addChatMessage({
          id: `msg-err-plan-${Date.now()}`,
          role: 'assistant',
          content: `分析计划生成失败：${err?.message || '请稍后重试'}`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          error: err?.message,
          dataSourceId: submitDSId,
        });
      } finally {
        setQueryLoading(false);
      }
      return;
    }

    // v0.5.0 报告模式：提问直接生成完整报告（模板或智能推断），不落普通查询链路
    // v0.9.2 异步化（改进计划 2-1）：提交即返回 taskId，worker 后台执行，前端轮询任务状态；
    // 生成期间不再占用用户交互并发槽，可继续问数
    if (reportMode && !approvedPlanId) {
      addChatMessage(userMsg);
      setCurrentQuery('');
      setQueryLoading(true);
      try {
        const submitResp = await apiFetch('/api/report/generate-from-query/async', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: textToSubmit,
            dataSourceId: activeDataSourceId,
            amountUnit, // v0.5.2 报告金额单位与问数选定口径一致
            ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
          }),
        });
        const submitted = await submitResp.json().catch(() => null);
        if (!submitResp.ok || !submitted?.taskId) {
          throw new Error(submitted?.error || '报告任务提交失败');
        }
        const task = await pollTask(submitted.taskId);
        const reportData = task.result;
        if (!reportData?.success || !reportData.report) {
          throw new Error('报告生成失败');
        }
        const r = reportData.report;
        // 演示降级数据不入库不可跳转，如实提示
        if (reportData.isFallback === true || reportData.dataProvenance === 'simulated') {
          addChatMessage({
            id: `msg-report-fb-${Date.now()}`,
            role: 'assistant',
            content: `报告「${r.title}」生成时真实数据链路未命中，当前为演示数据（未入库，无法跳转报告中心）。请检查数据源连接后重试。`,
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            question: textToSubmit,
            isFallback: true,
            dataProvenance: 'simulated',
            dataSourceId: submitDSId,
          });
          return;
        }
        addChatMessage({
          id: `msg-report-${Date.now()}`,
          role: 'assistant',
          content: `报告「${r.title}」已生成完成。`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          question: textToSubmit,
          reportCard: {
            reportId: reportData.reportId,
            title: r.title,
            summary: (r.summary || '').slice(0, 100),
            kpiCount: Array.isArray(r.kpiList) ? r.kpiList.length : 0,
            chartCount: Array.isArray(r.charts) ? r.charts.length : 0,
            insightCount: Array.isArray(r.insights) ? r.insights.length : 0,
            templateName: reportData.templateName || '智能推断',
          },
          dataProvenance: 'live',
          dataSourceId: submitDSId,
        });
      } catch (err: any) {
        addChatMessage({
          id: `msg-err-report-${Date.now()}`,
          role: 'assistant',
          content: `报告生成失败：${err?.message || '请稍后重试'}`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          error: err?.message,
          dataSourceId: submitDSId,
        });
      } finally {
        setQueryLoading(false);
      }
      return;
    }

    addChatMessage(userMsg);
    setCurrentQuery('');
    setQueryLoading(true);
    setLiveTraceSteps([]);

    // Pass recent conversation turns for multi-turn context
    // P2 多轮增强：assistant 消息附带上轮真实结果摘要（作为 user 角色合成消息，
    // 服务端 L4 仅放行 user 消息，assistant 原文本就不发送，避免回流污染）
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    // 多轮上下文仅取当前源对话，避免跨源语义污染
    const recentTurns = visibleMessages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.error))
      .slice(-6);
    for (const m of recentTurns) {
      if (m.role === 'user') {
        history.push({ role: 'user', content: m.content });
        continue;
      }
      const qr = m.queryResult;
      if (qr && Array.isArray(qr.rows) && qr.rows.length > 0) {
        const sample = JSON.stringify(qr.rows.slice(0, 5)).slice(0, 400);
        history.push({
          role: 'user',
          content: `（上一轮查询的真实结果摘要：共 ${qr.totalCount ?? qr.rows.length} 行，样本数据 ${sample}）`,
        });
      }
    }

    const controller = new AbortController();
    // 前端超时须容纳后端链路最坏预算（阶段一重试 + 多候选 + 执行 + 阶段二解读），
    // 否则后端降级兜底结果尚未返回就被前端中止，用户看不到任何结果
    const timeoutTimer = setTimeout(() => controller.abort(), 300_000);

    // 统一消费响应体（JSON 与 SSE 终端事件同构）
    const consumeResponse = (resData: any) => {
      if (resData.success && resData.refused) {
        // 拒答：问题与数据源无关/超出能力，如实展示反馈（不用演示数据托底）
        addChatMessage({
          id: `msg-ai-${Date.now()}`,
          role: 'assistant',
          content: typeof resData.refuseReason === 'string' && resData.refuseReason.trim()
            ? resData.refuseReason.trim()
            : '抱歉，我是数据分析助手，仅协助处理数据分析相关工作，无法处理该请求。',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          refused: true,
          question: textToSubmit,
          traceId: typeof resData.traceId === 'string' ? resData.traceId : undefined,
          dataSourceId: submitDSId,
        });
      } else if (resData.success && resData.needClarification && resData.clarification) {
        // 歧义澄清：服务端对问题语义有异议，展示候选理解供用户点选确认后重新提交
        const c = resData.clarification;
        addChatMessage({
          id: `msg-ai-${Date.now()}`,
          role: 'assistant',
          content: typeof c.question === 'string' && c.question.trim() ? c.question : '该问题存在多种理解，请选择您想要的分析口径：',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          clarification: {
            question: typeof c.question === 'string' ? c.question : '',
            options: Array.isArray(c.options)
              ? c.options
                  .filter((o: any) => o && typeof o.label === 'string' && typeof o.query === 'string')
                  .slice(0, 4)
              : [],
          },
          question: textToSubmit,
          dataSourceId: submitDSId,
        });
      } else if (resData.success && resData.result) {
        const provenance = resData.dataProvenance === 'live' ? 'live' : 'simulated';
        const queryRes: QueryResultData = {
          ...resData.result,
          executionTimeMs: resData.executionTimeMs || 120,
          dataProvenance: provenance,
        };

        const aiMsg: ChatMessage = {
          id: `msg-ai-${Date.now()}`,
          role: 'assistant',
          content: queryRes.aiExplanation || '数据分析查询完成。',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          queryResult: queryRes,
          suggestedQuestions: queryRes.suggestedQuestions,
          isFallback: Boolean(resData.isFallback),
          dataProvenance: provenance,
          sensitiveFiltered: Number(resData.defense?.sensitiveFiltered) || 0,
          // P1-6 语义缓存命中标注：展示原问题与相似度，附「重新查询」刷新入口
          semanticCache: resData.semanticCache && typeof resData.semanticCache.matchedQuestion === 'string'
            ? { matchedQuestion: resData.semanticCache.matchedQuestion, similarity: Number(resData.semanticCache.similarity) || 0 }
            : undefined,
          // P2-12 DLP：服务端脱敏标记（VIEWER/ANALYST 命中敏感列时返回）
          dlpMaskedLabels: Array.isArray(resData.dlp?.maskedLabels) && resData.dlp.maskedLabels.length > 0
            ? resData.dlp.maskedLabels.map(String)
            : undefined,
          question: textToSubmit,
          traceId: typeof resData.traceId === 'string' ? resData.traceId : undefined,
          dataSourceId: submitDSId,
        };

        addChatMessage(aiMsg);
      } else {
        throw new Error(resData.error || '查询失败');
      }
    };

    // P2-5 SSE 断线续传：记录已收事件序号（SSE id）与 traceId；
    // 网络中断后凭 traceId + 序号走 GET /stream-replay 续传，已完成阶段即时回放、不重新执行 SQL
    let lastSeq = 0;
    let sawTerminal = false;
    let resumeTraceId = '';

    try {
      // attempt 0 = 原始问数请求；1-2 = 断线续传（最多 2 次，间隔 1s，期间服务端链路继续执行）
      for (let attempt = 0; ; attempt++) {
        try {
          const response = attempt === 0
            ? await apiFetch('/api/query/natural-language', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                  query: textToSubmit,
                  dataSourceId: activeDataSourceId,
                  schema: activeDS ? applyDataScope(activeDS.tables, activeDS.scope) : [],
                  history,
                  stream: true,
                  ...(approvedPlanId ? { planId: approvedPlanId } : {}),
                  ...(deepMode ? { deepAnalysis: true } : {}),
                  ...(selectedModelPayload ? { model: selectedModelPayload } : {}),
                  ...(options?.refreshCache ? { refreshCache: true } : {}),
                  amountUnit,
                }),
              })
            : await apiFetch(`/api/query/stream-replay/${encodeURIComponent(resumeTraceId)}?after=${lastSeq}`, {
                signal: controller.signal,
              });

          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('text/event-stream') && response.body) {
            // P2-7 流式链路：阶段事件实时更新进度，终端事件复用同一消费逻辑（P1-6 拆分至 utils/sseStream）
            // P1-2 Token 级流式输出：实时接收 LLM 生成内容的逐字推送
            await readSseStream(response, {
              // P2-5 断线续传：记录服务端事件序号作为续传游标
              onEventId: (id) => {
                const n = Number(id);
                if (Number.isFinite(n) && n > 0) lastSeq = n;
              },
              onStage: (label, _stage, info) => {
                // P2-5：首个 stage 事件即携带 traceId，记录为续传锚点
                if (typeof info?.traceId === 'string') resumeTraceId = info.traceId;
                setStreamProgress(label);
                if (typeof info?.sql === 'string' && info.sql.trim()) setStreamPreviewSql(info.sql);
              },
              // M1 推导留痕：服务端每步旁路落库同时推送，前端实时追加步骤器
              onTrace: (step) => setLiveTraceSteps((prev) => [...prev.slice(-7), step as TraceStepInfo]),
              // P1-2 流式内容增量渲染
              onChunk: (content) => {
                setIsReceivingStream(true);
                setStreamingContent((prev) => prev + content);
                
                // 动态更新当前聊天消息的流式内容
                const messages = chatMessages;
                if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
                  // 找到最后一个 assistant 消息并更新其内容
                  const lastMsg = messages[messages.length - 1];
                  lastMsg.content = streamingContent + content;
                  // 触发 React 更新（通过修改一个标记字段）
                  addChatMessage({ ...lastMsg });
                } else {
                  // 如果没有 assistant 消息，创建一个
                  addChatMessage({
                    id: `msg-ai-stream-${Date.now()}`,
                    role: 'assistant',
                    content: content,
                    timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                    dataSourceId: submitDSId,
                  });
                }
              },
              onTerminal: (_event, data) => {
                sawTerminal = true;
                setIsReceivingStream(false);
                // 清理临时状态
                setStreamingContent('');
                consumeResponse(data);
              },
            });
          } else {
            // 非流式（演示模式或早期校验错误 / 续传会话已过期）：保持原 JSON 链路
            const resData = await response.json();
            // 续传请求返回错误（404 会话过期 / 403 越权）：不再重试，直接呈现服务端错误
            if (attempt > 0 && !response.ok) {
              const err = new Error(resData.error || '断线续传失败') as Error & { sseTerminal?: boolean };
              err.sseTerminal = true;
              throw err;
            }
            consumeResponse(resData);
          }
          break;
        } catch (streamErr: any) {
          // P2-5 续传判定：仅「网络层中断」且已拿到续传锚点时才重试；
          // 用户主动停止/超时（AbortError）、业务终态错误（sseTerminal）、已达重试上限均不重试
          const canResume = !sawTerminal
            && streamErr?.name !== 'AbortError'
            && streamErr?.sseTerminal !== true
            && resumeTraceId.length > 0
            && attempt < 2
            && !controller.signal.aborted;
          if (!canResume) throw streamErr;
          setStreamProgress('网络中断，正在自动续传（已完成阶段即时回放，不重复执行）…');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      addChatMessage({
        id: `msg-err-${Date.now()}`,
        role: 'assistant',
        content: isTimeout
          ? '查询超时：模型推理时间过长，请稍后重试；如频繁出现可在系统管理中切换更快的模型。'
          : `查询过程出现异常: ${err.message || '请检查网络或配置'}`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        error: err.message,
        dataSourceId: submitDSId,
      });
    } finally {
      clearTimeout(timeoutTimer);
      setQueryLoading(false);
      setStreamProgress(null);
      setStreamPreviewSql(null);
    }
  };

  // Keyboard navigation for suggestions
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isSuggestionsOpen || filteredSuggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length);
    } else if (e.key === 'Enter') {
      if (selectedIndex >= 0 && selectedIndex < filteredSuggestions.length) {
        e.preventDefault();
        handleSendQuery(filteredSuggestions[selectedIndex]);
      }
    } else if (e.key === 'Tab') {
      if (selectedIndex >= 0 && selectedIndex < filteredSuggestions.length) {
        e.preventDefault();
        setCurrentQuery(filteredSuggestions[selectedIndex]);
      } else if (filteredSuggestions.length > 0) {
        e.preventDefault();
        setCurrentQuery(filteredSuggestions[0]);
      }
    } else if (e.key === 'Escape') {
      setIsSuggestionsOpen(false);
    }
  };

  // 歧义澄清：用户确认口径后按所选理解重新提交（P0-1 随 ChatMessageItem 拆分上提为回调）
  const handleSelectClarification = (msg: ChatMessage, query: string) => {
    setResolvedClarifications((prev) => new Set(prev).add(msg.id));
    handleSendQuery(query);
  };

  // M2 计划卡片：批准执行 / 修改提问 / 取消（任一处理后置灰防重复提交）
  const handleApprovePlan = (msg: ChatMessage) => {
    if (!msg.queryPlan) return;
    setResolvedPlans((prev) => new Set(prev).add(msg.id));
    handleSendQuery(msg.question || msg.queryPlan.understanding, msg.queryPlan.planId);
  };
  const handleEditPlanQuestion = (msg: ChatMessage) => {
    setResolvedPlans((prev) => new Set(prev).add(msg.id));
    if (msg.question) handleEditQuestion(msg.question);
  };
  const handleDismissPlan = (msgId: string) => {
    setResolvedPlans((prev) => new Set(prev).add(msgId));
  };

  // 固定图表到决策数据看板（v0.4.8：仅 live 链路携带原聚合 SQL，供数据变化时重放刷新）
  const handlePinChart = (msg: ChatMessage) => {
    if (!msg.queryResult?.chartConfig) return;
    pinChartToDashboardRemote({
      title: msg.queryResult.chartConfig.title,
      chartConfig: msg.queryResult.chartConfig,
      data: msg.queryResult.rows,
      dataSourceId: activeDataSourceId || undefined,
      ...(msg.queryResult.dataProvenance === 'live' && msg.queryResult.generatedSQL
        ? { sourceSql: msg.queryResult.generatedSQL }
        : {}),
    })
      .then(() => showToast('已成功固定该图表至决策数据看板'))
      .catch((err) => showToast(err?.message || '固定到看板失败'));
  };

  // v0.5.0 报告卡片：跳转报告中心查看完整报告
  const handleOpenReport = (reportId: string) => {
    setPendingReportId(reportId);
    setActiveTab('query-reports');
  };

  // P2-A 技能：选中后将提问模板填入输入框并聚焦；技能库管理入口
  const handleSelectSkill = (promptTemplate: string) => {
    setCurrentQuery(promptTemplate);
    setSkillMenuOpen(false);
    inputRef.current?.focus();
  };
  const handleOpenSkillLibrary = () => {
    setSkillMenuOpen(false);
    setSkillLibraryOpen(true);
  };

  // 快速问题推荐 pills：取真实 Schema 推荐的前 3 条（无可用推荐时隐藏该区域）
  const presetQueries = schemaSuggestions.slice(0, 3);

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 overflow-hidden relative">
      {/* Top Banner / Active DS Info */}
      <div className="px-6 py-2.5 bg-slate-900/60 border-b border-slate-800/80 flex items-center justify-between text-xs shrink-0">
        <div className="flex items-center space-x-2">
          <span className={`w-2 h-2 rounded-full ${aiSwitchOff ? 'bg-rose-400' : 'bg-emerald-400 animate-ping'}`} />
          <span className="text-slate-300 font-medium">
            当前智能问答数据上下文: <strong className="text-indigo-300">{activeDS?.name}</strong>
          </span>
          {aiSwitchOff && (
            <span className="px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-500/40 text-rose-300 text-[10px] font-semibold">
              问数已停用
            </span>
          )}
          {/* 问数表范围：以服务端上下文摘要（scope 白名单 + 敏感列过滤后）为单一事实源，
              与实际参与问数的范围保持一致；未落库数据源（演示模式）无服务端范围 */}
          {queryContext && queryContext.status !== null && (
            queryContext.tableCount > 0 ? (
              <span
                className="px-1.5 py-0.5 rounded bg-indigo-950/40 border border-indigo-500/30 text-indigo-300 text-[10px] font-semibold"
                title={
                  currentUser?.role === 'ADMIN' && queryContext.tables.length > 0
                    ? `实际参与问数的数据表（已按问数范围与敏感策略过滤）:\n${queryContext.tables.map((t) => `- ${t.displayName} (${t.name})`).join('\n')}`
                    : '实际参与问数的数据表数量（已按问数范围与敏感策略过滤）'
                }
              >
                问数范围 {queryContext.tableCount} 张表
                {queryContext.tableCount > queryContext.maxTablesInPrompt && '（提问时自动圈选最相关表）'}
              </span>
            ) : (
              <span
                className="px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-500/40 text-rose-300 text-[10px] font-semibold"
                title="请管理员在「数据源管理 → 问数范围配置」中勾选允许问数的数据表"
              >
                问数范围为空
              </span>
            )
          )}
          {/* 管理员可悬停查看实际参与问数的表名清单（来自服务端上下文摘要） */}
          {currentUser?.role === 'ADMIN' && queryContext && queryContext.tables.length > 0 && (
            <span className="text-slate-500 font-mono truncate max-w-[420px]" title={queryContext.tables.map((t) => t.name).join(', ')}>
              ({queryContext.tables.map((t) => t.displayName || t.name).join(', ')})
            </span>
          )}
        </div>

        <div className="flex items-center space-x-3">
          {/* P3-1 知识库管理 */}
          {currentUser?.role === 'ADMIN' && (
            <button
              onClick={() => setShowKnowledgePanel(true)}
              className="flex items-center space-x-1 text-slate-400 hover:text-indigo-400 transition-colors"
              title="管理员专用：知识库导入导出备份"
            >
              <Library className="w-3.5 h-3.5" />
              <span>知识库管理</span>
            </button>
          )}
          <button
            onClick={handleExportConversation}
            className="flex items-center space-x-1 text-slate-400 hover:text-indigo-400 transition-colors"
            title="将当前数据源的对话导出为 Markdown 文件"
          >
            <Download className="w-3.5 h-3.5" />
            <span>导出</span>
          </button>
          <button
            onClick={toggleHistoryPanel}
            className={`flex items-center space-x-1 transition-colors ${historyOpen ? 'text-indigo-400' : 'text-slate-400 hover:text-indigo-400'}`}
            title="查看服务端落库的对话历史（搜索 / 重问 / 删除，跨设备共享）"
          >
            <History className="w-3.5 h-3.5" />
            <span>历史对话</span>
          </button>
          <button
            onClick={clearChat}
            className="flex items-center space-x-1 text-slate-400 hover:text-rose-400 transition-colors"
            title="清空当前数据源的对话记录（不影响其他数据源）"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>重置对话</span>
          </button>
        </div>
      </div>

      {/* 对话历史面板（服务端落库）：P1-6 拆分至 ChatHistoryPanel 纯展示组件 */}
      {historyOpen && (
        <ChatHistoryPanel
          items={historyItems}
          loading={historyLoading}
          keyword={historyKeyword}
          onKeywordChange={setHistoryKeyword}
          onSearch={(kw) => void loadHistory(kw)}
          onClose={toggleHistoryPanel}
          onReuse={(q) => {
            handleEditQuestion(q);
            toggleHistoryPanel();
          }}
          onDelete={(id) => void handleDeleteConversation(id)}
        />
      )}

      {/* Conversation Feed */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {/* 当前数据源暂无对话历史：动态生成跟随该源表结构的欢迎语 */}
        {visibleMessages.length === 0 && (
          <div className="flex items-start space-x-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm bg-slate-800 text-indigo-400 border border-slate-700">
              <Bot className="w-4 h-4" />
            </div>
            <div className="w-full max-w-4xl space-y-3 bg-slate-900 border border-slate-800 rounded-2xl p-4 md:p-5 shadow-sm text-xs text-slate-200">
              <div className="flex items-center justify-between border-b border-slate-800/60 pb-2 text-[11px] text-slate-400">
                <span className="font-semibold text-slate-300">智能数据分析助手 NL2SQL</span>
              </div>
              <div className="whitespace-pre-wrap leading-relaxed text-sm">{welcomeContent}</div>
            </div>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            msg={msg}
            welcomeContent={welcomeContent}
            isQueryLoading={isQueryLoading}
            clarificationResolved={resolvedClarifications.has(msg.id)}
            planResolved={resolvedPlans.has(msg.id)}
            onInspectSql={setInspectModalResult}
            onFeedback={handleFeedback}
            onSendQuery={handleSendQuery}
            onCopyQuestion={handleCopyQuestion}
            onEditQuestion={handleEditQuestion}
            onSelectClarification={handleSelectClarification}
            onApprovePlan={handleApprovePlan}
            onEditPlanQuestion={handleEditPlanQuestion}
            onDismissPlan={handleDismissPlan}
            onUpdateChartConfig={updateMessageChartConfig}
            onPinChart={handlePinChart}
            onOpenReport={handleOpenReport}
          />
        ))}

        {/* Loading Spinner Indicator */}
        {isQueryLoading && (
          <div className="flex items-start space-x-3">
            <div className="w-8 h-8 rounded-xl bg-slate-800 text-indigo-400 flex items-center justify-center border border-slate-700 animate-pulse">
              <Bot className="w-4 h-4" />
            </div>
            <div className="flex-1 space-y-2">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-xs text-slate-300 flex items-center space-x-3">
                <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                <span>{streamProgress || 'AI 正在解析 Schema 并生成智能可视化数据...'}</span>
              </div>
              {/* P2-1 SQL 先行回显：阶段一完成即展示生成的 SQL，缩短长执行的感知等待 */}
              {streamPreviewSql && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3">
                  <div className="text-[10px] font-bold text-emerald-400/80 mb-1.5">已生成 SQL（先行预览，最终以执行结果为准）</div>
                  <pre className="text-[10px] leading-relaxed text-slate-400 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto select-all">{streamPreviewSql}</pre>
                </div>
              )}
              {/* M1 分析过程显性呈现：实时步骤器展示已完成的推导环节 */}
              {liveTraceSteps.length > 0 && <TraceStepper steps={liveTraceSteps} />}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Box Area */}
      <div className="p-3 md:p-4 bg-slate-900/90 border-t border-slate-800 shrink-0 space-y-2">
        {/* AI Switch Off Notice（L7 AI 开关） */}
        {aiSwitchOff && (
          <div className="p-2.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>该数据源的智能问数功能已被管理员停用，可在「数据源管理」中重新连接启用。</span>
          </div>
        )}

        {/* Quick Prompt Pills */}
        {presetQueries.length > 0 && !aiSwitchOff && (
          <div className="flex items-center space-x-2 overflow-x-auto pb-1 text-xs">
            <span className="text-slate-400 font-medium shrink-0 flex items-center space-x-1">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              <span>快速问题推荐:</span>
            </span>
            {presetQueries.map((pq, idx) => (
              <button
                key={idx}
                onClick={() => handleSendQuery(pq)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700/80 text-slate-300 hover:text-slate-100 border border-slate-700 rounded-lg shrink-0 transition-colors"
              >
                {pq}
              </button>
            ))}
          </div>
        )}

        {/* Main Input Form with Autocomplete Dropdown */}
        <div className="relative">
          {/* Autocomplete Suggestions Popup */}
          {isSuggestionsOpen && filteredSuggestions.length > 0 && (
            <div className="absolute bottom-full mb-2 left-0 right-0 bg-slate-900 border border-indigo-500/30 rounded-2xl p-2.5 shadow-2xl z-50 space-y-1">
              <div className="flex items-center justify-between px-2.5 py-1 border-b border-slate-800 text-[10px] text-slate-400">
                <span className="flex items-center space-x-1 text-indigo-400 font-semibold">
                  <Search className="w-3 h-3" />
                  <span>实时查询推荐与 Schema 提示 ({filteredSuggestions.length})</span>
                </span>
                <span className="text-slate-500 font-mono hidden sm:inline">
                  ↑↓ 切换 | Enter 选择 | Tab 补全 | Esc 关闭
                </span>
              </div>

              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {filteredSuggestions.map((suggestion, idx) => {
                  const isSelected = selectedIndex === idx;
                  return (
                    <div
                      key={idx}
                      onClick={() => handleSendQuery(suggestion)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-indigo-600 text-white font-medium shadow-sm'
                          : 'text-slate-200 hover:bg-slate-800/80'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5 truncate">
                        <Sparkles className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-white' : 'text-indigo-400'}`} />
                        <span className="truncate">{suggestion}</span>
                      </div>

                      <div className="flex items-center space-x-1 text-[10px] opacity-80 shrink-0">
                        <span className="hidden md:inline font-mono">点击直接查询</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Voice Listening Banner */}
          {isListening && (
            <div className="mb-2 p-2.5 rounded-xl bg-rose-950/60 border border-rose-500/50 flex items-center justify-between text-xs text-rose-200 animate-pulse">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></span>
                <Volume2 className="w-4 h-4 text-rose-400" />
                <span className="font-semibold">正在语音实时录音识别中，请说话...</span>
              </div>
              <button
                onClick={toggleSpeechRecognition}
                className="px-2 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-[10px] font-bold"
              >
                停止录音
              </button>
            </div>
          )}

          {speechError && (
            <div className="mb-2 p-2 rounded-xl bg-amber-950/60 border border-amber-500/40 text-amber-300 text-xs flex items-center justify-between">
              <span>{speechError}</span>
              <button
                onClick={clearSpeechError}
                className="text-amber-400 text-[10px] underline ml-2"
              >
                关闭
              </button>
            </div>
          )}

          {/* 模式选项行：P0-1 拆至 QueryModeBar（计划/深度/报告模式 + 金额单位 + 模型自选） */}
          <QueryModeBar
            aiSwitchOff={aiSwitchOff}
            canPlanMode={canPlanMode}
            planMode={planMode}
            onTogglePlanMode={togglePlanMode}
            deepMode={deepMode}
            onToggleDeepMode={toggleDeepMode}
            reportMode={reportMode}
            onToggleReportMode={toggleReportMode}
            reportTemplates={reportTemplates}
            selectedTemplateId={selectedTemplateId}
            onSelectTemplate={setSelectedTemplateId}
            isQueryLoading={isQueryLoading}
            modelCatalog={modelCatalog}
            selectedModel={selectedModel}
            onSelectModel={handleSelectModel}
          />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendQuery();
            }}
            className="flex items-center space-x-2"
          >
            {/* P2-A 技能「+」入口：P0-1 拆至 SkillMenuButton（选中技能填充提问模板） */}
            <SkillMenuButton
              aiSwitchOff={aiSwitchOff}
              skills={skills}
              menuOpen={skillMenuOpen}
              onToggleMenu={() => setSkillMenuOpen((v) => !v)}
              menuRef={skillMenuRef}
              onSelectSkill={handleSelectSkill}
              onOpenLibrary={handleOpenSkillLibrary}
            />

            <div className="relative flex-1 flex items-center">
              <input
                ref={inputRef}
                type="text"
                value={currentQuery}
                onChange={(e) => setCurrentQuery(e.target.value)}
                onFocus={() => {
                  if (currentQuery.trim() && filteredSuggestions.length > 0) {
                    setIsSuggestionsOpen(true);
                  }
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  aiSwitchOff
                    ? '该数据源的问数功能已停用'
                    : buildQueryPlaceholder(schemaSuggestions, '用自然语言提问（或点击右侧麦克风语音输入）...')
                }
                maxLength={MAX_QUERY_INPUT_LENGTH}
                disabled={isQueryLoading || aiSwitchOff}
                className={`w-full bg-slate-950 border rounded-xl pl-4 pr-10 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                  isListening
                    ? 'border-rose-500 shadow-md shadow-rose-500/20'
                    : 'border-slate-700/80 focus:border-indigo-500'
                }`}
              />

              {/* Voice Input Mic Button */}
              <button
                type="button"
                onClick={toggleSpeechRecognition}
                title={isListening ? '点击停止语音输入' : '开启语音转文字输入'}
                className={`absolute right-2.5 p-1.5 rounded-lg transition-all ${
                  isListening
                    ? 'bg-rose-600 text-white animate-pulse'
                    : 'text-slate-400 hover:text-indigo-400 hover:bg-slate-800'
                }`}
              >
                {isListening ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>
            </div>

            <button
              type="submit"
              disabled={!currentQuery.trim() || isQueryLoading || aiSwitchOff}
              className="px-5 py-3 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl text-xs flex items-center space-x-1.5 shadow-lg shadow-indigo-600/30 transition-all shrink-0"
            >
              <Send className="w-4 h-4" />
              <span>智能查询</span>
            </button>
          </form>

          {/* Input Length Counter（L1：接近 500 字上限时提示） */}
          {currentQuery.length >= MAX_QUERY_INPUT_LENGTH - 50 && (
            <div className={`mt-1.5 text-right text-[10px] font-mono ${
              currentQuery.length >= MAX_QUERY_INPUT_LENGTH ? 'text-rose-400' : 'text-amber-400'
            }`}>
              {currentQuery.length}/{MAX_QUERY_INPUT_LENGTH}
            </div>
          )}
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-emerald-600/90 text-white text-xs font-medium shadow-lg z-50">
          {toast}
        </div>
      )}

      {/* Inspection Modal */}
      {/* 技能库管理弹窗：个人技能 CRUD + 分享申请 + 管理员维护系统库与审批 */}
      <SkillLibraryModal
        isOpen={skillLibraryOpen}
        onClose={() => {
          setSkillLibraryOpen(false);
          loadSkills();
        }}
      />

      {inspectModalResult && (
        <SQLPreviewModal
          isOpen={!!inspectModalResult}
          onClose={() => setInspectModalResult(null)}
          queryResult={inspectModalResult}
          onReRunSQL={async (sql) => {
            // P0：编辑后的 SQL 直接走真实执行端点（服务端 SELECT-only + 白名单校验）
            if (!activeDataSourceId) return;
            const ts = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            try {
              const resp = await apiFetch('/api/query/execute-sql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dataSourceId: activeDataSourceId, sql }),
              });
              const data = await resp.json();
              if (!resp.ok || !data.success) {
                throw new Error(data.error || 'SQL 执行失败');
              }
              const rows: Record<string, any>[] = Array.isArray(data.rows) ? data.rows : [];
              const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
              // 轴键矫正：x 取首个非数值列，y 取数值列（最多 2 个）
              const numericCols = columns.filter((c) => rows.some((r) => typeof r[c] === 'number'));
              const dimCols = columns.filter((c) => !numericCols.includes(c));
              const xAxisKey = dimCols[0] || columns[0] || '';
              const yAxisKeys = numericCols.length > 0
                ? numericCols.slice(0, 2)
                : columns.filter((c) => c !== xAxisKey).slice(0, 1);
              // 中文表头：schema 列业务含义兜底，原结果的 LLM 映射覆盖（重跑同 SQL 别名一般不变）
              const columnNames: Record<string, string> = {};
              const activeDs = dataSources.find((d) => d.id === activeDataSourceId);
              (activeDs?.tables || []).forEach((t) =>
                (t.columns || []).forEach((c) => {
                  if (c.description && columns.includes(c.name)) columnNames[c.name] = c.description;
                })
              );
              columns.forEach((c) => {
                const prev = inspectModalResult?.columnNames?.[c];
                if (prev) columnNames[c] = prev;
              });
              const queryResult: QueryResultData = {
                columns,
                rows,
                columnNames,
                totalCount: Number(data.rowCount) || rows.length,
                executionTimeMs: Number(data.executionTimeMs) || 0,
                generatedSQL: data.finalSql || sql,
                dataProvenance: 'live',
                aiExplanation: `SQL 重跑完成，返回 ${Number(data.rowCount) || rows.length} 行真实数据${data.truncated ? '（结果已按 500 行上限截断）' : ''}。`,
                keyInsights: [],
                suggestedQuestions: [],
                ...(xAxisKey && yAxisKeys.length > 0
                  ? {
                      chartConfig: {
                        type: 'bar' as const,
                        title: 'SQL 重跑结果',
                        xAxisKey,
                        yAxisKeys,
                        yAxisNames: Object.fromEntries(
                          yAxisKeys.filter((k) => columnNames[k]).map((k) => [k, columnNames[k]])
                        ),
                        ...(columnNames[xAxisKey] ? { xAxisName: columnNames[xAxisKey] } : {}),
                      },
                    }
                  : {}),
              };
              addChatMessage({
                id: `msg-ai-rerun-${Date.now()}`,
                role: 'assistant',
                content: queryResult.aiExplanation || 'SQL 重跑完成。',
                timestamp: ts,
                queryResult,
                dataProvenance: 'live',
              });
            } catch (err: any) {
              addChatMessage({
                id: `msg-err-rerun-${Date.now()}`,
                role: 'assistant',
                content: `SQL 重跑被拒绝：${err?.message || '未知错误'}`,
                timestamp: ts,
                error: err?.message,
              });
            }
          }}
        />
      )}

      {/* P3-1 知识库管理面板（模态框） */}
      {showKnowledgePanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 z-10 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">知识库导入导出</h2>
              <button
                onClick={() => setShowKnowledgePanel(false)}
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                title="关闭"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              <KnowledgeManagementPanel dataSourceId={activeDataSourceId} />
            </div>
            <div className="sticky bottom-0 bg-gray-50 dark:bg-gray-900 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowKnowledgePanel(false)}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
