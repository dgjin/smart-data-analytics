/**
 * P1-7 Agent 编排路由（挂载于 /api/agent 前缀下）：
 * - POST /plan  生成多能力编排计划（LLM Planner，只规划不执行；计划 10 分钟有效、一次性消费）
 * - POST /run   用户批准后顺序执行：query 步走真实问数链路取数，forecast/attribution 步对上游数据做统计
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { checkDataSourceAccess } from '../auth/accessControl';
import { rateLimiter } from '../infra/rateLimiter';
import { writeAudit } from '../infra/auditLog';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { loadSchemaContext, isLiveCapableType } from '../query/schemaContext';
import { generateAgentPlan, consumeAgentPlan, storeAgentPlan, runAgentPlan } from '../agent/orchestrator';

const router = Router();
router.use(authMiddleware);

// POST /api/agent/plan —— 生成编排计划（不执行）
router.post('/plan', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const dataSourceId = typeof req.body?.dataSourceId === 'string' ? req.body.dataSourceId.trim() : '';
  if (!question) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '请输入分析问题' });
  }
  if (question.length > 500) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '问题过长（≤500 字）' });
  }
  if (!dataSourceId) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '请选择数据源' });
  }
  if (!(await checkDataSourceAccess(user, dataSourceId))) {
    return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '数据源不存在或无权访问' });
  }

  try {
    const ctx = await loadSchemaContext(dataSourceId, undefined);
    if (!isLiveCapableType(ctx.dsType, ctx.fileBacked)) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '当前数据源不支持 Agent 编排（需数据库型或已落库文件数据源）' });
    }
    const plan = await generateAgentPlan(question, ctx.schema);
    await storeAgentPlan(plan, user.id, dataSourceId);
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'agent',
      status: 'SUCCESS',
      detail: `Agent 编排计划（${plan.steps.length} 步：${plan.steps.map((s) => s.capability).join('→')}）`,
      dataSourceId,
    });
    res.json({ ok: true, plan });
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('结构校验')) {
      return res.status(422).json({ code: ERROR_CODES.INVALID_INPUT, error: msg });
    }
    logger.error('[Agent] plan error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '编排计划生成失败（AI 引擎异常）' });
  }
});

// POST /api/agent/run —— 批准后执行计划（一次性消费 planId）
router.post('/run', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const planId = typeof req.body?.planId === 'string' ? req.body.planId.trim() : '';
  const dataSourceId = typeof req.body?.dataSourceId === 'string' ? req.body.dataSourceId.trim() : '';
  if (!planId || !dataSourceId) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少编排计划标识或数据源' });
  }

  try {
    const consumed = await consumeAgentPlan(planId, user.id, dataSourceId);
    if (consumed.ok !== true) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: consumed.reason });
    }
    const plan = consumed.plan;

    const ctx = await loadSchemaContext(dataSourceId, undefined);
    if (!isLiveCapableType(ctx.dsType, ctx.fileBacked)) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '当前数据源不支持 Agent 编排（需数据库型或已落库文件数据源）' });
    }

    // 格式须满足 GET /api/query/trace/:traceId 的校验（tr_ 前缀 + 仅字母数字下划线），
    // 否则执行结果卡「查看推导过程」会被 400（traceId 不合法）拒绝
    const traceId = `tr_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const outcome = await runAgentPlan(plan, {
      userId: user.id,
      username: user.username,
      dataSourceId,
      schema: ctx.schema,
      guidance: ctx.guidance,
      dsType: ctx.dsType,
      dataSourceName: ctx.dataSourceName,
      sensitiveRemoved: ctx.sensitiveRemoved,
      rowFilters: ctx.rowFilters,
      traceId,
    });

    const okCount = outcome.steps.filter((s) => s.ok).length;
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'agent',
      status: outcome.ok ? 'SUCCESS' : 'ERROR',
      detail: `Agent 编排执行：${outcome.steps.length} 步成功 ${okCount} 步（${plan.steps.map((s) => s.capability).join('→')}）`,
      dataSourceId,
    });
    res.json({ ok: outcome.ok, traceId, steps: outcome.steps, finalSummary: outcome.finalSummary });
  } catch (err: any) {
    logger.error('[Agent] run error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '编排执行失败' });
  }
});

export default router;
