/**
 * 问数应用服务层（质量优化 Stage 3.2）：承接 `/natural-language` 主链路编排。
 *
 * 职责：L1-L6 六层防护调用（输入净化 / 权限复核 / 上下文装载 / 历史净化 / 频率限制 / 审计留痕）、
 * 结果缓存（L1 精确 + L2 语义）、live/simulated 双链路、Fallback 三层策略、推导留痕（M1）、
 * 生命周期钩子（P2-10）、SSE 阶段事件发射（P2-7/P2-5）与对话历史落库。
 *
 * 边界：本模块不直接触碰 HTTP 响应对象——增量 SSE 事件经 QueryEventSink 发射，
 * 最终响应以 QueryOutcome 返回，由路由完成状态码 / JSON / SSE 终态映射。
 */
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { ERROR_CODES } from '../infra/errorCodes';
import { sanitizeQuestion, sanitizeHistory } from './queryGuard';
import { checkUserQueryLimit, acquireQuerySlot, releaseQuerySlot } from '../infra/userQueryLimit';
import { writeAudit } from '../infra/auditLog';
import { loadSchemaContext, isLiveCapableType } from './schemaContext';
import { setLlmOverride, validateModelSelection, type ChatMessage } from '../llm/llmClient';
import { runLiveQuery, buildColumnNames, normalizeAmountUnit, enrichRefusalReason } from './liveQuery';
import { runSimulatedQuery } from './simulatedQuery';
import { executeSafeSql } from './sqlExecutor';
import { getCachedQuery, setCachedQuery, cacheKey, getSemanticCachedQuery } from './queryCache';
import { maskQueryPayload } from './dlp';
import { recordTraceStep, getTraceSteps, type TraceMeta } from './queryTrace';
import { consumePlan, type QueryPlan } from './queryPlan';
import { emitBeforeQuery, emitAfterQuery } from './queryHooks';
import { getEventsAfter, getTraceOwner, isTerminal, isTerminalEvent, subscribeTrace, type BufferedSseEvent } from './sseReplayBuffer';
import { generateFallbackQueryResult } from '../serverFallbacks';
import { normalizeQueryResult } from '../../src/utils/queryResultNormalizer';
import { getPool } from '../infra/db';
import { retrieveBestFewShot } from '../utils/fewShotService';
import { logger } from '../infra/logger';
import { resolveStageTwoFailure } from '../utils/fallback/fallbackPipeline.js';
import { recordConversation } from './conversationHistory';
import { checkDataSourceAccess } from '../auth/accessControl';
import type { AuthUser } from '../auth/auth';
import { getErrorMessage } from '../infra/errorUtils';

/**
 * 请求入口参数：由路由完成 HTTP 层解析（字段提取 / 布尔归一化 / dataSourceId 兜底空串）后传入。
 * 校验类错误（角色 / ACL / 净化 / 模型 / 金额单位 / 限流）属 L1-L5 防护，在服务内判定并以 QueryOutcome 返回。
 */
export interface NaturalLanguageParams {
  /** 已鉴权用户（authMiddleware 注入） */
  user: AuthUser;
  /** 请求级 traceId（SSE 重放缓冲键 / 推导留痕 / 审计关联） */
  traceId: string;
  /** 已归一化数据源 ID（非字符串或缺失 → ''） */
  dataSourceId: string;
  /** 原始问题（未净化；仅用于审计留痕） */
  rawQuery: unknown;
  /** 客户端历史（不可信，服务侧 sanitizeHistory 净化） */
  history: unknown;
  /** 前端提交的 schema 提示（不可信，经 loadSchemaContext 复核） */
  schemaHint: unknown;
  /** 模型自选字段（原始值） */
  model: unknown;
  /** 金额单位（原始值） */
  amountUnit: unknown;
  /** P2-7 流式模式（已归一化布尔） */
  stream: boolean;
  refreshCache: boolean;
  deepAnalysis: boolean;
  /** M2 计划模式已批准 planId（缺失 → ''） */
  planId: string;
}

/** 增量 SSE 事件发射器：由路由实现（重放缓冲 + HTTP 流写入），服务侧只声明发射语义 */
export interface QueryEventSink {
  /** 发射一个 SSE 事件（非流式模式或连接已结束时为 no-op） */
  send(event: string, data: unknown): void;
  /** 是否已写出首个 SSE 事件（异常兜底分支据此选择 SSE error 事件或 JSON 500） */
  started(): boolean;
  /** 注册客户端提前断开回调（正常结束不触发；用于立即释放并发槽） */
  onClientClose(listener: () => void): void;
}

/** 编排结果：由路由映射为 HTTP 响应 */
export type QueryOutcome =
  /** 直接 JSON 响应（全部早退 4xx 与 SSE 未开始时的异常兜底 5xx） */
  | { kind: 'json'; status: number; body: unknown }
  /** 200 结果体：streamAware=true 且流式模式下由路由发 SSE(event)+end，否则 JSON */
  | { kind: 'result'; event: string; body: unknown; streamAware: boolean }
  /** 异常兜底：SSE 已开始，error 事件已发，路由只需 end */
  | { kind: 'stream-error' };

/**
 * 智能问数主链路编排（原 server/routes/query.ts 内联实现原样下沉）。
 * 调用方：POST /natural-language（rateLimiter + authMiddleware + requireRole 之后）。
 */
export async function runNaturalLanguageQuery(
  params: NaturalLanguageParams,
  sink: QueryEventSink
): Promise<QueryOutcome> {
  const startedAt = Date.now();
  const { user, traceId, dataSourceId } = params;
  const streamMode = params.stream;
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'query' as const,
    dataSourceId,
  };

  // L2 权限层：Service 侧复核（与路由 requireRole 构成 Controller+Service 双层校验）
  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无问数权限`, durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 403, body: { code: ERROR_CODES.FORBIDDEN, error: '当前角色没有智能问数权限' } };
  }

  // P2-11 数据源访问控制：非 ADMIN 需命中部门/个人授权清单
  if (auditBase.dataSourceId && !(await checkDataSourceAccess(user, auditBase.dataSourceId))) {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: '无数据源访问权限（ACL）', durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 403, body: { code: ERROR_CODES.DS_ACCESS_DENIED, error: '没有该数据源的访问权限，可向管理员申请开通' } };
  }

  // L1 输入层：控制字符过滤 + 注入特征拒绝 + 500 字截断
  const clean = sanitizeQuestion(params.rawQuery);
  if (clean.ok !== true) {
    writeAudit({ ...auditBase, question: typeof params.rawQuery === 'string' ? params.rawQuery : '', status: 'DENIED_INPUT', detail: clean.reason, durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 400, body: { code: ERROR_CODES.INVALID_INPUT, error: clean.reason } };
  }
  const query = clean.question;

  // 模型自选：请求指定引擎/模型时校验并在本请求上下文内切换（AsyncLocalStorage 传递，非法值直接拒绝）
  const bodyModel = (params.model && typeof params.model === 'object' ? params.model : {}) as { engine?: unknown; model?: unknown };
  const modelSel = validateModelSelection(bodyModel.engine, bodyModel.model);
  if (modelSel && 'error' in modelSel) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: modelSel.error, durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 400, body: { code: ERROR_CODES.INVALID_INPUT, error: modelSel.error } };
  }
  if (modelSel && 'engine' in modelSel) setLlmOverride({ engine: modelSel.engine, model: modelSel.model });
  const modelVariant = modelSel && 'engine' in modelSel ? `${modelSel.engine}:${modelSel.model}` : '';

  // 金额单位自选（亿元/百万元/万元/元）：白名单外直接拒绝，避免非法值静默落入默认口径
  const amountUnit = normalizeAmountUnit(params.amountUnit);
  if (params.amountUnit != null && params.amountUnit !== '' && !amountUnit) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: `非法金额单位：${String(params.amountUnit).slice(0, 20)}`, durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 400, body: { code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' } };
  }
  // 单位进缓存键：显式选单位与不选（依赖知识库默认口径）分别缓存，防口径互串
  const cacheVariant = [modelVariant, amountUnit || ''].filter(Boolean).join(':');

  // L5 频率层：每用户 20 次/小时滑动窗口
  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 429, body: { code: ERROR_CODES.RATE_LIMITED, error: limit.reason } };
  }

  // L5 频率层：同用户并发限 1（昂贵的 LLM 调用串行化）；slotToken 绑定本次请求，释放时比对防误删
  const slotToken = randomUUID();
  if (!(await acquireQuerySlot(user.id, slotToken))) {
    writeAudit({ ...auditBase, question: query, status: 'DENIED_RATE', detail: '存在进行中的查询', durationMs: Date.now() - startedAt });
    return { kind: 'json', status: 429, body: { code: ERROR_CODES.QUERY_IN_FLIGHT, error: '上一个查询仍在进行中，请等待完成后再试' } };
  }

  // 客户端断开（前端 200s 超时 abort / 刷新页面 / 网络闪断）时立即释放并发槽，
  // 让用户可以马上发起新查询；旧链路继续跑完，finally 里的释放因 token 已不匹配而为 no-op，
  // 不会误删新请求的槽。正常结束时 writableEnded 为 true，不会重复释放（由路由的 sink 判定）。
  sink.onClientClose(() => {
    void releaseQuerySlot(user.id, slotToken);
  });

  // P2-10 生命周期钩子：进入/结束事件广播（审计、缓存与未来插件可挂接）
  const hookCtx = {
    userId: user.id,
    username: user.username,
    dataSourceId,
    question: query,
    startedAt,
    meta: { stream: streamMode, ...(modelVariant ? { model: modelVariant } : {}) },
  };
  emitBeforeQuery(hookCtx);

  try {
    // L3 上下文层：落库 schema + scope 白名单 + 敏感列过滤 + 5min 缓存（不信任前端提交的 schema）
    // 必须在并发槽获取之后的同一 try 内执行：StateStore/DB 异常时 finally 才能保证释放槽，
    // 否则一次抛错会把该用户的并发槽永久卡死（内存模式无 TTL 时只能重启恢复）
    const ctx = await loadSchemaContext(dataSourceId, params.schemaHint);

    // 数据源级 AI 开关：数据源被停用（disconnected）后拒绝问数
    if (ctx.status === 'disconnected') {
      writeAudit({ ...auditBase, question: query, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
      return { kind: 'json', status: 403, body: { code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' } };
    }

    const effectiveSchema = ctx.schema;
    const schemaGuidance = ctx.guidance;
    const defense = { sensitiveFiltered: ctx.sensitiveRemoved.length, truncated: clean.truncated };

    // L4 历史层：assistant 输出一律丢弃（防回流污染），user 消息逐条过注入检测，最多 5 轮
    const sanitizedHistory: ChatMessage[] = sanitizeHistory(params.history);

    // P0 双阶段真实执行：数据库型数据源 + 已落库文件数据源（v0.9.34）启用（LLM 生成 SQL → 安全执行 → 真实 rows 回喂分析）
    const canRunLive = isLiveCapableType(ctx.dsType, ctx.fileBacked) && dataSourceId.length > 0;
    const traceMeta: TraceMeta = { userId: user.id, username: user.username, dataSourceId, question: query };
    if (canRunLive) {
      // M2 计划模式：携带已批准 planId 时校验有效性（过期/越权/问题不匹配 → 409 提示重新制定）
      let approvedPlan: QueryPlan | undefined;
      if (params.planId) {
        const consumed = await consumePlan(params.planId, user.id, dataSourceId);
        if (consumed.ok !== true) {
          writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: consumed.reason, durationMs: Date.now() - startedAt });
          return { kind: 'json', status: 409, body: { code: ERROR_CODES.PLAN_INVALID, error: consumed.reason } };
        }
        if (consumed.plan.question !== query) {
          writeAudit({ ...auditBase, question: query, status: 'DENIED_INPUT', detail: '提交问题与计划不匹配', durationMs: Date.now() - startedAt });
          return { kind: 'json', status: 409, body: { code: ERROR_CODES.PLAN_MISMATCH, error: '提交的问题与分析计划不匹配，请重新制定计划' } };
        }
        approvedPlan = consumed.plan;
      }

      // P1-6 结果缓存：L1 归一化精确 + L2 embedding 语义（阈值默认 0.95，同域近似问题 0.85~0.95 区间误命中会答非所问，宁缺毋滥）；
      // 缓存键含模型变体，避免跨模型串用；refreshCache=true 跳过缓存读（用户对缓存结果的强制刷新入口）
      const ck = cacheKey(dataSourceId, query, cacheVariant);
      const skipCacheRead = params.refreshCache;
      const cached = skipCacheRead ? null : await getCachedQuery(ck);
      if (cached) {
        writeAudit({ ...auditBase, question: query, status: 'CACHE', executedSql: String(cached.executedSql || ''), rowCount: typeof cached.rowCount === 'number' ? cached.rowCount : -1, durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
        // P2-12 DLP：缓存中为原始数据，响应出口按角色脱敏（ADMIN 豁免）
        return { kind: 'result', event: 'done', streamAware: true, body: maskQueryPayload({ ...cached, fromCache: true, executionTimeMs: Date.now() - startedAt }, user) };
      }
      // L2 语义缓存：同义改写问题复用最近成功结果，命中携带原问题供前端标注「来自相似问题缓存」
      const semHit = skipCacheRead ? null : await getSemanticCachedQuery(dataSourceId, query, cacheVariant);
      if (semHit) {
        const similarity = Number(semHit.similarity.toFixed(4));
        writeAudit({ ...auditBase, question: query, status: 'CACHE', detail: `L2 语义命中（相似度 ${similarity}）：${semHit.matchedQuestion.slice(0, 120)}`, executedSql: String(semHit.payload?.executedSql || ''), rowCount: typeof semHit.payload?.rowCount === 'number' ? semHit.payload.rowCount : -1, durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
        return { kind: 'result', event: 'done', streamAware: true, body: maskQueryPayload({ ...semHit.payload, fromCache: true, semanticCache: { matchedQuestion: semHit.matchedQuestion, similarity }, executionTimeMs: Date.now() - startedAt }, user) };
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
        deepAnalysis: params.deepAnalysis,
        amountUnit,
        userId: user.id,
        traceId,
        // P2-5：stage 事件携带 traceId，前端收到首个阶段事件即可记录续传锚点
        onStage: streamMode ? (stage, info) => sink.send('stage', { stage, traceId, ...(info || {}) }) : undefined,
        // M1 推导留痕：旁路落库 + 流式模式下实时推送步骤详情（前端步骤器展示）
        onTrace: (step) => {
          void recordTraceStep(traceId, traceMeta, step);
          if (streamMode) sink.send('trace', { traceId, ...step });
        },
      });
      if (live.ok === 'clarify') {
        // 歧义澄清：不执行 SQL，先把澄清问题与候选理解返回前端，由用户确认后重新提交
        writeAudit({ ...auditBase, question: query, status: 'CLARIFY', detail: live.clarification.question.slice(0, 200), durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'CLARIFY', durationMs: Date.now() - startedAt });
        return {
          kind: 'result',
          event: 'clarify',
          streamAware: true,
          body: {
            success: true,
            executionTimeMs: Date.now() - startedAt,
            needClarification: true,
            clarification: live.clarification,
            defense,
            dataProvenance: 'live',
            traceId,
          },
        };
      }
      if (live.ok === 'refuse') {
        // 拒答：问题与数据源无关/超出能力，如实反馈（不走演示数据托底）；小模型照抄模板句时兜底增强理由
        const refuseReason = enrichRefusalReason(live.reason, effectiveSchema);
        writeAudit({ ...auditBase, question: query, status: 'REFUSED', detail: refuseReason.slice(0, 200), durationMs: Date.now() - startedAt });
        emitAfterQuery(hookCtx, { status: 'REFUSED', durationMs: Date.now() - startedAt });
        recordConversation({ userId: user.id, username: user.username, dataSourceId, question: query, answerSummary: refuseReason.slice(0, 200), status: 'REFUSED', provenance: 'live', durationMs: Date.now() - startedAt }).catch((e: unknown) => logger.error('[Conversation] record failed:', getErrorMessage(e)));
        return {
          kind: 'result',
          event: 'refuse',
          streamAware: true,
          body: {
            success: true,
            executionTimeMs: Date.now() - startedAt,
            refused: true,
            refuseReason,
            defense,
            dataProvenance: 'live',
            traceId,
          },
        };
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
          recordConversation({ userId: user.id, username: user.username, dataSourceId, question: query, executedSql: live.executedSql, answerSummary: String(normalized.aiExplanation || ''), status: 'SUCCESS', provenance: 'live', rowCount: live.rowCount, durationMs: Date.now() - startedAt }).catch((e: unknown) => logger.error('[Conversation] record failed:', getErrorMessage(e)));
          // P2-12 DLP：缓存已写入原始数据（上方 setCachedQuery），响应出口按角色脱敏
          return { kind: 'result', event: 'done', streamAware: true, body: maskQueryPayload({ ...basePayload, traceId, executionTimeMs: Date.now() - startedAt }, user) };
        }
      }
      // 真实执行链路失败：触发 Fallback 三层策略（rule_based → simpler_prompt → human_approval）
      const failedSql = live.executedSql || 'unknown';
      const fallbackStart = Date.now();

      try {
        // Step 1: 调用 Fallback 调度器（v0.9.47 P0：schema 注入 + 三项依赖真实落库，三层策略全部接通）
        const fallbackResult = await resolveStageTwoFailure(
          query,
          failedSql,
          {
            dsId: dataSourceId,
            userId: String(user.id), // user.id is number, convert to string
            schema: effectiveSchema,
          },
          {
            logger,
            // v0.9.47 P0：困难样本真实落库 adversarial_samples（表早已建好，此前为 console.log 占位）
            persistHardNegative: async (sample) => {
              const [result] = await getPool().query<ResultSetHeader>(
                `INSERT INTO adversarial_samples (original_query, original_sql, error_message, data_source_id, user_id, username)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [sample.originalQuery.slice(0, 500), sample.originalSql.slice(0, 2000),
                 (sample.errorMessage || '').slice(0, 500), sample.dataSourceId,
                 parseInt(sample.userId, 10) || 0, user.username]
              );
              return String(result.insertId ?? '');
            },
            // v0.9.47 P0：策略成功审计真实落库 fallback_audit_log
            logFallbackAudit: async (_sql: string, params: unknown[]) => {
              const [dsId, q, sql, strategy] = params;
              await getPool().query(
                `INSERT INTO fallback_audit_log (trace_id, query, failed_sql, used_strategy, latency_ms, success)
                 VALUES (?, ?, ?, ?, ?, 1)`,
                [traceId, String(q).slice(0, 500), String(sql).slice(0, 2000), String(strategy), Date.now() - fallbackStart]
              );
            },
            // v0.9.47 P0：human_approval 策略复用已审核 few-shot 示例（对抗训练闭环）
            retrieveApprovedFewShot: (q, dsId) => retrieveBestFewShot(q, dsId),
          }
        );

        const fallbackLatency = Date.now() - fallbackStart;

        if (fallbackResult.success && fallbackResult.sql) {
          // ✅ Fallback 策略成功生成 SQL → 真实安全执行
          //（v0.9.47 P0：原代码把 SQL 字符串直接传 normalizeQueryResult → 必然 null，fallback 成功结果被静默丢弃）
          // SELECT-only 白名单 + 行级权限与主链路同口径
          const fallbackExec = await executeSafeSql(dataSourceId, fallbackResult.sql, effectiveSchema, ctx.sensitiveRemoved, 500, ctx.rowFilters);
          if (fallbackExec.ok === true) {
            const rows = fallbackExec.result.rows;
            const normalized = normalizeQueryResult({
              generatedSQL: fallbackResult.sql,
              thoughtProcess: [`Fallback 策略（${fallbackResult.strategy}）重新生成并成功执行`],
              aiExplanation: fallbackResult.explanation || '降级策略已为您重新生成查询结果。',
              keyInsights: [],
              chartConfig: null,
              rows,
              columnNames: buildColumnNames(rows, effectiveSchema),
            });
            if (normalized) {
              // 先构造再传（audit 扩展字段 fallbackLatencyMs/fallbackStrategy 不在 AuditEntry 类型上，
              // 中间变量模式与原实现一致，规避对象字面量 excess property check）
              const auditWithFallback = {
                ...auditBase,
                question: query,
                status: 'SUCCESS' as const,
                detail: `Fallback strategy used: ${fallbackResult.strategy}`,
                executedSql: fallbackResult.sql,
                durationMs: Date.now() - startedAt,
                rowCount: rows.length,
                fallbackLatencyMs: fallbackLatency,
                fallbackStrategy: fallbackResult.strategy
              };
              writeAudit(auditWithFallback);
              emitAfterQuery(hookCtx, { status: 'SUCCESS', durationMs: Date.now() - startedAt });
              return {
                kind: 'result',
                event: 'done',
                streamAware: true,
                body: {
                  success: true,
                  result: normalized,
                  defense,
                  dataProvenance: 'fallback',
                  isFallback: true,
                  traceId,
                  executionTimeMs: Date.now() - startedAt,
                  fallbackInfo: {
                    strategy: fallbackResult.strategy,
                    explanation: fallbackResult.explanation,
                    latencyMs: fallbackLatency
                  }
                },
              };
            }
          }

          // 策略生成了 SQL 但安全执行失败：落入下方统一降级
          console.warn(`[Fallback] Strategy ${fallbackResult.strategy} produced SQL but safe execution failed`);
        }

        // ❌ 所有策略均失败
        console.warn(`[Fallback] All strategies exhausted after ${fallbackLatency}ms`, fallbackResult.error);
      } catch (err) {
        console.error('[Fallback] Exception during resolution:', err instanceof Error ? err.message : err);
      }

      // 降级为演示模式（可用性优先）
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
      recordConversation({ userId: user.id, username: user.username, dataSourceId, question: query, executedSql: live.executedSql, answerSummary: String(live.ok === true ? 'LLM 分析结果结构校验失败' : live.error).slice(0, 200), status: 'FALLBACK', provenance: 'live', durationMs: Date.now() - startedAt }).catch((e: unknown) => logger.error('[Conversation] record failed:', getErrorMessage(e)));
      const fallbackRaw = generateFallbackQueryResult(query, effectiveSchema);
      return {
        kind: 'result',
        event: 'done',
        streamAware: true,
        body: {
          success: true,
          executionTimeMs: Date.now() - startedAt,
          isFallback: true,
          result: normalizeQueryResult(fallbackRaw)!,
          defense,
          dataProvenance: 'simulated',
          traceId,
        },
      };
    }

    // 演示模式（非 mysql / 未落库数据源）：LLM 单阶段生成模拟数据，响应显式标记 simulated（生成逻辑见 server/simulatedQuery）
    // P0 性能优化：演示模式同样走 L1 精确 + L2 语义缓存（CSV/Demo 数据源相似提问从 ~60s 降至 ~30ms）；
    // 与 live 链路共用缓存键机制；refreshCache=true 跳过缓存读（用户强制刷新入口）
    const simCk = cacheKey(dataSourceId, query, cacheVariant);
    const skipSimCacheRead = params.refreshCache;
    const simCached = skipSimCacheRead ? null : await getCachedQuery(simCk);
    if (simCached) {
      writeAudit({ ...auditBase, question: query, status: 'CACHE', durationMs: Date.now() - startedAt });
      emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
      // 演示模式响应保持 JSON（不随 stream 模式切换为 SSE 终态事件，与原实现一致）
      return { kind: 'result', event: 'done', streamAware: false, body: { ...simCached, fromCache: true, executionTimeMs: Date.now() - startedAt } };
    }
    const simSemHit = skipSimCacheRead ? null : await getSemanticCachedQuery(dataSourceId, query, cacheVariant);
    if (simSemHit) {
      const similarity = Number(simSemHit.similarity.toFixed(4));
      writeAudit({ ...auditBase, question: query, status: 'CACHE', detail: `L2 语义命中（相似度 ${similarity}）：${simSemHit.matchedQuestion.slice(0, 120)}`, durationMs: Date.now() - startedAt });
      emitAfterQuery(hookCtx, { status: 'CACHE', durationMs: Date.now() - startedAt });
      return { kind: 'result', event: 'done', streamAware: false, body: { ...simSemHit.payload, fromCache: true, semanticCache: { matchedQuestion: simSemHit.matchedQuestion, similarity }, executionTimeMs: Date.now() - startedAt } };
    }
    const sim = await runSimulatedQuery({ query, history: sanitizedHistory, schema: effectiveSchema, guidance: schemaGuidance });
    if (sim.ok === 'refuse') {
      // 拒答：问题与数据源无关/超出能力，如实反馈（不生成演示数据托底）；小模型照抄模板句时兜底增强理由
      const refuseReason = enrichRefusalReason(sim.reason, effectiveSchema);
      writeAudit({ ...auditBase, question: query, status: 'REFUSED', detail: refuseReason.slice(0, 200), durationMs: Date.now() - startedAt });
      recordConversation({ userId: user.id, username: user.username, dataSourceId: auditBase.dataSourceId, question: query, answerSummary: refuseReason.slice(0, 200), status: 'REFUSED', provenance: 'simulated', durationMs: Date.now() - startedAt }).catch((e: unknown) => logger.error('[Conversation] record failed:', getErrorMessage(e)));
      return {
        kind: 'result',
        event: 'done',
        streamAware: false,
        body: {
          success: true,
          executionTimeMs: Date.now() - startedAt,
          refused: true,
          refuseReason,
          defense,
          dataProvenance: 'simulated',
        },
      };
    }
    if (sim.ok === true) {
      // L6 审计层：成功落账
      writeAudit({ ...auditBase, question: query, status: 'SUCCESS', durationMs: Date.now() - startedAt });
      // P0 性能优化：演示模式成功结果写缓存（与 live 同机制，含 L2 语义索引），相似提问直接复用
      await setCachedQuery(simCk, { success: true, result: sim.result, defense, dataProvenance: 'simulated' }, { dataSourceId, question: query, variant: cacheVariant });
      // 对话历史落库：演示模式问答同样留痕（provenance=simulated，不参与个人 few-shot 检索）
      recordConversation({ userId: user.id, username: user.username, dataSourceId: auditBase.dataSourceId, question: query, executedSql: String(sim.parsed?.generatedSQL || ''), answerSummary: String(sim.parsed?.aiExplanation || ''), status: 'SUCCESS', provenance: 'simulated', durationMs: Date.now() - startedAt }).catch((e: unknown) => logger.error('[Conversation] record failed:', getErrorMessage(e)));
      return {
        kind: 'result',
        event: 'done',
        streamAware: false,
        body: {
          success: true,
          executionTimeMs: Date.now() - startedAt,
          result: sim.result,
          defense,
          dataProvenance: 'simulated',
        },
      };
    }

    // L6 审计层：降级落账（记录触发降级的错误）
    writeAudit({ ...auditBase, question: query, status: 'FALLBACK', detail: sim.error.slice(0, 200), durationMs: Date.now() - startedAt });
    recordConversation({ userId: user.id, username: user.username, dataSourceId: auditBase.dataSourceId, question: query, answerSummary: sim.error.slice(0, 200), status: 'FALLBACK', provenance: 'simulated', durationMs: Date.now() - startedAt }).catch((e: unknown) => logger.error('[Conversation] record failed:', getErrorMessage(e)));
    return {
      kind: 'result',
      event: 'done',
      streamAware: false,
      body: {
        success: true,
        executionTimeMs: Date.now() - startedAt,
        isFallback: true,
        result: normalizeQueryResult(generateFallbackQueryResult(query, effectiveSchema))!,
        defense,
        dataProvenance: 'simulated',
      },
    };
  } catch (err) {
    // 兜底：链路未捕获异常（LLM 通道 / DB / StateStore 等）。槽释放由 finally 保证；
    // SSE 已开始时以 error 事件收尾（避免 JSON 落在已发送的流上），否则返回 500 JSON 由路由映射
    logger.error('[Query] natural-language failed:', getErrorMessage(err));
    writeAudit({ ...auditBase, question: query, status: 'ERROR', detail: String(getErrorMessage(err)).slice(0, 200), durationMs: Date.now() - startedAt });
    emitAfterQuery(hookCtx, { status: 'ERROR', durationMs: Date.now() - startedAt });
    if (sink.started()) {
      sink.send('error', { error: '查询处理异常，请稍后重试' });
      return { kind: 'stream-error' };
    }
    return { kind: 'json', status: 500, body: { code: ERROR_CODES.INTERNAL_ERROR, error: '查询处理异常，请稍后重试' } };
  // 注意：finally 必须挂在外层 try 上，确保 DENIED_SWITCH 等早退路径也释放并发槽
  } finally {
    await releaseQuerySlot(user.id, slotToken);
  }
}

/**
 * M1 推导过程回放读取：按 traceId 返回一次问数的全链路步骤。
 * 仅本人或管理员可查；traceId 格式非法 → 400，无记录 → 404。原 /trace/:traceId 内联实现原样下沉。
 */
export async function fetchTraceSteps(
  traceId: string,
  userId: number,
  isAdmin: boolean
): Promise<{ status: number; body: unknown }> {
  if (!/^tr_[A-Za-z0-9_]{6,40}$/.test(traceId)) {
    return { status: 400, body: { code: ERROR_CODES.INVALID_INPUT, error: 'traceId 不合法' } };
  }
  try {
    const { steps, ownerUserId } = await getTraceSteps(traceId);
    if (steps.length === 0) {
      return { status: 404, body: { code: ERROR_CODES.NOT_FOUND, error: '未找到该推导记录' } };
    }
    if (ownerUserId !== userId && !isAdmin) {
      return { status: 403, body: { code: ERROR_CODES.FORBIDDEN, error: '无权查看他人的推导过程' } };
    }
    return { status: 200, body: { traceId, steps } };
  } catch (err) {
    logger.error('[Trace] fetch failed:', err);
    return { status: 500, body: { code: ERROR_CODES.INTERNAL_ERROR, error: '推导记录获取失败' } };
  }
}

/** 续传写流的最小出口：由路由实现（HTTP 响应头 / 原始帧写入 / 结束 / 断开监听） */
export interface TraceReplayOutlet {
  /** 写 200 SSE 响应头（text/event-stream 四件套） */
  beginStream(): void;
  /** 原始帧写入（:ok 哨兵与事件帧；实现方自行忽略已断开的写入异常） */
  writeRaw(chunk: string): void;
  /** 结束响应（实现方保证幂等/吞掉已断开异常） */
  end(): void;
  /** 注册客户端断开回调 */
  onClientClose(listener: () => void): void;
}

export interface TraceReplayInput {
  traceId: string;
  /** 客户端已收最大事件序号（Last-Event-ID / ?after= 归一化后的值） */
  after: number;
  userId: number;
  isAdmin: boolean;
  outlet: TraceReplayOutlet;
}

/** 续传结果：stream = 已开始写流（后续由 outlet 生命周期收尾）；json = 早退（格式/不存在/越权） */
export type TraceReplayOutcome = { kind: 'json'; status: number; body: unknown } | { kind: 'stream' };

/**
 * P2-5 SSE 断线续传（Last-Event-ID 语义）：按 traceId 回放已完成事件并订阅增量，
 * seq 去重保证回放/订阅竞态下不重不漏；终态到达或 5 分钟兜底超时后收尾。
 * 原 server/routes/query.ts 内联实现原样下沉（缓冲未命中返回 404，由前端降级为完整重试）。
 */
export function replayTraceStream(input: TraceReplayInput): TraceReplayOutcome {
  const { traceId, after, userId, isAdmin, outlet } = input;
  if (!/^tr_[A-Za-z0-9_]{6,40}$/.test(traceId)) {
    return { kind: 'json', status: 400, body: { code: ERROR_CODES.INVALID_INPUT, error: 'traceId 不合法' } };
  }
  const owner = getTraceOwner(traceId);
  if (owner === null) {
    return { kind: 'json', status: 404, body: { code: ERROR_CODES.NOT_FOUND, error: '流式会话不存在或已过期，请重新发起查询' } };
  }
  if (owner !== userId && !isAdmin) {
    return { kind: 'json', status: 403, body: { code: ERROR_CODES.FORBIDDEN, error: '无权续传他人的查询会话' } };
  }

  outlet.beginStream();
  outlet.writeRaw(':ok\n\n');

  let lastSent = after;
  let ended = false;
  const finish = (unsubscribe?: () => void, timer?: ReturnType<typeof setTimeout>) => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    if (timer) clearTimeout(timer);
    outlet.end();
  };
  // 返回 true 表示写入的是终态事件；seq 去重保证回放/订阅竞态下不重不漏
  const writeEvent = (e: BufferedSseEvent): boolean => {
    if (e.seq <= lastSent) return isTerminalEvent(e.event);
    lastSent = e.seq;
    outlet.writeRaw(`id: ${e.seq}\nevent: ${e.event}\ndata: ${e.data}\n\n`);
    return isTerminalEvent(e.event);
  };

  // 先回放存量（断线期间已完成的事件即时补齐）
  for (const e of getEventsAfter(traceId, after)?.events ?? []) writeEvent(e);
  if (isTerminal(traceId)) { finish(); return { kind: 'stream' }; }

  // 未终态：订阅增量推送，直到终态到达或 5 分钟兜底超时
  const timer = setTimeout(() => finish(unsubscribe), 5 * 60 * 1000);
  timer.unref?.();
  const unsubscribe = subscribeTrace(traceId, (e) => {
    if (writeEvent(e)) finish(unsubscribe, timer);
  });
  // 订阅挂上后补一次漏（回放与订阅之间可能到达的新事件）
  for (const e of getEventsAfter(traceId, lastSent)?.events ?? []) writeEvent(e);
  if (isTerminal(traceId)) {
    finish(unsubscribe, timer);
  } else {
    outlet.onClientClose(() => finish(unsubscribe, timer));
  }
  return { kind: 'stream' };
}
