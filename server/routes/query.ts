/**
 * 问数路由（挂载于 /api/query 前缀，与 queryContext.ts 并列）。
 *
 * 端点清单：
 * - POST /natural-language      智能问数主链路（HTTP 参数解析 + SSE 发射器装配 → queryService 编排 → 响应映射）
 * - GET  /stream-replay/:traceId SSE 断线续传（重放缓冲事件，不重新执行 SQL）
 * - GET  /trace/:traceId         推导过程回放（仅本人或管理员）
 * - POST /plan                   计划模式（先出计划，用户批准后执行）
 * - POST /feedback               反馈闭环（点赞沉淀 few-shot 样例）
 * - POST /execute-sql            SQL 重跑（SELECT-only 安全执行层）
 * - POST /sql-assist             SQL AI 助手（解释/优化）
 * - POST /drill                  图表点击下钻
 *
 * 关键设计：本文件只做 HTTP 层职责（参数解析 / 状态码与响应体映射 / SSE 流写入）；
 * /natural-language 的六层防护、缓存、审计、追踪等编排一律下沉至 server/query/queryService.ts。
 * 除 stream-replay/trace 只读端点外，其余均经 rateLimiter + authMiddleware + 角色白名单；
 * 所有 SQL 执行一律走 executeSafeSql 安全执行层，路由层不直接拼 SQL。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '../infra/errorCodes';
import { authMiddleware, requireRole } from '../auth/auth';
import { rateLimiter } from '../infra/rateLimiter';
import { sanitizeQuestion } from '../query/queryGuard';
import { checkUserQueryLimit, acquireQuerySlot, releaseQuerySlot } from '../infra/userQueryLimit';
import { writeAudit } from '../infra/auditLog';
import { loadSchemaContext, isLiveCapableType } from '../query/schemaContext';
import { callLLMText, validateModelSelection, setLlmOverride } from '../llm/llmClient';
import { buildColumnNames } from '../query/liveQuery';
import { runDrill } from '../query/drill';
import { executeSafeSql } from '../query/sqlExecutor';
import { saveFeedback } from '../query/queryFeedback';
import { checkDataSourceAccess } from '../auth/accessControl';
import { maskRows } from '../query/dlp';
import { newTraceId } from '../query/queryTrace';
import { generateQueryPlan, storePlan } from '../query/queryPlan';
import { appendQueryEvent } from '../query/sseReplayBuffer';
import { logger } from '../infra/logger';
import { runNaturalLanguageQuery, replayTraceStream, fetchTraceSteps, type QueryEventSink } from '../query/queryService';

const router = Router();

// 3. 智能问数主端点（NL2SQL / 分析）：自然语言 → SQL → 真实执行 → 图表/解读
// 路由层职责：解析请求体 → 装配 SSE 发射器（重放缓冲 + 流写入）→ 调用应用服务 → 映射响应
router.post('/natural-language', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const body = req.body || {};
  // M1 推导留痕 / P2-5 续传锚点：请求级 traceId（SSE 重放缓冲以它为键，须在发射器之前生成）
  const traceId = newTraceId();
  const stream = body.stream === true;
  let sseStarted = false;

  // P2-7 SSE：客户端请求流式时，live 链路按阶段推送事件（早期校验错误仍返 JSON，前端按 Content-Type 区分）
  const sink: QueryEventSink = {
    send(event, data) {
      if (!stream || res.writableEnded) return;
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
    },
    started: () => sseStarted,
    // 正常结束（writableEnded）不触发：仅客户端提前断开时回调，服务侧据此立即释放并发槽
    onClientClose(listener) {
      res.on('close', () => {
        if (!res.writableEnded) listener();
      });
    },
  };

  const outcome = await runNaturalLanguageQuery({
    user,
    traceId,
    dataSourceId: typeof body.dataSourceId === 'string' ? body.dataSourceId : '',
    rawQuery: body.query,
    history: body.history,
    schemaHint: body.schema,
    model: body.model,
    amountUnit: body.amountUnit,
    stream,
    refreshCache: body.refreshCache === true,
    deepAnalysis: body.deepAnalysis === true,
    planId: typeof body.planId === 'string' ? body.planId : '',
  }, sink);

  // 响应映射：早退/兜底错误 → JSON；结果体 → 流式 SSE(终态事件) 或 JSON（演示模式恒 JSON）
  if (outcome.kind === 'json') return res.status(outcome.status).json(outcome.body);
  if (outcome.kind === 'stream-error') {
    res.end();
    return;
  }
  if (stream && outcome.streamAware) {
    sink.send(outcome.event, outcome.body);
    res.end();
    return;
  }
  return res.json(outcome.body);
});

// 3a-0. P2-5 SSE 断线续传（Last-Event-ID 语义）：重连按 traceId 回放已完成阶段，不重新执行 SQL。
// 路由层只解析路径/游标并实现写流出口；回放/订阅/去重机制在 queryService.replayTraceStream。
router.get('/stream-replay/:traceId', authMiddleware, async (req, res) => {
  const user = req.user!;
  // Last-Event-ID 头（SSE 标准语义）与 ?after= 查询参数双支持（fetch 重试无法自动带头）
  const after = Math.max(0, Number(req.headers['last-event-id'] ?? req.query.after) || 0);
  const outcome = replayTraceStream({
    traceId: String(req.params.traceId || ''),
    after,
    userId: user.id,
    isAdmin: user.role === 'ADMIN',
    outlet: {
      beginStream: () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      },
      writeRaw: (chunk) => {
        try {
          res.write(chunk);
        } catch {
          // 客户端再次断开：由 req close 监听统一清理
        }
      },
      end: () => {
        try { res.end(); } catch { /* 已断开 */ }
      },
      onClientClose: (listener) => { req.on('close', listener); },
    },
  });
  if (outcome.kind === 'json') return res.status(outcome.status).json(outcome.body);
});

// 3a-1. M1 推导过程回放：按 traceId 返回一次问数的全链路步骤（仅本人或管理员可查）
router.get('/trace/:traceId', authMiddleware, async (req, res) => {
  const user = req.user!;
  const out = await fetchTraceSteps(String(req.params.traceId || ''), user.id, user.role === 'ADMIN');
  return res.status(out.status).json(out.body);
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
    const canPlan = isLiveCapableType(ctx.dsType, ctx.fileBacked) && dsIdStr.length > 0;
    if (!canPlan) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '计划模式仅支持真实数据源（数据库型或已导入数据的文件型）' });
    }
    const plan = await generateQueryPlan(clean.question, ctx.schema);
    await storePlan(plan, user.id, dsIdStr);
    writeAudit({ ...auditBase, question: clean.question, status: 'SUCCESS', detail: `分析计划 ${plan.steps.length} 步（${plan.complexity}）`, durationMs: Date.now() - startedAt });
    return res.json({ success: true, plan, expiresInSec: 600 });
  } catch (err: any) {
    logger.error('[Plan] generate failed:', err?.message || err);
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
    logger.error('[Feedback] save failed:', err);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '反馈保存失败' });
  }
});

// 3c. API Endpoint: SQL 重跑（P0：SQL 预览弹窗的真实执行入口）
// 复用 SELECT-only 安全执行层；数据库型与已落库文件型（v0.9.34 upl_*）数据源可执行
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
    return res.status(status).json({ error: outcome.reason === 'UNSUPPORTED_DS_TYPE' ? '该数据源类型不支持 SQL 真实执行（支持数据库型与已导入落库的文件型数据源）' : outcome.reason });
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
    logger.error('[SqlAssist] failed:', err?.message || err);
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
    return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
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
