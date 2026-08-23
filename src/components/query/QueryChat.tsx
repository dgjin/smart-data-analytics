import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Send,
  Sparkles,
  Bot,
  User,
  Code2,
  Brain,
  Lightbulb,
  Pin,
  Trash2,
  BarChart3,
  CheckCircle,
  Search,
  CornerDownLeft,
  Command,
  Database,
  ArrowUpRight,
  Mic,
  MicOff,
  Volume2,
  ShieldCheck,
  Copy,
  Pencil,
  ThumbsUp,
  ThumbsDown,
  HelpCircle,
  Library,
  Plus,
  Cpu,
  Coins,
  ListChecks,
  History,
  Download,
  FileText,
  Zap,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { useModelCatalog } from '../../hooks/useModelCatalog';
import { apiFetch } from '../../api/client';
import { applyDataScope } from '../../utils/dataScope';
import { buildQueryPlaceholder, generateSchemaSuggestions } from '../../utils/querySuggestions';
import { DynamicChart } from '../charts/DynamicChart';
import { KPIStats } from '../charts/KPIStats';
import { DataTable } from '../charts/DataTable';
import { ChartCustomizer } from '../charts/ChartCustomizer';
import { SQLPreviewModal } from './SQLPreviewModal';
import { SkillLibraryModal } from './SkillLibraryModal';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { TraceStepper, TraceReplay, TraceStepInfo } from './AnalysisTracePanel';
import { useConversationHistory } from '../../hooks/useConversationHistory';
import { ReportTemplate } from '../../types/analytics';
import { useSpeechInput } from '../../hooks/useSpeechInput';
import { readSseStream } from '../../utils/sseStream';
import { ChartConfig, ChatMessage, QueryPlanData, QueryResultData } from '../../types/analytics';

// L1 输入层（与服务端 queryGuard.MAX_QUESTION_LENGTH 对齐）：单条提问最大 500 字
const MAX_QUERY_INPUT_LENGTH = 500;
// 模型自选持久化键（值为 "engine::model"，空串表示跟随服务端默认）
const SELECTED_MODEL_KEY = 'app-selected-model';
// 金额单位自选持久化键（亿元/百万元/万元/元，与服务端白名单一致）
const AMOUNT_UNIT_KEY = 'app-amount-unit';
const AMOUNT_UNIT_CHOICES = ['亿元', '百万元', '万元', '元'] as const;
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
    pinChartToDashboard,
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

  // 金额单位自选：问数前选择，随每次提问生效并持久化；非法存量值回落亿元
  const [amountUnit, setAmountUnit] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(AMOUNT_UNIT_KEY) || '';
      return (AMOUNT_UNIT_CHOICES as readonly string[]).includes(saved) ? saved : '亿元';
    } catch {
      return '亿元';
    }
  });
  const handleSelectAmountUnit = (value: string) => {
    setAmountUnit(value);
    try {
      localStorage.setItem(AMOUNT_UNIT_KEY, value);
    } catch {
      // 存储不可用时仅本次会话生效
    }
  };
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

  // M2 计划模式：仅真实连接的数据库型数据源支持（与服务端 canPlan 判定一致）
  const canPlanMode = queryContext !== null && ['mysql', 'postgresql', 'greenplum'].includes(queryContext.dsType || '');

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
    if (reportMode && !approvedPlanId) {
      addChatMessage(userMsg);
      setCurrentQuery('');
      setQueryLoading(true);
      try {
        const reportResp = await apiFetch('/api/report/generate-from-query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: textToSubmit,
            dataSourceId: activeDataSourceId,
            amountUnit, // v0.5.2 报告金额单位与问数选定口径一致
            ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
          }),
        });
        const reportData = await reportResp.json().catch(() => null);
        if (!reportResp.ok || !reportData?.success || !reportData.report) {
          throw new Error(reportData?.error || '报告生成失败');
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

    try {
      const response = await apiFetch('/api/query/natural-language', {
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
      });

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && response.body) {
        // P2-7 流式链路：阶段事件实时更新进度，终端事件复用同一消费逻辑（P1-6 拆分至 utils/sseStream）
        await readSseStream(response, {
          onStage: (label, _stage, info) => {
            setStreamProgress(label);
            if (typeof info?.sql === 'string' && info.sql.trim()) setStreamPreviewSql(info.sql);
          },
          // M1 推导留痕：服务端每步旁路落库同时推送，前端实时追加步骤器
          onTrace: (step) => setLiveTraceSteps((prev) => [...prev.slice(-7), step as TraceStepInfo]),
          onTerminal: (_event, data) => consumeResponse(data),
        });
      } else {
        // 非流式（演示模式或早期校验错误）：保持原 JSON 链路
        const resData = await response.json();
        consumeResponse(resData);
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
        {visibleMessages.map((msg) => {
          const isUser = msg.role === 'user';

          return (
            <div
              key={msg.id}
              className={`flex items-start space-x-3 ${
                isUser ? 'flex-row-reverse space-x-reverse' : ''
              }`}
            >
              {/* Avatar */}
              <div
                className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm ${
                  isUser
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-indigo-400 border border-slate-700'
                }`}
              >
                {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>

              {/* Message Card */}
              <div
                className={`max-w-4xl space-y-3 ${
                  isUser
                    ? 'bg-indigo-600/90 text-white px-4 py-2.5 rounded-2xl rounded-tr-none text-xs leading-relaxed shadow-md'
                    : 'w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 md:p-5 shadow-sm text-xs text-slate-200'
                }`}
              >
                {/* Header info */}
                <div className="flex items-center justify-between border-b border-slate-800/60 pb-2 text-[11px] text-slate-400">
                  <span className="flex items-center space-x-2">
                    <span className="font-semibold text-slate-300">
                      {isUser ? '你' : '智能数据分析助手 NL2SQL'}
                    </span>
                    {!isUser && msg.queryResult?.expertPersona && (
                      <span
                        className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium"
                        title="根据你的问题内容自动匹配的专家分析视角"
                      >
                        {msg.queryResult.expertPersona}视角
                      </span>
                    )}
                  </span>
                  <div className="flex items-center space-x-3">
                    {msg.queryResult && !isUser && (
                      <button
                        onClick={() => setInspectModalResult(msg.queryResult!)}
                        className="flex items-center space-x-1 text-indigo-400 hover:text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded-md border border-indigo-500/30 font-medium transition-colors"
                      >
                        <Code2 className="w-3 h-3" />
                        <span>查看生成的 SQL</span>
                      </button>
                    )}
                    {msg.queryResult && !isUser && msg.question && (
                      <span className="flex items-center space-x-1" title="对本次回答进行评价">
                        <button
                          onClick={() => handleFeedback(msg, 'UP')}
                          disabled={Boolean(msg.feedback)}
                          className={`p-1 rounded-md border transition-colors ${
                            msg.feedback === 'UP'
                              ? 'text-emerald-400 border-emerald-500/50 bg-emerald-950/40'
                              : 'text-slate-400 border-slate-700 hover:text-emerald-400 hover:border-emerald-500/50 disabled:opacity-50'
                          }`}
                          aria-label="回答有帮助"
                        >
                          <ThumbsUp className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleFeedback(msg, 'DOWN')}
                          disabled={Boolean(msg.feedback)}
                          className={`p-1 rounded-md border transition-colors ${
                            msg.feedback === 'DOWN'
                              ? 'text-rose-400 border-rose-500/50 bg-rose-950/40'
                              : 'text-slate-400 border-slate-700 hover:text-rose-400 hover:border-rose-500/50 disabled:opacity-50'
                          }`}
                          aria-label="回答不准确"
                        >
                          <ThumbsDown className="w-3 h-3" />
                        </button>
                      </span>
                    )}
                    <span>{msg.timestamp}</span>
                  </div>
                </div>

                {/* Fallback Data Notice */}
                {msg.isFallback && !isUser && (
                  <div className="p-2 rounded-lg bg-amber-950/50 border border-amber-500/40 text-amber-300 text-[11px] flex items-center space-x-1.5">
                    <Lightbulb className="w-3.5 h-3.5 shrink-0" />
                    <span>AI 服务当前不可用，以下展示为内置示例数据，仅用于演示界面功能。</span>
                  </div>
                )}

                {/* 拒答提示：问题与数据源无关/超出能力，如实反馈（无演示数据托底） */}
                {!isUser && msg.refused && (
                  <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-500/40 text-slate-300 text-[11px] flex items-center space-x-1.5">
                    <HelpCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>问数仅支持当前数据源相关的数据分析；该问题与数据无关或数据源中缺少支撑数据，未生成任何结果。</span>
                  </div>
                )}

                {/* 数据来源徽标（P1：live = 真实库执行；simulated = 演示数据，CSV/demo 等场景强制标记） */}
                {!isUser && msg.queryResult && msg.dataProvenance === 'live' && (
                  <div className="p-2 rounded-lg bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 text-[11px] flex items-center space-x-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>真实数据：SQL 已在数据库中实际执行，图表与解读均基于返回的 {msg.queryResult.totalCount} 行结果。</span>
                  </div>
                )}
                {!isUser && msg.queryResult && !msg.isFallback && msg.dataProvenance === 'simulated' && (
                  <div className="p-2 rounded-lg bg-amber-950/50 border border-amber-500/40 text-amber-300 text-[11px] flex items-center space-x-1.5">
                    <Lightbulb className="w-3.5 h-3.5 shrink-0" />
                    <span>演示数据：当前数据源不支持真实查询（非 MySQL 直连），以下为 AI 生成的模拟数据，仅供演示。</span>
                  </div>
                )}

                {/* P1-6 语义缓存命中提示：来自相似问题缓存，可一键刷新重新走真实查询 */}
                {!isUser && msg.semanticCache && (
                  <div className="p-2 rounded-lg bg-sky-950/50 border border-sky-500/40 text-sky-300 text-[11px] flex items-center justify-between gap-2">
                    <div className="flex items-center space-x-1.5 min-w-0">
                      <Zap className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate" title={msg.semanticCache.matchedQuestion}>
                        来自相似问题缓存（原问题：{msg.semanticCache.matchedQuestion}，相似度 {(msg.semanticCache.similarity * 100).toFixed(1)}%）
                      </span>
                    </div>
                    <button
                      onClick={() => msg.question && handleSendQuery(msg.question, undefined, { refreshCache: true })}
                      disabled={isQueryLoading}
                      className="shrink-0 px-2 py-0.5 rounded bg-sky-900/60 hover:bg-sky-800 border border-sky-500/40 text-sky-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      重新查询
                    </button>
                  </div>
                )}

                {/* P2-12 DLP 脱敏提示：结果中敏感字段已按角色策略掩码 */}
                {!isUser && msg.dlpMaskedLabels && msg.dlpMaskedLabels.length > 0 && (
                  <div className="p-2 rounded-lg bg-violet-950/50 border border-violet-500/40 text-violet-300 text-[11px] flex items-center space-x-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>DLP 数据防泄漏：结果中的{msg.dlpMaskedLabels.join('、')}已按你的角色权限自动脱敏。</span>
                  </div>
                )}

                {/* Sensitive Column Filter Notice（L7 敏感标记） */}
                {!isUser && (msg.sensitiveFiltered ?? 0) > 0 && (
                  <div className="p-2 rounded-lg bg-sky-950/50 border border-sky-500/40 text-sky-300 text-[11px] flex items-center space-x-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>安全策略已从 AI 分析上下文中剔除 {msg.sensitiveFiltered} 个敏感字段，本次分析不会涉及这些数据。</span>
                  </div>
                )}

                {/* M1 推导回放：按需拉取本次问数的全链路步骤时间线 */}
                {!isUser && msg.traceId && <TraceReplay traceId={msg.traceId} />}

                {/* Content Text（欢迎语按当前数据源真实表结构动态生成） */}
                <div className="whitespace-pre-wrap leading-relaxed text-sm">
                  {msg.id.startsWith('welcome-') ? welcomeContent : msg.content}
                </div>

                {/* 歧义澄清卡片：语义理解存在异议时展示候选口径，用户点选后按该理解重新提交 */}
                {!isUser && msg.clarification && msg.clarification.options.length > 0 && (
                  <div className="p-3 bg-sky-950/40 border border-sky-500/30 rounded-2xl space-y-2">
                    <div className="flex items-center space-x-1.5 font-bold text-sky-300 text-xs">
                      <HelpCircle className="w-4 h-4" />
                      <span>请选择您想要的分析口径（确认后将按该理解执行）:</span>
                    </div>
                    <div className="space-y-1.5">
                      {msg.clarification.options.map((opt, idx) => {
                        const resolved = resolvedClarifications.has(msg.id);
                        return (
                          <button
                            key={idx}
                            disabled={resolved || isQueryLoading}
                            onClick={() => {
                              setResolvedClarifications((prev) => new Set(prev).add(msg.id));
                              handleSendQuery(opt.query);
                            }}
                            title={opt.query}
                            className="w-full text-left px-3 py-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 hover:border-sky-500/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <div className="text-xs font-semibold text-sky-200">{opt.label}</div>
                            <div className="text-[11px] text-slate-400 mt-0.5 truncate">{opt.query}</div>
                          </button>
                        );
                      })}
                    </div>
                    {resolvedClarifications.has(msg.id) && (
                      <div className="text-[11px] text-slate-500 flex items-center space-x-1">
                        <CheckCircle className="w-3 h-3 text-emerald-400" />
                        <span>已确认口径，正在按该理解执行分析…</span>
                      </div>
                    )}
                  </div>
                )}

                {/* M2 计划卡片：执行前展示编号步骤与涉及表，批准后携带 planId 提交 */}
                {!isUser && msg.queryPlan && (
                  <div className="p-3 bg-violet-950/30 border border-violet-500/30 rounded-2xl space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5 font-bold text-violet-300 text-xs">
                        <ListChecks className="w-4 h-4" />
                        <span>分析计划（{msg.queryPlan.steps.length} 步 · {msg.queryPlan.complexity === 'multi-step' ? '多步复合' : '单步简单'}）</span>
                      </div>
                      {msg.queryPlan.relatedTables.length > 0 && (
                        <div className="flex items-center space-x-1 flex-wrap justify-end">
                          <span className="text-[10px] text-slate-500">涉及表:</span>
                          {msg.queryPlan.relatedTables.map((t) => (
                            <span key={t} className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono text-slate-300">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <ol className="space-y-1.5">
                      {msg.queryPlan.steps.map((st, idx) => (
                        <li key={idx} className="flex items-start space-x-2 p-2 rounded-xl bg-slate-900/80 border border-slate-800/80">
                          <span className="w-4 h-4 rounded-full bg-violet-500/20 text-violet-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">{idx + 1}</span>
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-200">
                              {st.title}
                              <span className="ml-1.5 text-[10px] text-slate-500 font-mono">{st.type}</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{st.description}</div>
                          </div>
                        </li>
                      ))}
                    </ol>
                    {resolvedPlans.has(msg.id) ? (
                      <div className="text-[11px] text-slate-500 flex items-center space-x-1">
                        <CheckCircle className="w-3 h-3 text-emerald-400" />
                        <span>该计划已处理，如需重新执行请重新制定计划。</span>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-2">
                        <button
                          disabled={isQueryLoading}
                          onClick={() => {
                            setResolvedPlans((prev) => new Set(prev).add(msg.id));
                            handleSendQuery(msg.question || msg.queryPlan!.understanding, msg.queryPlan!.planId);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          批准执行
                        </button>
                        <button
                          disabled={isQueryLoading}
                          onClick={() => {
                            setResolvedPlans((prev) => new Set(prev).add(msg.id));
                            if (msg.question) {
                              setCurrentQuery(msg.question);
                              inputRef.current?.focus();
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50"
                        >
                          修改提问
                        </button>
                        <button
                          onClick={() => setResolvedPlans((prev) => new Set(prev).add(msg.id))}
                          className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-rose-400 text-xs transition-colors"
                        >
                          取消
                        </button>
                        <span className="text-[10px] text-slate-500 ml-auto">计划 10 分钟内有效</span>
                      </div>
                    )}
                  </div>
                )}

                {/* v0.5.0 报告卡片：报告模式生成的完整报告摘要，点击跳转报告中心查看详情 */}
                {!isUser && msg.reportCard && (
                  <div className="p-4 bg-emerald-950/30 border border-emerald-500/30 rounded-2xl space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5 font-bold text-emerald-300 text-xs">
                        <FileText className="w-4 h-4" />
                        <span>分析报告已生成（模板：{msg.reportCard.templateName}）</span>
                      </div>
                    </div>
                    <div className="text-sm font-bold text-slate-100">{msg.reportCard.title}</div>
                    {msg.reportCard.summary && (
                      <div className="text-xs text-slate-400 leading-relaxed line-clamp-2">{msg.reportCard.summary}…</div>
                    )}
                    <div className="flex items-center space-x-3 text-[11px] text-slate-400">
                      <span>KPI {msg.reportCard.kpiCount} 项</span>
                      <span>图表 {msg.reportCard.chartCount} 张</span>
                      <span>洞察 {msg.reportCard.insightCount} 条</span>
                    </div>
                    <button
                      onClick={() => {
                        setPendingReportId(msg.reportCard!.reportId);
                        setActiveTab('query-reports');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
                    >
                      查看完整报告
                    </button>
                  </div>
                )}

                {/* 用户提问操作条：复制问题 / 再次编辑 */}
                {isUser && (
                  <div className="flex items-center justify-end space-x-2 pt-1.5 mt-0.5 border-t border-white/15">
                    <button
                      onClick={() => handleCopyQuestion(msg.content)}
                      title="复制问题到剪贴板"
                      className="flex items-center space-x-1 px-2 py-1 rounded-md text-indigo-100/80 hover:text-white hover:bg-white/10 text-[11px] font-medium transition-colors"
                    >
                      <Copy className="w-3 h-3" />
                      <span>复制</span>
                    </button>
                    <button
                      onClick={() => handleEditQuestion(msg.content)}
                      title="回填到输入框，修改后重新发送"
                      className="flex items-center space-x-1 px-2 py-1 rounded-md text-indigo-100/80 hover:text-white hover:bg-white/10 text-[11px] font-medium transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>再次编辑</span>
                    </button>
                  </div>
                )}

                {/* Query Result Analysis Dashboard Block */}
                {msg.queryResult && (
                  <div className="space-y-4 pt-2 border-t border-slate-800">
                    {/* KPI Cards */}
                    {msg.queryResult.kpiMetrics && (
                      <KPIStats metrics={msg.queryResult.kpiMetrics} />
                    )}

                    {/* AI Key Insights Box */}
                    {msg.queryResult.keyInsights && msg.queryResult.keyInsights.length > 0 && (
                      <div className="p-3.5 bg-indigo-950/40 border border-indigo-500/30 rounded-2xl space-y-2">
                        <div className="flex items-center space-x-1.5 font-bold text-indigo-300 text-xs">
                          <Lightbulb className="w-4 h-4 text-amber-400" />
                          <span>AI 归因分析与决策提示:</span>
                        </div>
                        <ul className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-slate-200">
                          {msg.queryResult.keyInsights.map((insight, idx) => (
                            <li
                              key={idx}
                              className="p-2 bg-slate-900/80 rounded-xl border border-slate-800/80 flex items-start space-x-2"
                            >
                              <span className="w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">
                                {idx + 1}
                              </span>
                              <span className="leading-tight">{insight}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Interactive Chart */}
                    {msg.queryResult.chartConfig && (
                      <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <BarChart3 className="w-4 h-4 text-cyan-400" />
                            <h4 className="font-bold text-slate-100 text-sm">
                              {msg.queryResult.chartConfig.title}
                            </h4>
                          </div>
                        </div>

                        {/* Chart Customizer Toolbar */}
                        <ChartCustomizer
                          config={msg.queryResult.chartConfig}
                          onChange={(newConfig) => updateMessageChartConfig(msg.id, newConfig)}
                          onPinToDashboard={() => {
                            pinChartToDashboard({
                              title: msg.queryResult!.chartConfig!.title,
                              chartConfig: msg.queryResult!.chartConfig!,
                              data: msg.queryResult!.rows,
                              dataSourceId: activeDataSourceId || undefined,
                              // v0.4.8 自主更新：仅 live 链路携带原聚合 SQL，供数据变化时重放刷新
                              ...(msg.queryResult!.dataProvenance === 'live' && msg.queryResult!.generatedSQL
                                ? { sourceSql: msg.queryResult!.generatedSQL }
                                : {}),
                            });
                            showToast('已成功固定该图表至决策数据看板');
                          }}
                        />

                        {/* Render Chart */}
                        <DynamicChart
                          config={msg.queryResult.chartConfig}
                          data={msg.queryResult.rows}
                        />
                      </div>
                    )}

                    {/* Data Table */}
                    {msg.queryResult.rows && (
                      <DataTable
                        data={msg.queryResult.rows}
                        columnNames={msg.queryResult.columnNames}
                        title="明细数据集"
                      />
                    )}
                  </div>
                )}

                {/* Suggested Follow-up Questions（欢迎语的追问推荐已由真实 Schema pills 取代，跳过渲染） */}
                {!msg.id.startsWith('welcome-') && msg.suggestedQuestions && msg.suggestedQuestions.length > 0 && (
                  <div className="pt-2 border-t border-slate-800/60 space-y-1.5">
                    <div className="text-[11px] text-slate-400 flex items-center space-x-1">
                      <Sparkles className="w-3 h-3 text-cyan-400" />
                      <span>推荐后续追问方向:</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {msg.suggestedQuestions.map((sq, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSendQuery(sq)}
                          className="px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-indigo-300 hover:text-indigo-200 border border-slate-700/80 text-xs text-left transition-colors"
                        >
                          {sq}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

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

          {/* 模式选项行：计划模式/深度分析/模型自选（技能改由输入框旁「+」弹出菜单选择） */}
          {!aiSwitchOff && (
            <div className="mb-2 flex items-center space-x-1.5 overflow-x-auto pb-0.5">
              {/* M2 计划模式：先制定分析计划，批准后执行（持久化，仅数据库型数据源展示） */}
              {canPlanMode && (
                <button
                  type="button"
                  onClick={togglePlanMode}
                  title={planMode ? '已开启：提问后先制定分析计划，确认后执行' : '已关闭：提问后直接执行查询'}
                  className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
                    planMode
                      ? 'bg-violet-950/60 border-violet-500 text-violet-300'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-violet-500/60 hover:text-violet-300'
                  }`}
                >
                  <ListChecks className="w-3 h-3" />
                  <span>{planMode ? '先制定计划：开' : '先制定计划：关'}</span>
                </button>
              )}

              {/* M3 深度分析：强制启用中间表清洗链（关闭时服务端复杂度评估自动判定） */}
              {canPlanMode && (
                <button
                  type="button"
                  onClick={toggleDeepMode}
                  title={deepMode ? '已开启：强制通过中间表清洗链完成复杂分析' : '已关闭：由系统自动判断是否需要中间表清洗'}
                  className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
                    deepMode
                      ? 'bg-cyan-950/60 border-cyan-500 text-cyan-300'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-cyan-500/60 hover:text-cyan-300'
                  }`}
                >
                  <Database className="w-3 h-3" />
                  <span>{deepMode ? '深度分析：开' : '深度分析：关'}</span>
                </button>
              )}

              {/* v0.5.0 报告模式：开启后提问直接生成完整报告（支持模板选择或智能推断） */}
              {canPlanMode && (
                <button
                  type="button"
                  onClick={toggleReportMode}
                  title={reportMode ? '已开启：提问后直接生成完整分析报告' : '已关闭：提问后返回单条分析结果'}
                  className={`shrink-0 px-2.5 py-1 rounded-lg border text-[11px] transition-colors flex items-center space-x-1 ${
                    reportMode
                      ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-emerald-500/60 hover:text-emerald-300'
                  }`}
                >
                  <FileText className="w-3 h-3" />
                  <span>{reportMode ? '报告模式：开' : '报告模式：关'}</span>
                </button>
              )}

              {/* 报告模式模板选择：开启后显示 */}
              {reportMode && reportTemplates.length > 0 && (
                <span className="shrink-0 flex items-center space-x-1 pl-2 border-l border-slate-800">
                  <FileText className="w-3 h-3 text-emerald-400" />
                  <select
                    value={selectedTemplateId ?? ''}
                    onChange={(e) => setSelectedTemplateId(e.target.value ? Number(e.target.value) : null)}
                    disabled={isQueryLoading}
                    title="选择报告模板：选中后按模板结构生成报告；留空则根据提问智能推断"
                    className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-emerald-500 cursor-pointer disabled:opacity-50"
                  >
                    <option value="">智能推断</option>
                    {reportTemplates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}{tpl.isPreset ? '（预设）' : ''}
                      </option>
                    ))}
                  </select>
                </span>
              )}

              {/* 金额单位自选：问数前选择，SQL 生成按所选单位换算（亿元/百万元/万元/元） */}
              <span className="shrink-0 flex items-center space-x-1 ml-auto pl-2 border-l border-slate-800">
                <Coins className="w-3 h-3 text-amber-400" />
                <select
                  value={amountUnit}
                  onChange={(e) => handleSelectAmountUnit(e.target.value)}
                  disabled={isQueryLoading}
                  title="金额输出单位：本次问数的金额指标按此单位换算（随提问生效并记忆）"
                  className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-amber-500 cursor-pointer disabled:opacity-50"
                >
                  {AMOUNT_UNIT_CHOICES.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </span>

              {/* 模型自选：目录由服务端按实际部署给出，选择随提问生效并持久化 */}
              {modelCatalog.length > 0 && (
                <span className="shrink-0 flex items-center space-x-1 pl-2 border-l border-slate-800">
                  <Cpu className="w-3 h-3 text-violet-400" />
                  <select
                    value={selectedModel}
                    onChange={(e) => handleSelectModel(e.target.value)}
                    disabled={isQueryLoading}
                    title="选择本次问数使用的 AI 模型"
                    className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-violet-500 cursor-pointer disabled:opacity-50 max-w-[180px]"
                  >
                    <option value="">
                      默认模型{modelCatalog.find((m) => m.isDefault) ? `（${modelCatalog.find((m) => m.isDefault)!.label}）` : ''}
                    </option>
                    {modelCatalog.map((m) => (
                      <option key={`${m.engine}::${m.model}`} value={`${m.engine}::${m.model}`}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendQuery();
            }}
            className="flex items-center space-x-2"
          >
            {/* P2-A 技能「+」入口（参照 Qoder IDE「+」交互）：点击向上弹出技能选择面板，选中后填充提问模板 */}
            {!aiSwitchOff && skills.length > 0 && (
              <div className="relative shrink-0" ref={skillMenuRef}>
                <button
                  type="button"
                  onClick={() => setSkillMenuOpen(!skillMenuOpen)}
                  title="添加分析技能（选择后将提问模板填入输入框）"
                  className={`px-3.5 py-3 rounded-xl border text-sm transition-colors ${
                    skillMenuOpen
                      ? 'bg-cyan-950/60 border-cyan-500 text-cyan-300'
                      : 'bg-slate-950 border-slate-700/80 text-slate-400 hover:border-cyan-500/60 hover:text-cyan-300'
                  }`}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {skillMenuOpen && (
                  <div className="absolute left-0 bottom-full mb-2 w-80 max-w-[86vw] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 z-50 overflow-hidden">
                    <div className="px-3 py-2 border-b border-slate-800 flex items-center space-x-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                      <span className="text-[11px] font-semibold text-cyan-300">分析技能 ({skills.length})</span>
                      <span className="text-[10px] text-slate-500">· 点击填充提问模板</span>
                    </div>
                    <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800/60">
                      {skills.map((sk) => (
                        <li key={sk.id}>
                          <button
                            type="button"
                            title={`点击将「${sk.name}」的提问模板填入输入框`}
                            onClick={() => {
                              setCurrentQuery(sk.promptTemplate);
                              setSkillMenuOpen(false);
                              inputRef.current?.focus();
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-slate-800/60 transition-colors group"
                          >
                            <div className="flex items-center space-x-2 min-w-0">
                              <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-300 shrink-0">{sk.name}</span>
                              <span className="text-[10px] text-slate-500 truncate flex-1">{sk.description}</span>
                              <ArrowUpRight className="w-3 h-3 text-slate-600 group-hover:text-cyan-400 shrink-0" />
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="border-t border-slate-800">
                      <button
                        type="button"
                        title="管理我的技能库与系统技能库"
                        onClick={() => {
                          setSkillMenuOpen(false);
                          setSkillLibraryOpen(true);
                        }}
                        className="w-full text-left px-3 py-2 text-[11px] text-indigo-300 hover:bg-slate-800/60 transition-colors flex items-center space-x-1.5"
                      >
                        <Library className="w-3 h-3" />
                        <span>技能库管理</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

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
    </div>
  );
};
