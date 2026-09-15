import { apiFetch } from '../../../api/client';
import { applyDataScope } from '../../../utils/dataScope';
import { readSseStream } from '../../../utils/sseStream';
import { pollTask } from '../../../utils/asyncTask';
import { TraceStepInfo } from '../AnalysisTracePanel';
import {
  ChatMessage,
  QueryPlanData,
  QueryResultData,
  AgentPlanData,
  AgentRunData,
  ReportTemplate,
} from '../../../types/analytics';

interface ActiveDataSource {
  id: string;
  name?: string;
  tables: Parameters<typeof applyDataScope>[0];
  /** 与 DataSource.scope 对齐为可选（applyDataScope 第二参数本身允许 null/undefined） */
  scope?: Parameters<typeof applyDataScope>[1];
}

/**
 * useSendQuery 依赖集合（P0 上帝组件拆分：自 QueryChat 提取 handleSendQuery，行为保持一致）。
 * 所有依赖由调用方（QueryChat）受控注入，Hook 内部不直接持有业务状态。
 */
export interface SendQueryDeps {
  // store
  chatMessages: ChatMessage[];
  addChatMessage: (msg: ChatMessage) => void;
  currentQuery: string;
  setCurrentQuery: (v: string) => void;
  isQueryLoading: boolean;
  setQueryLoading: (v: boolean) => void;
  activeDataSourceId: string;
  activeDS: ActiveDataSource | undefined;
  // 上下文与派生
  visibleMessages: ChatMessage[];
  aiSwitchOff: boolean;
  canPlanMode: boolean;
  amountUnit: string;
  selectedModelPayload: { engine: string; model: string } | undefined;
  // 模式
  agentMode: boolean;
  planMode: boolean;
  deepMode: boolean;
  reportMode: boolean;
  selectedTemplateId: number | null;
  // 流式状态 setter（来自 useStreamState）
  setStreamProgress: (v: string | null) => void;
  setStreamPreviewSql: (v: string | null) => void;
  setStreamingContent: (v: string | ((prev: string) => string)) => void;
  setIsReceivingStream: (v: boolean) => void;
  setLiveTraceSteps: (v: TraceStepInfo[] | ((prev: TraceStepInfo[]) => TraceStepInfo[])) => void;
  // 输入建议
  setIsSuggestionsOpen: (v: boolean) => void;
  setSelectedIndex: (v: number) => void;
  // 流式内容当前值（onChunk 内拼接用）
  streamingContent: string;
}

export interface SendQueryHandlers {
  handleSendQuery: (queryText?: string, approvedPlanId?: string, options?: { refreshCache?: boolean }) => Promise<void>;
  handleApproveAgentPlan: (msg: ChatMessage) => Promise<void>;
}

/**
 * 问数提交与编排执行（P0 上帝组件拆分：自 QueryChat 提取，行为保持一致）。
 * 涵盖：Agent 编排计划 / 计划模式 / 报告模式（异步任务轮询）/ 标准 NL2SQL 流式链路
 * （SSE 阶段事件 + Token 级流式 + 断线续传）+ 统一响应消费（拒答/澄清/结果）。
 */
export function useSendQuery(deps: SendQueryDeps): SendQueryHandlers {
  const {
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
  } = deps;

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

    // P1-7 Agent 编排：开启后提问先由 Planner 规划多能力步骤（不执行），用户批准后逐步执行取数与统计
    if (agentMode && !approvedPlanId && canPlanMode) {
      addChatMessage(userMsg);
      setCurrentQuery('');
      setQueryLoading(true);
      try {
        const planResp = await apiFetch('/api/agent/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: textToSubmit, dataSourceId: activeDataSourceId }),
        });
        const planData = await planResp.json().catch(() => null);
        if (!planResp.ok || !planData?.ok || !planData.plan) {
          throw new Error(planData?.error || '编排计划生成失败');
        }
        addChatMessage({
          id: `msg-agent-plan-${Date.now()}`,
          role: 'assistant',
          content: planData.plan.understanding || '已生成多能力编排计划，请确认后逐步执行。',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          question: textToSubmit,
          agentPlan: planData.plan as AgentPlanData,
          dataSourceId: submitDSId,
        });
      } catch (err: any) {
        addChatMessage({
          id: `msg-err-agent-plan-${Date.now()}`,
          role: 'assistant',
          content: `编排计划生成失败：${err?.message || '请稍后重试'}`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          error: err?.message,
          dataSourceId: submitDSId,
        });
      } finally {
        setQueryLoading(false);
      }
      return;
    }

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

  // P1-7 Agent 编排卡片：批准执行（调 /api/agent/run 顺序执行并落结果消息）
  const handleApproveAgentPlan = async (msg: ChatMessage) => {
    if (!msg.agentPlan || isQueryLoading) return;
    setQueryLoading(true);
    const submitDSId = activeDataSourceId;
    try {
      const resp = await apiFetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: msg.agentPlan.planId, dataSourceId: activeDataSourceId }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !Array.isArray(data?.steps)) {
        throw new Error(data?.error || '编排执行失败');
      }
      addChatMessage({
        id: `msg-agent-run-${Date.now()}`,
        role: 'assistant',
        content: data.finalSummary || '编排执行完成。',
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        question: msg.question,
        agentRun: { ok: data.ok === true, finalSummary: data.finalSummary || '', steps: data.steps } as AgentRunData,
        ...(typeof data.traceId === 'string' && data.traceId ? { traceId: data.traceId } : {}),
        dataProvenance: 'live',
        dataSourceId: submitDSId,
      });
    } catch (err: any) {
      addChatMessage({
        id: `msg-err-agent-run-${Date.now()}`,
        role: 'assistant',
        content: `编排执行失败：${err?.message || '请稍后重试'}`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        error: err?.message,
        dataSourceId: submitDSId,
      });
    } finally {
      setQueryLoading(false);
    }
  };

  return { handleSendQuery, handleApproveAgentPlan };
}
