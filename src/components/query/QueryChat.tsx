import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useAuthStore } from '../../hooks/useAuthStore';
import { useModelCatalog } from '../../hooks/useModelCatalog';
import { apiFetch } from '../../api/client';
import { generateSchemaSuggestions } from '../../utils/querySuggestions';
import { SQLPreviewModal } from './SQLPreviewModal';
import { SkillLibraryModal } from './SkillLibraryModal';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { ChatMessageItem } from './ChatMessageItem';
import { QueryLoadingIndicator } from './QueryLoadingIndicator';
import { ChatInputArea } from './ChatInputArea';
import { ChatTopBar, QueryContextSummary } from './ChatTopBar';
import { useConversationHistory } from '../../hooks/useConversationHistory';
import { useEffectiveAmountUnit } from '../../hooks/useAmountUnitStore';
import { ReportTemplate } from '../../types/analytics';
import { useSpeechInput } from '../../hooks/useSpeechInput';
import { ChatMessage, QueryResultData } from '../../types/analytics';
import { useQueryModes } from './hooks/useQueryModes';
import { useStreamState } from './hooks/useStreamState';
import { useSkillLibrary } from './hooks/useSkillLibrary';
import { useSendQuery } from './hooks/useSendQuery';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../utils/logger';

// L1 输入层（与服务端 queryGuard.MAX_QUESTION_LENGTH 对齐）：单条提问最大 500 字
const MAX_QUERY_INPUT_LENGTH = 500;
// 模型自选持久化键（值为 "engine::model"，空串表示跟随服务端默认）
const SELECTED_MODEL_KEY = 'app-selected-model';
// 金额单位：由 useAmountUnitStore 统一管理（全局默认 + 模块覆盖，v0.5.4 起）

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
  // P0 拆分：技能库状态/加载/菜单外点关闭收敛至 useSkillLibrary
  const {
    skills,
    skillLibraryOpen,
    setSkillLibraryOpen,
    skillMenuOpen,
    setSkillMenuOpen,
    skillMenuRef,
    loadSkills,
  } = useSkillLibrary();
  // 已点选确认的澄清消息 id（确认后禁用选项，防止重复提交）
  const [resolvedClarifications, setResolvedClarifications] = useState<Set<string>>(new Set());
  // P0 拆分：SSE 流式链路五个状态收敛至 useStreamState
  const {
    streamProgress,
    setStreamProgress,
    streamPreviewSql,
    setStreamPreviewSql,
    streamingContent,
    setStreamingContent,
    isReceivingStream,
    setIsReceivingStream,
    liveTraceSteps,
    setLiveTraceSteps,
  } = useStreamState();
  // P0 拆分：四个模式开关（计划/Agent/深度/报告）+ 互斥与持久化逻辑收敛至 useQueryModes
  const {
    planMode,
    togglePlanMode,
    agentMode,
    toggleAgentMode,
    deepMode,
    toggleDeepMode,
    reportMode,
    toggleReportMode,
  } = useQueryModes();
  // M2 计划模式：已批准/取消的计划卡片 id 置灰
  const [resolvedPlans, setResolvedPlans] = useState<Set<string>>(new Set());
  // P1-7 Agent 编排：已处理（批准/放弃）的计划卡片 id 置灰
  const [resolvedAgentPlans, setResolvedAgentPlans] = useState<Set<string>>(new Set());
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [reportTemplates, setReportTemplates] = useState<ReportTemplate[]>([]);
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
        logger.error('Failed to load report templates:', err);
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
  const [queryContext, setQueryContext] = useState<QueryContextSummary | null>(null);
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
  // —— P0 拆分：提交链路（Agent 编排 / 计划模式 / 报告模式 / 标准 NL2SQL 流式 + 断线续传）
  //    收敛至 useSendQuery，本组件仅注入依赖并消费返回的处理函数
  const { handleSendQuery, handleApproveAgentPlan: executeAgentPlan } = useSendQuery({
    chatMessages,
    addChatMessage,
    currentQuery,
    setCurrentQuery,
    isQueryLoading,
    setQueryLoading,
    activeDataSourceId,
    activeDS,
    visibleMessages,
    aiSwitchOff,
    canPlanMode,
    amountUnit,
    selectedModelPayload,
    agentMode,
    planMode,
    deepMode,
    reportMode,
    selectedTemplateId,
    setStreamProgress,
    setStreamPreviewSql,
    setStreamingContent,
    setIsReceivingStream,
    setLiveTraceSteps,
    setIsSuggestionsOpen,
    setSelectedIndex,
    streamingContent,
  });


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

  // P1-7 Agent 编排卡片：批准执行（执行逻辑随 useSendQuery 迁出，置灰标记保留在本组件）/ 取消
  const handleApproveAgentPlan = async (msg: ChatMessage) => {
    if (!msg.agentPlan || isQueryLoading) return;
    setResolvedAgentPlans((prev) => new Set(prev).add(msg.id));
    await executeAgentPlan(msg);
  };
  const handleDismissAgentPlan = (msgId: string) => {
    setResolvedAgentPlans((prev) => new Set(prev).add(msgId));
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
      {/* Top Banner / Active DS Info（P0 拆至 ChatTopBar 纯展示组件） */}
      <ChatTopBar
        aiSwitchOff={aiSwitchOff}
        activeDSName={activeDS?.name}
        queryContext={queryContext}
        isAdmin={currentUser?.role === 'ADMIN'}
        historyOpen={historyOpen}
        onExportConversation={handleExportConversation}
        onToggleHistoryPanel={toggleHistoryPanel}
        onClearChat={clearChat}
      />

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
            agentPlanResolved={resolvedAgentPlans.has(msg.id)}
            onInspectSql={setInspectModalResult}
            onFeedback={handleFeedback}
            onSendQuery={handleSendQuery}
            onCopyQuestion={handleCopyQuestion}
            onEditQuestion={handleEditQuestion}
            onSelectClarification={handleSelectClarification}
            onApprovePlan={handleApprovePlan}
            onEditPlanQuestion={handleEditPlanQuestion}
            onDismissPlan={handleDismissPlan}
            onApproveAgentPlan={(m) => void handleApproveAgentPlan(m)}
            onDismissAgentPlan={handleDismissAgentPlan}
            onUpdateChartConfig={updateMessageChartConfig}
            onPinChart={handlePinChart}
            onOpenReport={handleOpenReport}
          />
        ))}

        {/* Loading Spinner Indicator（P0 拆至 QueryLoadingIndicator 纯展示组件） */}
        {isQueryLoading && (
          <QueryLoadingIndicator
            streamProgress={streamProgress}
            streamPreviewSql={streamPreviewSql}
            liveTraceSteps={liveTraceSteps}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Box Area（P0 拆至 ChatInputArea 受控子组件） */}
      <ChatInputArea
        aiSwitchOff={aiSwitchOff}
        canPlanMode={canPlanMode}
        isQueryLoading={isQueryLoading}
        currentQuery={currentQuery}
        setCurrentQuery={setCurrentQuery}
        inputRef={inputRef}
        schemaSuggestions={schemaSuggestions}
        presetQueries={presetQueries}
        filteredSuggestions={filteredSuggestions}
        isSuggestionsOpen={isSuggestionsOpen}
        setIsSuggestionsOpen={setIsSuggestionsOpen}
        selectedIndex={selectedIndex}
        setSelectedIndex={setSelectedIndex}
        onSendQuery={handleSendQuery}
        onKeyDown={handleKeyDown}
        isListening={isListening}
        speechError={speechError}
        toggleSpeechRecognition={toggleSpeechRecognition}
        clearSpeechError={clearSpeechError}
        planMode={planMode}
        onTogglePlanMode={togglePlanMode}
        agentMode={agentMode}
        onToggleAgentMode={toggleAgentMode}
        deepMode={deepMode}
        onToggleDeepMode={toggleDeepMode}
        reportMode={reportMode}
        onToggleReportMode={toggleReportMode}
        reportTemplates={reportTemplates}
        selectedTemplateId={selectedTemplateId}
        onSelectTemplate={setSelectedTemplateId}
        modelCatalog={modelCatalog}
        selectedModel={selectedModel}
        onSelectModel={handleSelectModel}
        skills={skills}
        skillMenuOpen={skillMenuOpen}
        onToggleSkillMenu={() => setSkillMenuOpen((v) => !v)}
        skillMenuRef={skillMenuRef}
        onSelectSkill={handleSelectSkill}
        onOpenSkillLibrary={handleOpenSkillLibrary}
      />

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
              const rows: Record<string, unknown>[] = Array.isArray(data.rows) ? data.rows : [];
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
            } catch (err) {
              addChatMessage({
                id: `msg-err-rerun-${Date.now()}`,
                role: 'assistant',
                content: `SQL 重跑被拒绝：${getErrorMessage(err) || '未知错误'}`,
                timestamp: ts,
                error: getErrorMessage(err),
              });
            }
          }}
        />
      )}
    </div>
  );
};
