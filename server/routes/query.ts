/**
 * P1-4 问数路由（从 server.ts 拆出，挂载于 /api/query 前缀下，与 queryContext.ts 并列）：
 * - POST /natural-language 智能问数主链路（L1-L6 六层防护 + live/simulated 双链路 + SSE）
 * - GET  /trace/:traceId  M1 推导过程回放
 * - POST /plan            M2 计划模式（先出计划后批准执行）
 * - POST /feedback        P1 反馈闭环（点赞沉淀 few-shot 样例）
 * - POST /execute-sql     SQL 重跑（SELECT-only 安全执行层）
 * - POST /sql-assist      SQL AI 助手（解释/优化）
 * - POST /drill           P2-2 图表点击下钻
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '../errorCodes';
import { authMiddleware, requireRole } from '../auth';
import { rateLimiter } from '../rateLimiter';
import { sanitizeQuestion, sanitizeHistory } from '../queryGuard';
import { checkUserQueryLimit, acquireQuerySlot, releaseQuerySlot } from '../userQueryLimit';
import { writeAudit } from '../auditLog';
import { loadSchemaContext } from '../schemaContext';
import { callLLMText, validateModelSelection, setLlmOverride, ChatMessage } from '../llmClient';
import { runLiveQuery, buildColumnNames, normalizeAmountUnit, enrichRefusalReason } from '../liveQuery';
import { runSimulatedQuery } from '../simulatedQuery';
import { runDrill } from '../drill';
import { executeSafeSql } from '../sqlExecutor';
import { saveFeedback } from '../queryFeedback';
import { checkDataSourceAccess } from '../accessControl';
import { recordConversation } from '../conversationHistory';
import { getCachedQuery, setCachedQuery, cacheKey, getSemanticCachedQuery } from '../queryCache';
import { maskQueryPayload, maskRows } from '../dlp';
import { newTraceId, recordTraceStep, getTraceSteps, TraceMeta } from '../queryTrace';
import { generateQueryPlan, storePlan, consumePlan, QueryPlan } from '../queryPlan';
import { emitBeforeQuery, emitAfterQuery } from '../queryHooks';
import { appendQueryEvent, getEventsAfter, getTraceOwner, isTerminal, isTerminalEvent, subscribeTrace, BufferedSseEvent } from '../sseReplayBuffer';
import { generateFallbackQueryResult } from '../../serverFallbacks';
import { normalizeQueryResult } from '../../src/utils/queryResultNormalizer';

const router = Router();

// 3. API Endpoint: Natural Language Query to Analysis (NL2SQL / Analytics)
router.post('/natural-language', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { schema, dataSourceId } = req.body;
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'query' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  // L2 权限层：Service 侧复核（与路由 requireRole 构成 Controller+Service 双层校验）
  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无问数权限`, durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '当前角色没有智能问数权限' });
  }

  // P2-11 数据源访问控制：非 ADMIN 需命中部门/个人授权清单
  if (auditBase.dataSourceId && !(await checkDataSourceAccess(user, auditBase.dataSourceId))) {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: '无数据源访问权限（ACL）', durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.DS_ACCESS_DENIED, error: '没有该数据源的访问权限，可向管理员申请开通' });
  }

  // L1 输入层：控制字符过滤 + 注入特征拒绝 + 500 字截断
  const clean = sanitizeQuestion(req.body.query);
  if (clean.ok !== true) {
    writeAudit({ ...auditBase, question: typeof req.body.query === 'string' ? req.body.query : '', status: 'DENIED_INPUT', detail: clean.reason, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: clean.reason });
  }
  const query = clean.question;

  // 模型自选：请求指定引擎/模型时校验并在本请求上下文内切换（AsyncLocalStorage 传递，非法值直接拒绝）
  const bodyModel = req.body.model && typeof req.body.model === 'object' ? req.body.model : {};
  const modelSel = validateModelSelection(bodyModel.engine, bodyModel.model);
  if (modelSel && 'error' in modelSel) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: modelSel.error, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: modelSel.error });
  }
  if (modelSel && 'engine' in modelSel) setLlmOverride({ engine: modelSel.engine, model: modelSel.model });
  const modelVariant = modelSel && 'engine' in modelSel ? `${modelSel.engine}:${modelSel.model}` : '';

  // 金额单位自选（亿元/百万元/万元/元）：白名单外直接拒绝，避免非法值静默落入默认口径
  const amountUnit = normalizeAmountUnit(req.body.amountUnit);
  if (req.body.amountUnit != null && req.body.amountUnit !== '' && !amountUnit) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: `非法金额单位：${String(req.body.amountUnit).slice(0, 20)}`, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' });
  }
  // 单位进缓存键：显式选单位与不选（依赖知识库默认口径）分别缓存，防口径互串
  const cacheVariant = [modelVariant, amountUnit || ''].filter(Boolean).join(':');

  // L5 频率层：每用户 20 次/小时滑动窗口
  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: limit.reason });
  }

  // L5 频率层：同用户并发限 1（昂贵的 LLM 调用串行化）；slotToken 绑定本次请求，释放时比对防误删
  const slotToken = randomUUID();
  if (!(await acquireQuerySlot(user.id, slotToken))) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_RATE', detail: '存在进行中的查询', durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.QUERY_IN_FLIGHT, error: '上一个查询仍在进行中，请等待完成后再试' });
  }

  // 客户端断开（前端 200s 超时 abort / 刷新页面 / 网络闪断）时立即释放并发槽，
  // 让用户可以马上发起新查询；旧链路继续跑完，finally 里的释放因 token 已不匹配而为 no-op，
  // 不会误删新请求的槽。正常结束时 writableEnded 为 true，不会重复释放。
  res.on('close', () => {
    if (!res.writableEnded) void releaseQuerySlot(user.id, slotToken);
  });

  // P2-7 SSE：客户端请求流式时，live 链路按阶段推送事件（早期校验错误仍返 JSON，前端按 Content-Type 区分）
  const streamMode = req.body.stream === true;
  // M1 推导留痕：每次问数生成唯一 traceId，全链路步骤旁路落库，响应携带供前端回放。
  // P2-5：声明提前到 sseSend 之前（SSE 事件入重放缓冲以 traceId 为键，块作用域要求先声明）
  const traceId = newTraceId();
  let sseStarted = false;
  const sseSend = (event: string, data: any) => {
    if (!streamMode || res.writableEnded) return;
    // P2-5 断线续传：事件先入重放缓冲（分配单调递增序号作为 SSE id），再写流。
    // 客户端断开后 res.write 静默失败不阻断 LLM 链路，事件仍入缓冲，
    // 客户端可凭 traceId + 已收序号经 GET /stream-replay 续传，不重新执行 SQL。
    const payload = JSON.stringify(data);
    const seq = appendQueryEvent(traceId, user.id, event, payload);
    if (!sseStarted) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseStarted = true;
    }
    try {
      res.write(`id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`);
    } catch {
      // 客户端已断开：事件已入重放缓冲，链路继续执行
    }
  };
  const respond = (payload: any, event = 'done') => {
    if (streamMode) {
      sseSend(event, payload);
      res.end();
      return;
    }
    return res.json(payload);
  };

  // P2-10 生命周期钩子：进入/结束事件广播（审计、缓存与未来插件可挂接）
  const hookCtx = {
    userId: user.id,
    username: user.username,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
    question: query,
    startedAt,
    meta: { stream: streamMode, ...(modelVariant ? { model: modelVariant } : {}) },
  };
  emitBeforeQuery(hookCtx);

  try {
    // L3 上下文层：落库 schema + scope 白名单 + 敏感列过滤 + 5min 缓存（不信任前端提交的 schema）
    // 必须在并发槽获取之后的同一 try 内执行：StateStore/DB 异常时 finally 才能保证释放槽，
    // 否则一次抛错会把该用户的并发槽永久卡死（内存模式无 TTL 时只能重启恢复）
    const ctx = await loadSchemaContext(dataSourceId, schema);

    // 数据源级 AI 开关：数据源被停用（disconnected）后拒绝问数
    if (ctx.status === 'disconnected') {
      writeAudit({ ...auditBase, question: query, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
      return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
    }

    const effectiveSchema = ctx.schema;
    const schemaGuidance = ctx.guidance;
    const defense = { sensitiveFiltered: ctx.sensitiveRemoved.length, truncated: clean.truncated };

    // L4 历史层：assistant 输出一律丢弃（防回流污染），user 消息逐条过注入检测，最多 5 轮
    const sanitizedHistory: ChatMessage[] = sanitizeHistory(req.body.history);

    // P0 双阶段真实执行：对落库的数据库型数据源启用（mysql/postgresql/greenplum，LLM 生成 SQL → 安全执行 → 真实 rows 回喂分析）
    const canRunLive = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && typeof dataSourceId === 'string' && dataSourceId.length > 0;
    const traceMeta: TraceMeta = { userId: user.id, username: user.username, dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '', question: query };
    if (canRunLive) {
      // M2 计划模式：携带已批准 planId 时校验有效性（过期/越权/问题不匹配 → 409 提示重新制定）
      let approvedPlan: QueryPlan | undefined;
      const reqPlanId = typeof req.body.planId === 'string' ? req.body.planId : '';
      if (reqPlanId) {
        const consumed = await consumePlan(reqPlanId, user.id, dataSourceId);
        if (consumed.ok !== true) {
          writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: consumed.reason, durationMs: Date.now() - startedAt });
          return res.status(409).json({ code: ERROR_CODES.PLAN_INVALID, error: consumed.reason });
        }
        if (consumed.plan.question !== query) {
          writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: '提交问题与计划不匹配', durationMs: Date.now() - startedAt });
          return res.status(409).json({ code: ERROR_CODES.PLAN_MISMATCH, error: '提交的问题与分析计划不匹配，请重新制定计划' });
        }
        approvedPlan = consumed.plan;
      }

      // P1-6 结果缓存：L1 归一化精确 + L2 embedding 语义（阈值默认 0.95，同域近似问题 0.85~0.95 区间误命中会答非所问，宁缺毋滥）；
      // 缓存键含模型变体，避免跨模型串用；refreshCache=true 跳过缓存读（用户对缓存结果的强制刷新入口）
      const ck = cacheKey(dataSourceId, query, cacheVariant);
      const skipCacheRead = req.body.refreshCache === true;
      const cached = skipCacheRead ? null : await getCachedQuery(ck);
      if (cached) {
        writeAudit({ ...auditBase, question: query, status: 'CACHE', executedSql: String(cached.executedSql || ''), rowCount: typeof cached.rowCount === 'number' ? cached.rowCount : -1, durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
        // P2-12 DLP：缓存中为原始数据，响应出口按角色脱敏（ADMIN 豁免）
        return respond(maskQueryPayload({ ...cached, fromCache: true, executionTimeMs: Date.now() - startedAt }, user));
      }
      // L2 语义缓存：同义改写问题复用最近成功结果，命中携带原问题供前端标注「来自相似问题缓存」
      const semHit = skipCacheRead ? null : await getSemanticCachedQuery(dataSourceId, query, cacheVariant);
      if (semHit) {
        const similarity = Number(semHit.similarity.toFixed(4));
        writeAudit({ ...auditBase, question: query, status: 'CACHE', detail: `L2 语义命中（相似度 ${similarity}）：${semHit.matchedQuestion.slice(0, 120)}`, executedSql: String(semHit.payload?.executedSql || ''), rowCount: typeof semHit.payload?.rowCount === 'number' ? semHit.payload.rowCount : -1, durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
        return respond(maskQueryPayload({ ...semHit.payload, fromCache: true, semanticCache: { matchedQuestion: semHit.matchedQuestion, similarity }, executionTimeMs: Date.now() - startedAt }, user));
      }

      const live = await runLiveQuery({
        query,
        history: sanitizedHistory,
        schema: effectiveSchema,
        guidance: schemaGuidance,
        dataSourceId,
        dataSourceName: ctx.dataSourceName,
        dsType: ctx.dsType || undefined,
        sensitiveRemoved: ctx.sensitiveRemoved,
        rowFilters: ctx.rowFilters,
        allowIntrospection: ctx.allowIntrospection,
        approvedPlan,
        deepAnalysis: req.body.deepAnalysis === true,
        amountUnit,
        userId: user.id,
        traceId,
        // P2-5：stage 事件携带 traceId，前端收到首个阶段事件即可记录续传锚点
        onStage: streamMode ? (stage, info) => sseSend('stage', { stage, traceId, ...(info || {}) }) : undefined,
        // M1 推导留痕：旁路落库 + 流式模式下实时推送步骤详情（前端步骤器展示）
        onTrace: (step) => {
          void recordTraceStep(traceId, traceMeta, step);
          if (streamMode) sseSend('trace', { traceId, ...step });
        },
      });
      if (live.ok === 'clarify') {
        // 歧义澄清：不执行 SQL，先把澄清问题与候选理解返回前端，由用户确认后重新提交
        writeAudit({ ...auditBase, question: query, status: 'CLARIFY', detail: live.clarification.question.slice(0, 200), durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'CLARIFY', durationMs: Date.now() - startedAt });
        return respond({
          success: true,
          executionTimeMs: Date.now() - startedAt,
          needClarification: true,
          clarification: live.clarification,
          defense,
          dataProvenance: 'live',
          traceId,
        }, 'clarify');
      }
      if (live.ok === 'refuse') {
        // 拒答：问题与数据源无关/超出能力，如实反馈（不走演示数据托底）；小模型照抄模板句时兜底增强理由
        const refuseReason = enrichRefusalReason(live.reason, effectiveSchema);
        writeAudit({ ...auditBase, question: query, status: 'REFUSED', detail: refuseReason.slice(0, 200), durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'REFUSED', durationMs: Date.now() - startedAt });
        recordConversation({ userId: user.id, username: user.username, dataSourceId, question: query, answerSummary: refuseReason.slice(0, 200), status: 'REFUSED', provenance: 'live', durationMs: Date.now() - startedAt }).catch((e: any) => console.error('[Conversation] record failed:', e?.message || e));
        return respond({
          success: true,
          executionTimeMs: Date.now() - startedAt,
          refused: true,
          refuseReason,
          defense,
          dataProvenance: 'live',
          traceId,
        }, 'refuse');
      }
      if (live.ok === true) {
        const normalized = normalizeQueryResult(live.result);
        if (normalized) {
          writeAudit({ ...auditBase, question: query, status: 'SUCCESS', executedSql: live.executedSql, rowCount: live.rowCount, durationMs: Date.now() - startedAt });
          emitAfterQuery(hookCtx, { status: 'SUCCESS', executedSql: live.executedSql, rowCount: live.rowCount, durationMs: Date.now() - startedAt });
          const basePayload = { success: true, result: normalized, defense, dataProvenance: 'live' };
          // L1 精确 + L2 语义索引一并写入（含原问题与 embedding，供同义改写命中）
          await setCachedQuery(ck, { ...basePayload, executedSql: live.executedSql, rowCount: live.rowCount }, { dataSourceId, question: query, variant: cacheVariant });
          // 对话历史服务端落库：成功问答 fire-and-forget 落库（历史面板 + 个人 few-shot 自学习），失败不阻断主链路
          recordConversation({ userId: user.id, username: user.username, dataSourceId, question: query, executedSql: live.executedSql, answerSummary: String((normalized as any).aiExplanation || ''), status: 'SUCCESS', provenance: 'live', rowCount: live.rowCount, durationMs: Date.now() - startedAt }).catch((e: any) => console.error('[Conversation] record failed:', e?.message || e));
          // P2-12 DLP：缓存已写入原始数据（上方 setCachedQuery），响应出口按角色脱敏
          return respond(maskQueryPayload({ ...basePayload, traceId, executionTimeMs: Date.now() - startedAt }, user));
        }
      }
      // 真实执行链路失败：审计留痕后降级演示模式（可用性优先）
      writeAudit({
        ...auditBase,
        question: query,
        status: 'FALLBACK',
        detail: String(live.ok === true ? 'LLM 分析结果结构校验失败' : live.error).slice(0, 200),
        executedSql: live.executedSql,
        durationMs: Date.now() - startedAt,
      });
      emitAfterQuery(hookCtx, { status: 'FALLBACK', durationMs: Date.now() - startedAt });
      // 对话历史落库：降级路径同样留痕（状态 FALLBACK，不参与个人 few-shot 检索）
      recordConversation({ userId: user.id, username: user.username, dataSourceId, question: query, executedSql: live.executedSql, answerSummary: String(live.ok === true ? 'LLM 分析结果结构校验失败' : live.error).slice(0, 200), status: 'FALLBACK', provenance: 'live', durationMs: Date.now() - startedAt }).catch((e: any) => console.error('[Conversation] record failed:', e?.message || e));
      const fallbackRaw = generateFallbackQueryResult(query, effectiveSchema);
      return respond({
        success: true,
        executionTimeMs: Date.now() - startedAt,
        isFallback: true,
        result: normalizeQueryResult(fallbackRaw)!,
        defense,
        dataProvenance: 'simulated',
        traceId,
      });
    }

    // 演示模式（非 mysql / 未落库数据源）：LLM 单阶段生成模拟数据，响应显式标记 simulated（生成逻辑见 server/simulatedQuery）
    // P0 性能优化：演示模式同样走 L1 精确 + L2 语义缓存（CSV/Demo 数据源相似提问从 ~60s 降至 ~30ms）；
    // 与 live 链路共用缓存键机制；refreshCache=true 跳过缓存读（用户强制刷新入口）
    const simCk = cacheKey(dataSourceId, query, cacheVariant);
    const skipSimCacheRead = req.body.refreshCache === true;
    const simCached = skipSimCacheRead ? null : await getCachedQuery(simCk);
    if (simCached) {
      writeAudit({ ...auditBase, question: query, status: 'CACHE', durationMs: Date.now() - startedAt });
      emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
      return res.json({ ...simCached, fromCache: true, executionTimeMs: Date.now() - startedAt });
    }
    const simSemHit = skipSimCacheRead ? null : await getSemanticCachedQuery(dataSourceId, query, cacheVariant);
    if (simSemHit) {
      const similarity = Number(simSemHit.similarity.toFixed(4));
      writeAudit({ ...auditBase, question: query, status: 'CACHE', detail: `L2 语义命中（相似度 ${similarity}）：${simSemHit.matchedQuestion.slice(0, 120)}`, durationMs: Date.now() - startedAt });
      emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
      return res.json({ ...simSemHit.payload, fromCache: true, semanticCache: { matchedQuestion: simSemHit.matchedQuestion, similarity }, executionTimeMs: Date.now() - startedAt });
    }
    const sim = await runSimulatedQuery({ query, history: sanitizedHistory, schema: effectiveSchema, guidance: schemaGuidance });
    if (sim.ok === 'refuse') {
      // 拒答：问题与数据源无关/超出能力，如实反馈（不生成演示数据托底）；小模型照抄模板句时兜底增强理由
      const refuseReason = enrichRefusalReason(sim.reason, effectiveSchema);
      writeAudit({ ...auditBase, question: query, status: 'REFUSED', detail: refuseReason.slice(0, 200), durationMs: Date.now() - startedAt });
      recordConversation({ userId: user.id, username: user.username, dataSourceId: auditBase.dataSourceId, question: query, answerSummary: refuseReason.slice(0, 200), status: 'REFUSED', provenance: 'simulated', durationMs: Date.now() - startedAt }).catch((e: any) => console.error('[Conversation] record failed:', e?.message || e));
      return res.json({
        success: true,
        executionTimeMs: Date.now() - startedAt,
        refused: true,
        refuseReason,
        defense,
        dataProvenance: 'simulated',
      });
    }
    if (sim.ok === true) {
      // L6 审计层：成功落账
      writeAudit({ ...auditBase, question: query, status: 'SUCCESS', durationMs: Date.now() - startedAt });
      // P0 性能优化：演示模式成功结果写缓存（与 live 同机制，含 L2 语义索引），相似提问直接复用
      await setCachedQuery(simCk, { success: true, result: sim.result, defense, dataProvenance: 'simulated' }, { dataSourceId, question: query, variant: cacheVariant });
      // 对话历史落库：演示模式问答同样留痕（provenance=simulated，不参与个人 few-shot 检索）
      recordConversation({ userId: user.id, username: user.username, dataSourceId: auditBase.dataSourceId, question: query, executedSql: String(sim.parsed?.generatedSQL || ''), answerSummary: String(sim.parsed?.aiExplanation || ''), status: 'SUCCESS', provenance: 'simulated', durationMs: Date.now() - startedAt }).catch((e: any) => console.error('[Conversation] record failed:', e?.message || e));
      return res.json({
        success: true,
        executionTimeMs: Date.now() - startedAt,
        result: sim.result,
        defense,
        dataProvenance: 'simulated',
      });
    }

    // L6 审计层：降级落账（记录触发降级的错误）
    writeAudit({ ...auditBase, question: query, status: 'FALLBACK', detail: sim.error.slice(0, 200), durationMs: Date.now() - startedAt });
    recordConversation({ userId: user.id, username: user.username, dataSourceId: auditBase.dataSourceId, question: query, answerSummary: sim.error.slice(0, 200), status: 'FALLBACK', provenance: 'simulated', durationMs: Date.now() - startedAt }).catch((e: any) => console.error('[Conversation] record failed:', e?.message || e));
    return res.json({
      success: true,
      executionTimeMs: Date.now() - startedAt,
      isFallback: true,
      result: normalizeQueryResult(generateFallbackQueryResult(query, effectiveSchema))!,
      defense,
      dataProvenance: 'simulated',
    });
  } catch (err: any) {
    // 兜底：链路未捕获异常（LLM 通道 / DB / StateStore 等）。槽释放由 finally 保证；
    // 此处补齐响应，避免请求挂起与 unhandledRejection（Express 4 不会自动接管 async 路由异常）
    console.error('[Query] natural-language failed:', err?.message || err);
    writeAudit({ ...auditBase, question: query, status: 'ERROR', detail: String(err?.message || err).slice(0, 200), durationMs: Date.now() - startedAt });
    emitAfterQuery(hookCtx, { status: 'ERROR', durationMs: Date.now() - startedAt });
    if (sseStarted) {
      sseSend('error', { error: '查询处理异常，请稍后重试' });
      res.end();
    } else {
      res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '查询处理异常，请稍后重试' });
    }
  // 注意：finally 必须挂在外层 try 上，确保 DENIED_SWITCH 等早退路径也释放并发槽
  } finally {
    await releaseQuerySlot(user.id, slotToken);
  }
});

// 3a-0. P2-5 SSE 断线续传（Last-Event-ID 语义）：重连按 traceId 回放已完成阶段，不重新执行 SQL。
// 缓冲未命中（已过期 / 多实例部署落在无缓冲节点）返回 404，由前端降级为完整重试。
router.get('/stream-replay/:traceId', authMiddleware, async (req, res) => {
  const user = req.user!;
  const traceId = String(req.params.traceId || '');
  if (!/^tr_[A-Za-z0-9_]{6,40}$/.test(traceId)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'traceId 不合法' });
  }
  const owner = getTraceOwner(traceId);
  if (owner === null) {
    return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '流式会话不存在或已过期，请重新发起查询' });
  }
  if (owner !== user.id && user.role !== 'ADMIN') {
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '无权续传他人的查询会话' });
  }
  // Last-Event-ID 头（SSE 标准语义）与 ?after= 查询参数双支持（fetch 重试无法自动带头）
  const after = Math.max(0, Number(req.headers['last-event-id'] ?? req.query.after) || 0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  let lastSent = after;
  let ended = false;
  const finish = (unsubscribe?: () => void, timer?: ReturnType<typeof setTimeout>) => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    if (timer) clearTimeout(timer);
    try { res.end(); } catch { /* 已断开 */ }
  };
  // 返回 true 表示写入的是终态事件；seq 去重保证回放/订阅竞态下不重不漏
  const writeEvent = (e: BufferedSseEvent): boolean => {
    if (e.seq <= lastSent) return isTerminalEvent(e.event);
    lastSent = e.seq;
    try {
      res.write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${e.data}\n\n`);
    } catch {
      // 客户端再次断开：由 req close 监听统一清理
    }
    return isTerminalEvent(e.event);
  };

  // 先回放存量（断线期间已完成的事件即时补齐）
  for (const e of getEventsAfter(traceId, after)?.events ?? []) writeEvent(e);
  if (isTerminal(traceId)) { finish(); return; }

  // 未终态：订阅增量推送，直到终态到达或 5 分钟兜底超时
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribeTrace(traceId, (e) => {
    if (writeEvent(e)) finish(unsubscribe, timer);
  });
  // 订阅挂上后补一次漏（回放与订阅之间可能到达的新事件）
  for (const e of getEventsAfter(traceId, lastSent)?.events ?? []) writeEvent(e);
  if (isTerminal(traceId)) { finish(unsubscribe); return; }
  timer = setTimeout(() => finish(unsubscribe), 5 * 60 * 1000);
  timer.unref?.();
  req.on('close', () => finish(unsubscribe, timer));
});

// 3a-1. M1 推导过程回放：按 traceId 返回一次问数的全链路步骤（仅本人或管理员可查）
router.get('/trace/:traceId', authMiddleware, async (req, res) => {
  const user = req.user as { id: number; role: string };
  const traceId = String(req.params.traceId || '');
  if (!/^tr_[A-Za-z0-9_]{6,40}$/.test(traceId)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'traceId 不合法' });
  }
  try {
    const { steps, ownerUserId } = await getTraceSteps(traceId);
    if (steps.length === 0) return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '未找到该推导记录' });
    if (ownerUserId !== user.id && user.role !== 'ADMIN') {
      return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '无权查看他人的推导过程' });
    }
    return res.json({ traceId, steps });
  } catch (err) {
    console.error('[Trace] fetch failed:', err);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '推导记录获取失败' });
  }
});

// 3a-2. M2 计划模式：先由 LLM 生成分析计划（不执行），用户批准后携带 planId 提交问数
router.post('/plan', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { schema, dataSourceId } = req.body || {};
  const dsIdStr = typeof dataSourceId === 'string' ? dataSourceId : '';
  const auditBase = { userId: user.id, username: user.username, endpoint: 'query' as const, dataSourceId: dsIdStr };

  const clean = sanitizeQuestion(req.body.query);
  if (clean.ok !== true) {
    writeAudit({ ...auditBase, question: typeof req.body.query === 'string' ? req.body.query : '', status: 'DENIED_INPUT', detail: clean.reason, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: clean.reason });
  }

  // P2-11 数据源访问控制
  if (dsIdStr && !(await checkDataSourceAccess(user, dsIdStr))) {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: '无数据源访问权限（ACL）', durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.DS_ACCESS_DENIED, error: '没有该数据源的访问权限，可向管理员申请开通' });
  }
  const bodyModel = req.body.model && typeof req.body.model === 'object' ? req.body.model : {};
  const modelSel = validateModelSelection(bodyModel.engine, bodyModel.model);
  if (modelSel && 'error' in modelSel) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: modelSel.error });
  }
  if (modelSel && 'engine' in modelSel) setLlmOverride({ engine: modelSel.engine, model: modelSel.model });

  const planSlotToken = randomUUID();
  if (!(await acquireQuerySlot(user.id, planSlotToken))) {
    return res.status(429).json({ code: ERROR_CODES.QUERY_IN_FLIGHT, error: '上一个查询仍在进行中，请等待完成后再试' });
  }
  try {
    // 计划模式仅支持真实可执行的数据库型数据源（演示模式无执行意义）
    const ctx = await loadSchemaContext(dataSourceId, schema);
    if (ctx.status === 'disconnected') {
      return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
    }
    const canPlan = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && dsIdStr.length > 0;
    if (!canPlan) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '计划模式仅支持真实连接的数据库型数据源' });
    }
    const plan = await generateQueryPlan(clean.question, ctx.schema);
    await storePlan(plan, user.id, dsIdStr);
    writeAudit({ ...auditBase, question: clean.question, status: 'SUCCESS', detail: `分析计划 ${plan.steps.length} 步（${plan.complexity}）`, durationMs: Date.now() - startedAt });
    return res.json({ success: true, plan, expiresInSec: 600 });
  } catch (err: any) {
    console.error('[Plan] generate failed:', err?.message || err);
    writeAudit({ ...auditBase, question: clean.question, status: 'ERROR', detail: String(err?.message || err).slice(0, 200), durationMs: Date.now() - startedAt });
    return res.status(500).json({ code: ERROR_CODES.LLM_UNAVAILABLE, error: '分析计划生成失败，请稍后重试' });
  } finally {
    await releaseQuerySlot(user.id, planSlotToken);
  }
});

// 3b. API Endpoint: 问数反馈（P1 反馈闭环）
// 点赞/点踩落库；点赞的 live 问答自动成为 few-shot 样例
router.post('/feedback', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const { dataSourceId, question, sql, verdict, provenance } = req.body || {};
  if (verdict !== 'UP' && verdict !== 'DOWN') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '反馈类型无效' });
  }
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少问题内容' });
  }
  try {
    await saveFeedback({
      userId: req.user!.id,
      username: req.user!.username,
      dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
      question: question.trim(),
      executedSql: typeof sql === 'string' ? sql : '',
      verdict,
      provenance: typeof provenance === 'string' ? provenance : '',
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Feedback] save failed:', err);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '反馈保存失败' });
  }
});

// 3c. API Endpoint: SQL 重跑（P0：SQL 预览弹窗的真实执行入口）
// 复用 SELECT-only 安全执行层；仅落库 mysql 数据源可执行
router.post('/execute-sql', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { dataSourceId, sql } = req.body || {};
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'query' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  if (typeof dataSourceId !== 'string' || !dataSourceId || typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'dataSourceId 与 sql 必填' });
  }
  // P2-11 数据源访问控制
  if (!(await checkDataSourceAccess(user, dataSourceId))) {
    writeAudit({ ...auditBase, question: `exec:${sql.slice(0, 120)}`, status: 'DENIED_AUTH', detail: '无数据源访问权限（ACL）', durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.DS_ACCESS_DENIED, error: '没有该数据源的访问权限，可向管理员申请开通' });
  }
  // v0.4.13：灵活查询可组合多指标/多筛选/HAVING，复杂 SQL 放宽至 10000 字符
  if (sql.length > 10000) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'SQL 长度超出限制' });
  }

  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: `exec:${sql.slice(0, 120)}`, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: limit.reason });
  }

  const ctx = await loadSchemaContext(dataSourceId, undefined);
  if (ctx.status === 'disconnected') {
    return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
  }

  // v0.4.14：maxRows 不传（用服务端默认 100000），与灵活查询 LIMIT 放宽对齐
  const outcome = await executeSafeSql(dataSourceId, sql, ctx.schema, ctx.sensitiveRemoved, undefined, ctx.rowFilters);
  if (outcome.ok !== true) {
    const status = outcome.reason === 'UNSUPPORTED_DS_TYPE' ? 400 : 422;
    writeAudit({ ...auditBase, question: `exec:${sql.slice(0, 120)}`, status: 'DENIED_INPUT', detail: outcome.reason.slice(0, 200), durationMs: Date.now() - startedAt });
    return res.status(status).json({ error: outcome.reason === 'UNSUPPORTED_DS_TYPE' ? '仅 MySQL / PostgreSQL / Greenplum 数据源支持 SQL 真实执行' : outcome.reason });
  }

  // P1-3：AST 解析失败放行补审计（status=FALLBACK，detail 标记 AST_FALLBACK）
  const durationMs = Date.now() - startedAt;
  // P2-9：慢查询治理（执行时长 > 3s 或行数 > 10 万，detail 前缀标记 SLOW）
  const isSlow = durationMs > 3000 || outcome.result.rowCount > 100000;
  const slowPrefix = isSlow ? 'SLOW: ' : '';
  if (outcome.result.astFallback === true) {
    writeAudit({ ...auditBase, question: `exec:${sql.slice(0, 120)}`, status: 'FALLBACK', detail: `${slowPrefix}AST_FALLBACK: AST 解析失败，正则白名单兜底放行`, executedSql: outcome.result.finalSql, rowCount: outcome.result.rowCount, durationMs });
  } else {
    writeAudit({ ...auditBase, question: `exec:${sql.slice(0, 120)}`, status: 'SUCCESS', detail: isSlow ? `${slowPrefix}执行时长 ${durationMs}ms，行数 ${outcome.result.rowCount}` : undefined, executedSql: outcome.result.finalSql, rowCount: outcome.result.rowCount, durationMs });
  }
  // P2-12 DLP：执行结果按角色脱敏（VIEWER/ANALYST 敏感列掩码，ADMIN 豁免）
  const dlpOut = maskRows(outcome.result.rows, user);
  return res.json({
    success: true,
    executionTimeMs: Date.now() - startedAt,
    rows: dlpOut.rows,
    rowCount: outcome.result.rowCount,
    truncated: outcome.result.truncated,
    finalSql: outcome.result.finalSql,
    dataProvenance: 'live',
    ...(dlpOut.maskedColumns.length > 0 ? { dlp: { maskedColumns: dlpOut.maskedColumns, maskedLabels: dlpOut.maskedLabels } } : {}),
  });
});

// 3d. API Endpoint: SQL AI 助手（借鉴 Chat2DB 的 SQL 解释/优化）
// 纯文本输出；只读分析场景不支持方言转换
router.post('/sql-assist', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const { action, sql } = req.body || {};
  if (action !== 'explain' && action !== 'optimize') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'action 仅支持 explain / optimize' });
  }
  if (typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少 SQL 内容' });
  }
  if (sql.length > 10000) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'SQL 长度超出限制' });
  }

  const system =
    action === 'explain'
      ? '你是 SQL 解释专家。用简明中文分点解释给定 MySQL SELECT 查询：查了什么表、筛选条件、聚合口径、输出列的业务含义。150 字以内，纯文本，不要使用 markdown。'
      : '你是 MySQL 查询优化专家。针对给定 SELECT 查询给出可落地的优化建议：索引建议、写法改写、潜在性能风险。分点列出，200 字以内，纯文本，不要使用 markdown。若无需优化直接说明。';
  try {
    const text = (await callLLMText(system, sql.trim())).trim();
    return res.json({ success: true, text: text || '（AI 未返回内容）' });
  } catch (err: any) {
    console.error('[SqlAssist] failed:', err?.message || err);
    return res.status(502).json({ code: ERROR_CODES.LLM_UNAVAILABLE, error: 'AI 服务暂时不可用，请稍后重试' });
  }
});

// 3e. P2-2 报表图表点击下钻：根据原聚合 SQL + 维度值生成明细查询
router.post('/drill', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { dataSourceId, originalSql, dimensionKey, dimensionValue } = req.body || {};

  if (
    typeof dataSourceId !== 'string' || !dataSourceId ||
    typeof originalSql !== 'string' || !originalSql.trim() ||
    typeof dimensionKey !== 'string' || !dimensionKey.trim() ||
    (typeof dimensionValue !== 'string' && typeof dimensionValue !== 'number')
  ) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'dataSourceId、originalSql、dimensionKey、dimensionValue 必填' });
  }
  if (originalSql.length > 10000) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'SQL 长度超出限制' });
  }
  // P2-11 数据源访问控制
  if (!(await checkDataSourceAccess(user, dataSourceId))) {
    return res.status(403).json({ code: ERROR_CODES.DS_ACCESS_DENIED, error: '没有该数据源的访问权限，可向管理员申请开通' });
  }

  const ctx = await loadSchemaContext(dataSourceId, undefined);
  if (ctx.status === 'disconnected') {
    return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已 被管理员停用' });
  }

  const outcome = await runDrill({
    dataSourceId,
    originalSql,
    dimensionKey,
    dimensionValue,
    schema: ctx.schema,
    sensitiveRemoved: ctx.sensitiveRemoved,
    rowFilters: ctx.rowFilters,
  });

  if (outcome.ok !== true) {
    return res.status(422).json({ code: ERROR_CODES.SQL_REJECTED, error: outcome.error });
  }
  // 明细表头中文化：schema 列业务含义映射（下钻为 SELECT *，列名即原始字段名）
  const columnNames = buildColumnNames(outcome.rows, ctx.schema);
  // P2-12 DLP：钻取明细按角色脱敏
  const dlpOut = maskRows(outcome.rows, user);
  return res.json({
    success: true,
    executionTimeMs: Date.now() - startedAt,
    rows: dlpOut.rows,
    rowCount: outcome.rowCount,
    finalSql: outcome.finalSql,
    columnNames,
    ...(dlpOut.maskedColumns.length > 0 ? { dlp: { maskedColumns: dlpOut.maskedColumns, maskedLabels: dlpOut.maskedLabels } } : {}),
  });
});

export default router;
