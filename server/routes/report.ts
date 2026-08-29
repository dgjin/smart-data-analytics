/**
 * P1-4 报告路由（从 server.ts 拆出，挂载于 /api/report 前缀下）：
 * - POST /generate  高管报告生成（live 双阶段 / simulated 演示模式）
 * - POST /plan      M4 报告计划模式（先出查询计划后批准执行）
 * - POST /export    M4 报告导出 PPTX（body 含图表 base64 PNG，单独放宽 20mb 解析器）
 */
import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '../errorCodes';
import { authMiddleware, requireRole } from '../auth';
import { rateLimiter } from '../rateLimiter';
import { containsInjection } from '../queryGuard';
import { checkUserQueryLimit, acquireQuerySlot, releaseQuerySlot } from '../userQueryLimit';
import { writeAudit } from '../auditLog';
import { loadSchemaContext } from '../schemaContext';
import { runLiveReport, generateReportPlans, storeReportPlan, consumeReportPlan } from '../liveReport';
import { normalizeAmountUnit } from '../liveQuery';
import { runSimulatedReport } from '../simulatedReport';
import { getFallbackExecutiveReport } from '../../serverFallbacks';
import { normalizeExportData, buildReportPptx, buildExportFilename } from '../reportExport';
import { runPdfGenerator } from '../pdfExport';
import { normalizeReport } from '../../src/utils/queryResultNormalizer';
import { getPool } from '../db';
import { submitTask } from '../taskQueue';

const router = Router();

// 4. API Endpoint: Automatic Visual Analytics Executive Report Generation
router.post('/generate', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { templateType, customPrompt, dataSourceId, schema } = req.body;
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'report' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  // L2 权限层：Service 侧复核
  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无报告生成权限`, durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '当前角色没有报告生成权限' });
  }

  const safeTemplate = String(templateType || '综合经营分析').slice(0, 200);
  const safeCustom = String(customPrompt || '生成包含核心KPI、多维趋势图表与战略建议的决策简报').slice(0, 1000);
  const auditQuestion = `report:${safeTemplate}`;

  // v0.5.2 金额单位（亿元/百万元/万元/元）：白名单外直接拒绝，与问数链路口径一致
  const amountUnit = normalizeAmountUnit(req.body.amountUnit);
  if (req.body.amountUnit != null && req.body.amountUnit !== '' && !amountUnit) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: `非法金额单位：${String(req.body.amountUnit).slice(0, 20)}`, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' });
  }

  // L1 输入层：报告主题与自定义要求过注入特征检测
  if (containsInjection(safeTemplate) || containsInjection(safeCustom)) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: '报告参数包含注入特征', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报告参数包含不允许的指令内容' });
  }

  // L5 频率层：与智能问数共享用户配额与并发互斥
  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: limit.reason });
  }
  const reportSlotToken = randomUUID();
  if (!(await acquireQuerySlot(user.id, reportSlotToken))) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_RATE', detail: '存在进行中的查询', durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.QUERY_IN_FLIGHT, error: '上一个查询仍在进行中，请等待完成后再试' });
  }

  // L3 上下文层：报告同样以落库的 schema + scope + 敏感过滤为准
  const ctx = await loadSchemaContext(dataSourceId, schema);

  try {
    if (ctx.status === 'disconnected') {
      writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
      return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
    }
    const effectiveSchema = ctx.schema;
    const schemaGuidance = ctx.guidance;

    // M4 报告计划批准：携带 reportPlanId 时校验有效性（过期/越权/不匹配 → 409）
    let approvedPlans: Parameters<typeof runLiveReport>[0]['approvedPlans'];
    const reportPlanId = typeof req.body.reportPlanId === 'string' ? req.body.reportPlanId : '';
    if (reportPlanId) {
      const consumed = await consumeReportPlan(reportPlanId, user.id, dataSourceId, safeTemplate, amountUnit);
      if (consumed.ok !== true) {
        writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: consumed.reason, durationMs: Date.now() - startedAt });
        return res.status(409).json({ code: ERROR_CODES.PLAN_INVALID, error: consumed.reason });
      }
      approvedPlans = consumed.plan;
    }

    // P1 报表真实化：数据库型数据源走双阶段（查询计划 → 真实执行 → 真实数据摘要撰写）
    const canRunLive = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && typeof dataSourceId === 'string' && dataSourceId.length > 0;
    if (canRunLive) {
      const live = await runLiveReport({
        templateType: safeTemplate,
        customPrompt: safeCustom,
        schema: effectiveSchema,
        guidance: schemaGuidance,
        dataSourceId,
        dsType: ctx.dsType || undefined,
        sensitiveRemoved: ctx.sensitiveRemoved,
        rowFilters: ctx.rowFilters,
        amountUnit,
        ...(approvedPlans ? { approvedPlans } : {}),
      });
      if (live.ok === true) {
        const report = normalizeReport(live.report);
        if (report) {
          writeAudit({ ...auditBase, question: auditQuestion, status: 'SUCCESS', executedSql: live.executedSqls.join(' ; '), rowCount: live.totalRows, durationMs: Date.now() - startedAt });
          return res.json({ success: true, executionTimeMs: Date.now() - startedAt, report: { ...report, executedSqls: live.executedSqls }, dataProvenance: 'live' });
        }
      }
      writeAudit({
        ...auditBase,
        question: auditQuestion,
        status: 'FALLBACK',
        detail: String(live.ok === true ? '报表结构校验失败' : live.error).slice(0, 200),
        executedSql: live.executedSqls.join(' ; '),
        durationMs: Date.now() - startedAt,
      });
      return res.json({
        success: true,
        executionTimeMs: Date.now() - startedAt,
        isFallback: true,
        report: getFallbackExecutiveReport(safeTemplate, effectiveSchema),
        dataProvenance: 'simulated',
      });
    }

    // 演示模式（非 mysql / 未落库数据源）：LLM 单阶段生成演示报表，显式标记 simulated（生成逻辑见 server/simulatedReport）
    const sim = await runSimulatedReport({ templateType: safeTemplate, customPrompt: safeCustom, schema: effectiveSchema, guidance: schemaGuidance });
    if (sim.ok === true) {
      // L6 审计层：成功落账
      writeAudit({ ...auditBase, question: auditQuestion, status: 'SUCCESS', durationMs: Date.now() - startedAt });
      return res.json({ success: true, executionTimeMs: Date.now() - startedAt, report: sim.report, dataProvenance: 'simulated' });
    }
    // L6 审计层：降级落账
    writeAudit({ ...auditBase, question: auditQuestion, status: 'FALLBACK', detail: sim.error.slice(0, 200), durationMs: Date.now() - startedAt });
    return res.json({
      success: true,
      executionTimeMs: Date.now() - startedAt,
      isFallback: true,
      report: getFallbackExecutiveReport(safeTemplate, effectiveSchema),
      dataProvenance: 'simulated',
    });
  // finally 挂在外层 try，确保 DENIED_SWITCH 早退路径同样释放并发槽
  } finally {
    await releaseQuerySlot(user.id, reportSlotToken);
  }
});

// 4-pre. M4 报告计划模式：先由 LLM 生成报表查询计划（不执行），用户批准后携带 reportPlanId 提交生成
router.post('/plan', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { templateType, customPrompt, dataSourceId, schema } = req.body || {};
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'report' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无报告计划权限`, durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '当前角色没有报告生成权限' });
  }

  const safeTemplate = String(templateType || '综合经营分析').slice(0, 200);
  const safeCustom = String(customPrompt || '生成包含核心KPI、多维趋势图表与战略建议的决策简报').slice(0, 1000);
  if (containsInjection(safeTemplate) || containsInjection(safeCustom)) {
    writeAudit({ ...auditBase, question: `report-plan:${safeTemplate}`, status: 'DENIED_INPUT', detail: '报告参数包含注入特征', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报告参数包含不允许的指令内容' });
  }

  // v0.5.2 金额单位白名单校验（计划按当前单位生成 SQL，批准执行时校验口径一致）
  const amountUnit = normalizeAmountUnit(req.body.amountUnit);
  if (req.body.amountUnit != null && req.body.amountUnit !== '' && !amountUnit) {
    writeAudit({ ...auditBase, question: `report-plan:${safeTemplate}`, status: 'DENIED_INPUT', detail: `非法金额单位：${String(req.body.amountUnit).slice(0, 20)}`, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' });
  }

  const ctx = await loadSchemaContext(dataSourceId, schema);
  if (ctx.status === 'disconnected') {
    writeAudit({ ...auditBase, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
  }
  const canPlan = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && typeof dataSourceId === 'string' && dataSourceId.length > 0;
  if (!canPlan) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '仅数据库型数据源支持报表计划模式' });
  }

  try {
    const out = await generateReportPlans({
      templateType: safeTemplate,
      customPrompt: safeCustom,
      schema: ctx.schema,
      guidance: ctx.guidance,
      dataSourceId,
      dsType: ctx.dsType || undefined,
      sensitiveRemoved: ctx.sensitiveRemoved,
      amountUnit,
    });
    if (out.ok !== true) {
      writeAudit({ ...auditBase, question: `report-plan:${safeTemplate}`, status: 'FALLBACK', detail: out.error, durationMs: Date.now() - startedAt });
      return res.status(500).json({ code: ERROR_CODES.LLM_UNAVAILABLE, error: out.error });
    }
    const reportPlanId = await storeReportPlan(out.plan, { templateType: safeTemplate, userId: user.id, dataSourceId, amountUnit });
    writeAudit({ ...auditBase, question: `report-plan:${safeTemplate}`, status: 'SUCCESS', durationMs: Date.now() - startedAt });
    return res.json({ success: true, reportPlanId, plan: out.plan, expiresInSec: 600 });
  } catch (err: any) {
    console.error('Report Plan Error:', err);
    writeAudit({ ...auditBase, question: `report-plan:${safeTemplate}`, status: 'FALLBACK', detail: String(err?.message || err).slice(0, 200), durationMs: Date.now() - startedAt });
    return res.status(500).json({ code: ERROR_CODES.LLM_UNAVAILABLE, error: '报表查询计划生成失败，请稍后重试' });
  }
});

// 4a. v0.5.0 智能问数报告生成：从对话生成报告（支持模板选择或智能推断）
router.post('/generate-from-query', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { question, dataSourceId, templateId } = req.body;
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'report' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  // L2 权限层：Service 侧复核
  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无报告生成权限`, durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '当前角色没有报告生成权限' });
  }

  // 输入校验
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '提问内容不能为空' });
  }
  if (!dataSourceId || typeof dataSourceId !== 'string') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少数据源 ID' });
  }

  const safeQuestion = question.trim().slice(0, 500);
  const auditQuestion = `query-report:${safeQuestion.slice(0, 100)}`;

  // v0.5.2 金额单位白名单校验（与问数链路口径一致）
  const amountUnit = normalizeAmountUnit(req.body.amountUnit);
  if (req.body.amountUnit != null && req.body.amountUnit !== '' && !amountUnit) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: `非法金额单位：${String(req.body.amountUnit).slice(0, 20)}`, durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' });
  }

  // L1 输入层：提问内容过注入特征检测
  if (containsInjection(safeQuestion)) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: '提问内容包含注入特征', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '提问内容包含不允许的指令' });
  }

  // L5 频率层：与智能问数共享用户配额与并发互斥
  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: limit.reason });
  }
  const reportSlotToken = randomUUID();
  if (!(await acquireQuerySlot(user.id, reportSlotToken))) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_RATE', detail: '存在进行中的查询', durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.QUERY_IN_FLIGHT, error: '上一个查询仍在进行中，请等待完成后再试' });
  }

  try {
    // L3 上下文层：加载数据源 schema
    const ctx = await loadSchemaContext(dataSourceId, req.body.schema);
    if (ctx.status === 'disconnected') {
      writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
      return res.status(403).json({ code: ERROR_CODES.AI_SWITCHED_OFF, error: '该数据源的智能问数功能已被管理员停用' });
    }

    let templateType = '智能推断';
    let customPrompt = safeQuestion;
    let templateName = '';
    let templateIdNum: number | null = null;

    // 如果指定了模板，加载模板内容
    if (templateId && typeof templateId === 'number') {
      const pool = getPool();
      const [rows] = await pool.query('SELECT * FROM report_templates WHERE id = ?', [templateId]);
      const template = (rows as any[])[0];
      if (template) {
        templateType = template.name;
        templateName = template.name;
        templateIdNum = template.id;
        // 将模板内容与用户提问结合
        const templateContent = JSON.parse(template.template_content);
        const sectionsPrompt = templateContent.sections?.map((s: any) => `${s.title}：${s.prompt}`).join('；') || '';
        customPrompt = `${safeQuestion}。请按照以下模板结构生成报告：${sectionsPrompt}`;
      }
    }

    // P1 报表真实化：数据库型数据源走双阶段
    const canRunLive = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && typeof dataSourceId === 'string' && dataSourceId.length > 0;
    if (!canRunLive) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '仅数据库型数据源支持报告生成' });
    }

    const live = await runLiveReport({
      templateType,
      customPrompt,
      schema: ctx.schema,
      guidance: ctx.guidance,
      dataSourceId,
      dsType: ctx.dsType || undefined,
      sensitiveRemoved: ctx.sensitiveRemoved,
      rowFilters: ctx.rowFilters,
      amountUnit,
    });

    if (live.ok === true) {
      const report = normalizeReport(live.report);
      if (report) {
        // 生成报告 ID
        const reportId = `report-${Date.now()}`;
        // 将报告插入 query_reports 表
        const pool = getPool();
        await pool.query(
          'INSERT INTO query_reports (report_id, user_id, username, data_source_id, question, template_id, template_name, report_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [reportId, user.id, user.username, dataSourceId, safeQuestion, templateIdNum, templateName, JSON.stringify(report)]
        );

        writeAudit({ ...auditBase, question: auditQuestion, status: 'SUCCESS', executedSql: live.executedSqls.join(' ; '), rowCount: live.totalRows, durationMs: Date.now() - startedAt });
        return res.json({ success: true, executionTimeMs: Date.now() - startedAt, report: { ...report, executedSqls: live.executedSqls }, reportId, templateName, dataProvenance: 'live' });
      }
    }

    // 生成失败，走降级
    writeAudit({
      ...auditBase,
      question: auditQuestion,
      status: 'FALLBACK',
      detail: String(live.ok === true ? '报表结构校验失败' : live.error).slice(0, 200),
      executedSql: live.executedSqls.join(' ; '),
      durationMs: Date.now() - startedAt,
    });
    return res.json({
      success: true,
      executionTimeMs: Date.now() - startedAt,
      isFallback: true,
      report: getFallbackExecutiveReport(templateType, ctx.schema),
      templateName,
      dataProvenance: 'simulated',
    });
  } catch (err: any) {
    console.error('Generate Report From Query Error:', err);
    writeAudit({ ...auditBase, question: auditQuestion, status: 'ERROR', detail: String(err?.message || err).slice(0, 200), durationMs: Date.now() - startedAt });
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '报告生成失败，请稍后重试' });
  } finally {
    await releaseQuerySlot(user.id, reportSlotToken);
  }
});

// 4-async. v0.9.2 报告生成异步化（改进计划 2-1）：提交即返回 taskId，worker 独立并发执行。
// 与同步端点差异：不占用户交互并发槽（生成期间可继续问数）；校验（权限/注入/单位/限流）在提交时完成。
router.post('/generate/async', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { templateType, customPrompt, dataSourceId } = req.body || {};
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'report' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  const safeTemplate = String(templateType || '综合经营分析').slice(0, 200);
  const safeCustom = String(customPrompt || '生成包含核心KPI、多维趋势图表与战略建议的决策简报').slice(0, 1000);
  const amountUnit = normalizeAmountUnit(req.body.amountUnit);
  if (req.body.amountUnit != null && req.body.amountUnit !== '' && !amountUnit) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' });
  }
  if (containsInjection(safeTemplate) || containsInjection(safeCustom)) {
    writeAudit({ ...auditBase, question: `async-report:${safeTemplate}`, status: 'DENIED_INPUT', detail: '报告参数包含注入特征', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报告参数包含不允许的指令内容' });
  }
  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: `async-report:${safeTemplate}`, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: limit.reason });
  }

  let submitted: { taskId: string } | null = null;
  try {
    submitted = await submitTask('report_generate', {
      templateType: safeTemplate,
      customPrompt: safeCustom,
      dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
      amountUnit: amountUnit ?? undefined,
      reportPlanId: typeof req.body.reportPlanId === 'string' ? req.body.reportPlanId : undefined,
      user: { id: user.id, username: user.username, role: user.role, department: user.department },
    }, { id: user.id, username: user.username });
  } catch (err: any) {
    console.error('[Report] async submit failed:', err?.message || err);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '任务提交失败，请稍后重试' });
  }
  if (!submitted) {
    writeAudit({ ...auditBase, question: `async-report:${safeTemplate}`, status: 'DENIED_RATE', detail: '在途任务过多', durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: '您有多个报告任务正在排队或执行中，请等待完成后再提交' });
  }
  writeAudit({ ...auditBase, question: `async-report:${safeTemplate}`, status: 'QUEUED', detail: `taskId=${submitted.taskId}`, durationMs: Date.now() - startedAt });
  return res.status(202).json({ success: true, taskId: submitted.taskId, status: 'PENDING', statusUrl: `/api/tasks/${submitted.taskId}` });
});

// 4a-async. v0.9.2 问数报告异步化：从对话生成报告提交即返回 taskId，完成后报告仍写入 query_reports（报告中心可见）
router.post('/generate-from-query/async', rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const { question, dataSourceId, templateId } = req.body || {};
  const auditBase = {
    userId: user.id,
    username: user.username,
    endpoint: 'report' as const,
    dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
  };

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '提问内容不能为空' });
  }
  if (!dataSourceId || typeof dataSourceId !== 'string') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少数据源 ID' });
  }
  const safeQuestion = question.trim().slice(0, 500);
  const auditQuestion = `async-query-report:${safeQuestion.slice(0, 100)}`;
  const amountUnit = normalizeAmountUnit(req.body.amountUnit);
  if (req.body.amountUnit != null && req.body.amountUnit !== '' && !amountUnit) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '金额单位仅支持：亿元、百万元、万元、元' });
  }
  if (containsInjection(safeQuestion)) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: '提问内容包含注入特征', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '提问内容包含不允许的指令' });
  }
  const limit = await checkUserQueryLimit(user.id);
  if (!limit.ok) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_RATE', detail: limit.reason, durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: limit.reason });
  }

  let submitted: { taskId: string } | null = null;
  try {
    submitted = await submitTask('report_generate_from_query', {
      question: safeQuestion,
      dataSourceId,
      templateId: typeof templateId === 'number' ? templateId : undefined,
      amountUnit: amountUnit ?? undefined,
      user: { id: user.id, username: user.username, role: user.role, department: user.department },
    }, { id: user.id, username: user.username });
  } catch (err: any) {
    console.error('[Report] async submit failed:', err?.message || err);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '任务提交失败，请稍后重试' });
  }
  if (!submitted) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_RATE', detail: '在途任务过多', durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: '您有多个报告任务正在排队或执行中，请等待完成后再提交' });
  }
  writeAudit({ ...auditBase, question: auditQuestion, status: 'QUEUED', detail: `taskId=${submitted.taskId}`, durationMs: Date.now() - startedAt });
  return res.status(202).json({ success: true, taskId: submitted.taskId, status: 'PENDING', statusUrl: `/api/tasks/${submitted.taskId}` });
});

// 4c-async. v0.9.2 PDF 导出异步化：提交即返回 taskId，完成后经 /api/tasks/:id/download 下载
router.post('/export-pdf/async', express.json({ limit: '20mb' }), rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const };

  const data = normalizeExportData(req.body?.report ?? req.body);
  if (!data) {
    writeAudit({ ...auditBase, status: 'DENIED_INPUT', detail: '报告导出参数非法（缺少标题或结构错误）', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报告导出参数无效' });
  }
  const orientation = req.body?.orientation === 'landscape' ? 'landscape' : 'portrait';
  // DLP 水印在提交时冻结（worker 执行时不再依赖会话）
  const watermark = `导出人: ${user.username}${user.department ? `（${user.department}）` : ''} · ${new Date().toLocaleString('zh-CN', { hour12: false })} · 严禁外传`;

  let submitted: { taskId: string } | null = null;
  try {
    submitted = await submitTask('report_export_pdf', {
      report: data,
      orientation,
      watermark,
      user: { id: user.id, username: user.username, role: user.role, department: user.department },
    }, { id: user.id, username: user.username });
  } catch (err: any) {
    console.error('[Report] async pdf submit failed:', err?.message || err);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '任务提交失败，请稍后重试' });
  }
  if (!submitted) {
    writeAudit({ ...auditBase, question: `async-export-pdf:${data.title}`, status: 'DENIED_RATE', detail: '在途任务过多', durationMs: Date.now() - startedAt });
    return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: '您有多个导出任务正在排队或执行中，请等待完成后再提交' });
  }
  writeAudit({ ...auditBase, question: `async-export-pdf:${data.title}`, status: 'QUEUED', detail: `taskId=${submitted.taskId}`, durationMs: Date.now() - startedAt });
  return res.status(202).json({ success: true, taskId: submitted.taskId, status: 'PENDING', statusUrl: `/api/tasks/${submitted.taskId}` });
});

// 4b. M4 报告导出：服务端用 pptxgenjs 组装 PPTX（封面/摘要/KPI/每图一页/结论），图表由前端转 base64 PNG 提交
router.post('/export', express.json({ limit: '20mb' }), rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const };

  // L2 权限层：Service 侧复核
  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无报告导出权限`, durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '当前角色没有报告导出权限' });
  }

  const data = normalizeExportData(req.body?.report ?? req.body);
  if (!data) {
    writeAudit({ ...auditBase, status: 'DENIED_INPUT', detail: '报告导出参数非法（缺少标题或结构错误）', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报告 导出参数无效' });
  }
  // P2-12 DLP 导出水印：服务端注入导出人（覆盖前端传入，防伪造）
  data.exportedBy = `${user.username}${user.department ? `（${user.department}）` : ''} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  
  try {
    const buffer = await buildReportPptx(data);
    writeAudit({ ...auditBase, question: `export:${data.title}`, status: 'SUCCESS', durationMs: Date.now() - startedAt });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(buildExportFilename(data.title, data.createdAt))}`);
    return res.send(buffer);
  } catch (err: any) {
    console.error('Report Export Error:', err);
    writeAudit({ ...auditBase, question: `export:${data.title}`, status: 'FALLBACK', detail: String(err?.message || err).slice(0, 200), durationMs: Date.now() - startedAt });
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: 'PPT 生成失败，请稍后重试' });
  }
});

// 4c. v0.5.3 报告 PDF 导出：ReportLab 服务端原生排版（替代前端 html2canvas 截图），图表由前端转 base64 PNG 提交
router.post('/export-pdf', express.json({ limit: '20mb' }), rateLimiter, authMiddleware, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = req.user!;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const };

  // L2 权限层：Service 侧复核
  if (user.role !== 'ADMIN' && user.role !== 'ANALYST') {
    writeAudit({ ...auditBase, status: 'DENIED_AUTH', detail: `角色 ${user.role} 无报告导出权限`, durationMs: Date.now() - startedAt });
    return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '当前角色没有报告导出权限' });
  }

  const data = normalizeExportData(req.body?.report ?? req.body);
  if (!data) {
    writeAudit({ ...auditBase, status: 'DENIED_INPUT', detail: '报告导出参数非法（缺少标题或结构错误）', durationMs: Date.now() - startedAt });
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '报告导出参数无效' });
  }
  // 方向白名单（portrait 竖版默认 / landscape 横版）
  const orientation = req.body?.orientation === 'landscape' ? 'landscape' : 'portrait';
  // P2-12 DLP 导出水印：页脚嵌入导出人（服务端注入，防伪造）
  const watermark = `导出人: ${user.username}${user.department ? `（${user.department}）` : ''} · ${new Date().toLocaleString('zh-CN', { hour12: false })} · 严禁外传`;

  try {
    const pdf = await runPdfGenerator({ ...data, orientation, watermark });
    writeAudit({ ...auditBase, question: `export-pdf:${data.title}`, status: 'SUCCESS', durationMs: Date.now() - startedAt });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(buildExportFilename(data.title, data.createdAt, '.pdf'))}`);
    return res.send(pdf);
  } catch (err: any) {
    console.error('Report PDF Export Error:', err);
    writeAudit({ ...auditBase, question: `export-pdf:${data.title}`, status: 'FALLBACK', detail: String(err?.message || err).slice(0, 200), durationMs: Date.now() - startedAt });
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: String(err?.message || 'PDF 生成失败，请稍后重试').slice(0, 200) });
  }
});

export default router;
