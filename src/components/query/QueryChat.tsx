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
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { apiFetch } from '../../api/client';
import { applyDataScope } from '../../utils/dataScope';
import { buildQueryPlaceholder, generateSchemaSuggestions } from '../../utils/querySuggestions';
import { DynamicChart } from '../charts/DynamicChart';
import { KPIStats } from '../charts/KPIStats';
import { DataTable } from '../charts/DataTable';
import { ChartCustomizer } from '../charts/ChartCustomizer';
import { SQLPreviewModal } from './SQLPreviewModal';
import { ChartConfig, ChatMessage, QueryResultData } from '../../types/analytics';

// L1 输入层（与服务端 queryGuard.MAX_QUESTION_LENGTH 对齐）：单条提问最大 500 字
const MAX_QUERY_INPUT_LENGTH = 500;

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
    pinChartToDashboard,
    updateMessageChartConfig,
    clearChat,
  } = useAnalyticsStore();

  const [inspectModalResult, setInspectModalResult] = useState<QueryResultData | null>(null);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, isQueryLoading]);

  // 推荐问题完全来自所选数据源的真实表结构（应用问数范围 scope 过滤，无硬编码示例）
  const schemaSuggestions = useMemo(
    () => (activeDS ? generateSchemaSuggestions(activeDS.tables, activeDS.scope) : []),
    [activeDS]
  );

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

  // Handle NL Query Submission
  const handleSendQuery = async (queryText?: string) => {
    const textToSubmit = queryText || currentQuery;
    if (!textToSubmit.trim() || isQueryLoading || aiSwitchOff) return;

    setIsSuggestionsOpen(false);
    setSelectedIndex(-1);

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      role: 'user',
      content: textToSubmit,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    };

    addChatMessage(userMsg);
    setCurrentQuery('');
    setQueryLoading(true);

    // Pass recent conversation turns for multi-turn context
    const history = chatMessages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.error))
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 200_000);

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
        }),
      });

      const resData = await response.json();

      if (resData.success && resData.result) {
        const queryRes: QueryResultData = {
          ...resData.result,
          executionTimeMs: resData.executionTimeMs || 120,
        };

        const aiMsg: ChatMessage = {
          id: `msg-ai-${Date.now()}`,
          role: 'assistant',
          content: queryRes.aiExplanation || '数据分析查询完成。',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          queryResult: queryRes,
          suggestedQuestions: queryRes.suggestedQuestions,
          isFallback: Boolean(resData.isFallback),
          sensitiveFiltered: Number(resData.defense?.sensitiveFiltered) || 0,
        };

        addChatMessage(aiMsg);
      } else {
        throw new Error(resData.error || '查询失败');
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
      });
    } finally {
      clearTimeout(timeoutTimer);
      setQueryLoading(false);
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
          <span className="text-slate-500 font-mono">
            ({activeDS?.tables.map((t) => t.displayName || t.name).join(', ')})
          </span>
        </div>

        <button
          onClick={clearChat}
          className="flex items-center space-x-1 text-slate-400 hover:text-rose-400 transition-colors"
          title="清空对话记录"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>重置对话</span>
        </button>
      </div>

      {/* Conversation Feed */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {chatMessages.map((msg) => {
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
                  <span className="font-semibold text-slate-300">
                    {isUser ? '你' : '智能数据分析助手 NL2SQL'}
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

                {/* Sensitive Column Filter Notice（L7 敏感标记） */}
                {!isUser && (msg.sensitiveFiltered ?? 0) > 0 && (
                  <div className="p-2 rounded-lg bg-sky-950/50 border border-sky-500/40 text-sky-300 text-[11px] flex items-center space-x-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>安全策略已从 AI 分析上下文中剔除 {msg.sensitiveFiltered} 个敏感字段，本次分析不会涉及这些数据。</span>
                  </div>
                )}

                {/* Content Text（欢迎语按当前数据源真实表结构动态生成） */}
                <div className="whitespace-pre-wrap leading-relaxed text-sm">
                  {msg.id === 'welcome-1' ? welcomeContent : msg.content}
                </div>

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
                      <DataTable data={msg.queryResult.rows} title="明细数据集" />
                    )}
                  </div>
                )}

                {/* Suggested Follow-up Questions（欢迎语的追问推荐已由真实 Schema pills 取代，跳过渲染） */}
                {msg.id !== 'welcome-1' && msg.suggestedQuestions && msg.suggestedQuestions.length > 0 && (
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
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-xl bg-slate-800 text-indigo-400 flex items-center justify-center border border-slate-700 animate-pulse">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-xs text-slate-300 flex items-center space-x-3">
              <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <span>AI 正在解析 Schema 并生成智能可视化数据...</span>
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

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendQuery();
            }}
            className="flex items-center space-x-2"
          >
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
      {inspectModalResult && (
        <SQLPreviewModal
          isOpen={!!inspectModalResult}
          onClose={() => setInspectModalResult(null)}
          queryResult={inspectModalResult}
          onReRunSQL={(sql) => {
            // Re-run SQL override
            handleSendQuery(`重跑 SQL: ${sql}`);
          }}
        />
      )}
    </div>
  );
};
