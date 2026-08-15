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
  RefreshCw,
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
  ListChecks,
  History,
  Download,
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
import { TraceStepper, TraceReplay, TraceStepInfo } from './AnalysisTracePanel';
import { ChartConfig, ChatMessage, QueryPlanData, QueryResultData } from '../../types/analytics';

// L1 输入层（与服务端 queryGuard.MAX_QUESTION_LENGTH 对齐）：单条提问最大 500 字
const MAX_QUERY_INPUT_LENGTH = 500;
// 模型自选持久化键（值为 "engine::model"，空串表示跟随服务端默认）
const SELECTED_MODEL_KEY = 'app-selected-model';
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
  } = useAnalyticsStore();
  const currentUser = useAuthStore((s) => s.user);

  const [inspectModalResult, setInspectModalResult] = useState<QueryResultData | null>(null);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
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
  const recognitionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // ---------- 对话历史管理（服务端落库）：搜索 / 重问 / 删除 / 导出 ----------
  interface ConversationItem {
    id: number;
    question: string;
    sql: string;
    answerSummary: string;
    status: 'SUCCESS' | 'FALLBACK';
    provenance: string;
    createdAt: string;
  }
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<ConversationItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyKeyword, setHistoryKeyword] = useState('');

  const loadHistory = React.useCallback(
    async (keyword: string) => {
      if (!activeDataSourceId) return;
      setHistoryLoading(true);
      try {
        const params = new URLSearchParams({ dataSourceId: activeDataSourceId });
        if (keyword.trim()) params.set('q', keyword.trim());
        const resp = await apiFetch(`/api/conversations?${params.toString()}`);
        const data = await resp.json();
        setHistoryItems(resp.ok && Array.isArray(data?.conversations) ? data.conversations : []);
      } catch {
        setHistoryItems([]);
        showToast('对话历史加载失败');
      } finally {
        setHistoryLoading(false);
      }
    },
    [activeDataSourceId]
  );

  const toggleHistoryPanel = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) {
      setHistoryKeyword('');
      void loadHistory('');
    }
  };

  // 面板打开期间切换数据源：自动重新拉取对应源的历史
  useEffect(() => {
    if (historyOpen) {
      if (activeDataSourceId) void loadHistory(historyKeyword);
      else setHistoryItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDataSourceId]);

  const handleDeleteConversation = async (id: number) => {
    try {
      const resp = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (resp.ok) {
        setHistoryItems((prev) => prev.filter((it) => it.id !== id));
        showToast('已删除该条对话记录');
      } else {
        const data = await resp.json().catch(() => ({}));
        showToast(data?.error || '删除失败');
      }
    } catch {
      showToast('删除失败');
    }
  };

  // 导出当前数据源的对话为 Markdown（问题 + 回答 + SQL）
  const handleExportConversation = () => {
    if (visibleMessages.length === 0) {
      showToast('当前数据源暂无可导出的对话');
      return;
    }
    const dsName = dataSources.find((ds) => ds.id === activeDataSourceId)?.name || '未知数据源';
    const lines: string[] = [
      '# 智能问数对话导出',
      '',
      `- 数据源：${dsName}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `- 消息条数：${visibleMessages.length}`,
      '',
    ];
    visibleMessages.forEach((msg, idx) => {
      lines.push(`## ${idx + 1}. ${msg.role === 'user' ? '用户提问' : '系统回答'}`);
      lines.push('');
      lines.push(String(msg.content || '').trim() || '（无内容）');
      const sql = (msg as any).result?.generatedSQL;
      if (msg.role === 'assistant' && typeof sql === 'string' && sql.trim()) {
        lines.push('', '```sql', sql.trim(), '```');
      }
      lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `问数对话_${dsName}_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已开始导出对话 Markdown');
  };

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

  // Web Speech API Voice-to-Text Handler
  const toggleSpeechRecognition = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSpeechError('当前浏览器环境不支持 Web Speech 语音识别 API，请在 Chrome 或 Edge 浏览器中使用。');
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'zh-CN';

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechError(null);
      };

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript) {
          setCurrentQuery(transcript.slice(0, MAX_QUERY_INPUT_LENGTH));
        }
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          setSpeechError('麦克风权限已被拒绝，请在浏览器地址栏侧点击允许麦克风权限。');
        } else if (event.error !== 'no-speech') {
          setSpeechError(`语音输入提示: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      console.error('Failed to start speech recognition:', err);
      setIsListening(false);
    }
  };

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

  // Handle NL Query Submission（approvedPlanId：M2 批准计划后携带，服务端校验后按计划执行）
  const handleSendQuery = async (queryText?: string, approvedPlanId?: string) => {
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
    const timeoutTimer = setTimeout(() => controller.abort(), 200_000);

    // SSE 阶段事件 → 进度文案（P2-7）
    const stageLabel = (stage: string): string => {
      switch (stage) {
        case 'understanding':
          return '正在理解问题语义并匹配数据字段…';
        case 'introspecting':
          return '数据自省中：正在确认真实取值…';
        case 'executed':
          return 'SQL 已执行，正在生成分析解读…';
        case 'analyzing':
          return '正在基于真实数据生成洞察…';
        default:
          return '处理中…';
      }
    };

    // 统一消费响应体（JSON 与 SSE 终端事件同构）
    const consumeResponse = (resData: any) => {
      if (resData.success && resData.needClarification && resData.clarification) {
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
          question: textToSubmit,
          traceId: typeof resData.traceId === 'string' ? resData.traceId : undefined,
          dataSourceId: submitDSId,
        };

        addChatMessage(aiMsg);
      } else {
        throw new Error(resData.error || '查询失败');
      }
    };

    // SSE 流解析：按 event/data 分段回调（错误事件抛异常走统一异常分支）
    const readSseStream = async (response: Response): Promise<void> => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          let eventName = 'message';
          let dataStr = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: any;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }
          if (eventName === 'stage') {
            setStreamProgress(stageLabel(String(data?.stage || '')));
          } else if (eventName === 'trace') {
            // M1 推导留痕：服务端每步旁路落库同时推送，前端实时追加步骤器
            if (data && typeof data.title === 'string') {
              setLiveTraceSteps((prev) => [...prev.slice(-7), data as TraceStepInfo]);
            }
          } else if (eventName === 'done' || eventName === 'clarify') {
            consumeResponse(data);
          } else if (eventName === 'error') {
            throw new Error(String(data?.error || '查询失败'));
          }
        }
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
        }),
      });

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && response.body) {
        // P2-7 流式链路：阶段事件实时更新进度，终端事件复用同一消费逻辑
        await readSseStream(response);
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
          ? '查询超时：本地模型推理时间过长，请稍后重试或换用更小的模型。'
          : `查询过程出现异常: ${err.message || '请检查网络或配置'}`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        error: err.message,
        dataSourceId: submitDSId,
      });
    } finally {
      clearTimeout(timeoutTimer);
      setQueryLoading(false);
      setStreamProgress(null);
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

      {/* 对话历史面板（服务端落库）：关键词搜索 / 一键重问 / 单条删除 */}
      {historyOpen && (
        <div className="mx-4 md:mx-6 mt-3 rounded-2xl border border-indigo-500/30 bg-slate-900/80 shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
            <span className="text-xs font-bold text-indigo-300 flex items-center space-x-1.5">
              <History className="w-3.5 h-3.5" />
              <span>历史对话（服务端落库，跨设备共享，成功问答自动沉淀为个人经验）</span>
            </span>
            <div className="flex items-center space-x-2">
              <div className="relative">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={historyKeyword}
                  onChange={(e) => setHistoryKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void loadHistory(historyKeyword);
                  }}
                  placeholder="搜索问题 / 结论，回车检索"
                  className="pl-6 pr-2 py-1 text-[11px] rounded-lg bg-slate-800 border border-slate-700 text-slate-200 focus:outline-none focus:border-indigo-500 w-48"
                />
              </div>
              <button onClick={() => setHistoryOpen(false)} className="text-slate-500 hover:text-slate-300 text-xs transition-colors">
                关闭
              </button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/60">
            {historyLoading ? (
              <div className="px-4 py-6 text-center text-xs text-slate-500">加载中…</div>
            ) : historyItems.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-500">该数据源暂无对话历史（问数完成后自动落库）</div>
            ) : (
              historyItems.map((item) => (
                <div key={item.id} className="px-4 py-2.5 hover:bg-slate-800/40 transition-colors group">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border shrink-0 ${
                            item.status === 'SUCCESS'
                              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                              : 'bg-amber-950/60 border-amber-500/40 text-amber-300'
                          }`}
                        >
                          {item.status === 'SUCCESS' ? '成功' : '降级'}
                        </span>
                        {item.provenance === 'simulated' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold border bg-slate-800 border-slate-700 text-slate-400 shrink-0">演示</span>
                        )}
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''}
                        </span>
                      </div>
                      <p className="text-xs text-slate-200 mt-1 truncate" title={item.question}>
                        {item.question}
                      </p>
                      {item.answerSummary && (
                        <p className="text-[11px] text-slate-500 mt-0.5 truncate" title={item.answerSummary}>
                          {item.answerSummary}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center space-x-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => {
                          handleEditQuestion(item.question);
                          setHistoryOpen(false);
                        }}
                        title="回填输入框重新提问"
                        className="p-1.5 rounded-lg text-indigo-400 hover:bg-indigo-950/60 transition-colors"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void handleDeleteConversation(item.id)}
                        title="删除该条对话记录"
                        className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-950/60 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
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
                onClick={() => setSpeechError(null)}
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

              {/* 模型自选：目录由服务端按实际部署给出，选择随提问生效并持久化 */}
              {modelCatalog.length > 0 && (
                <span className="shrink-0 flex items-center space-x-1 ml-auto pl-2 border-l border-slate-800">
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
