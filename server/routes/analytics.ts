/**
 * P1 高级分析能力路由（挂载于 /api/analytics 前缀下）：
 * - POST /forecast     时序预测（P1-5）：统计引擎出数 + 可选 LLM 业务解读
 * - POST /attribution  多维自动归因（P1-6）：贡献度拆解 + 可选 LLM 结论
 * - POST /whatif       情景推演（P1-9）：基于既有 SQL 的 LLM 改写 → 对比执行 → 解读
 * 预测与归因输入为前端直传的数据（来自图表/看板 widget），纯统计计算零 IO；
 * 推演需要真实数据源执行（复用 executeSafeSql 的表白名单与危险关键字双重校验）。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { checkDataSourceAccess } from '../auth/accessControl';
import { rateLimiter } from '../infra/rateLimiter';
import { writeAudit } from '../infra/auditLog';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { callLLMJson } from '../llm/llmClient';
import { safeParseJson } from '../../src/utils/queryResultNormalizer';
import { loadSchemaContext, isLiveCapableType } from '../query/schemaContext';
import { executeSafeSql } from '../query/sqlExecutor';
import { forecastSeries, MAX_FORECAST_PERIODS, MIN_SERIES_LENGTH, type ForecastModel } from '../analytics/seriesForecast';
import { attributeDelta, aggregateTwoPeriods, MAX_ATTRIBUTION_ROWS, MAX_ATTRIBUTION_DIMS } from '../analytics/attribution';
import { generateWhatIfPlan, compareOutcomes, summarizeComparison, MAX_SCENARIO_SQL_LENGTH } from '../analytics/whatIf';

const router = Router();
router.use(authMiddleware);

const MAX_SERIES_LENGTH = 240;
const WHATIF_ROW_LIMIT = 1000;
const WHATIF_ROWS_RETURN = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** LLM 解读兜底：解析失败或调用异常返回 null（不阻断统计结果出数） */
async function tryInterpret(system: string, user: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await callLLMJson(system, user);
    const parsed = safeParseJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch (err: any) {
    logger.warn('[Analytics] LLM 解读失败（降级为仅统计结果）:', err?.message || err);
    return null;
  }
}

function strList(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v.slice(0, max)) {
    if (item === null || item === undefined) {
      out.push('');
      continue;
    }
    out.push(String(item).slice(0, 200));
  }
  return out;
}

// ---------- P1-5 时序预测 ----------

const FORECAST_MODELS: ForecastModel[] = ['auto', 'ma', 'lr', 'seasonal'];

router.post('/forecast', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const body = req.body ?? {};
  const yValuesRaw = body.yValues;
  if (!Array.isArray(yValuesRaw) || yValuesRaw.length < MIN_SERIES_LENGTH || yValuesRaw.length > MAX_SERIES_LENGTH) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: `yValues 需为 ${MIN_SERIES_LENGTH}~${MAX_SERIES_LENGTH} 个数值的数组` });
  }
  const yValues = yValuesRaw.map((v: unknown) => Number(v));
  const xValues = strList(body.xValues, MAX_SERIES_LENGTH);
  if (xValues && xValues.length !== yValues.length) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'xValues 与 yValues 长度不一致' });
  }
  const periods = Number.isFinite(Number(body.periods)) ? Math.floor(Number(body.periods)) : 3;
  if (periods < 1 || periods > MAX_FORECAST_PERIODS) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: `预测期数需为 1~${MAX_FORECAST_PERIODS} 的整数` });
  }
  const model: ForecastModel = FORECAST_MODELS.includes(body.model) ? body.model : 'auto';
  const seasonalPeriod = Number.isFinite(Number(body.seasonalPeriod)) ? Math.floor(Number(body.seasonalPeriod)) : undefined;
  const metricLabel = typeof body.metricLabel === 'string' ? body.metricLabel.trim().slice(0, 60) : '';
  const interpret = body.interpret !== false;

  let forecast;
  try {
    forecast = forecastSeries(yValues, { periods, model, seasonalPeriod });
  } catch (err: any) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: err?.message || '预测参数不合法' });
  }

  let interpretation: Record<string, unknown> | null = null;
  if (interpret) {
    const histTail = yValues.slice(-Math.min(8, yValues.length));
    const system =
      '你是一个数据分析解读助手。根据时序预测的统计结果输出中文业务解读，仅输出 JSON 对象：' +
      '{"summary":"2-3 句总体结论（含方向与幅度）","trendNote":"趋势与节奏判断","riskNote":"不确定性提示（结合预测区间宽度与样本量）"}。' +
      '数值表述与输入一致，不要编造新数字；不要包含 markdown 代码块标记或其他说明文字。';
    const userMsg = [
      `指标：${metricLabel || '未命名指标'}`,
      `历史尾部值（按期序）：${histTail.join(', ')}`,
      `采用模型：${forecast.model}`,
      `拟合评估：RMSE=${forecast.fit.rmse}，R²=${forecast.fit.r2 ?? '不适用'}，MAPE=${forecast.fit.mape ?? '不适用'}%`,
      `预测结果：${forecast.points.map((p) => `第${p.step}期 ${p.yhat}（区间 ${p.lower}~${p.upper}）`).join('；')}`,
      `统计诊断：${forecast.diagnostics.join('；')}`,
    ].join('\n');
    interpretation = await tryInterpret(system, userMsg);
  }

  writeAudit({
    userId: user.id,
    username: user.username,
    endpoint: 'analytics',
    status: 'SUCCESS',
    detail: `时序预测：${metricLabel || '指标'}（${forecast.model} 模型，${yValues.length} 期历史，预测 ${periods} 期）`,
  });
  res.json({ ok: true, forecast, interpretation });
});

// ---------- P1-6 多维自动归因 ----------

router.post('/attribution', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const body = req.body ?? {};
  const rowsRaw = body.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0 || rowsRaw.length > MAX_ATTRIBUTION_ROWS) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: `rows 需为 1~${MAX_ATTRIBUTION_ROWS} 行的数组` });
  }
  const rows: { dims: string[]; current: number; previous: number }[] = [];
  let periods: [string, string] | null = null;

  // 模式二（看板/Agent 直连）：rows 为原始数据行 + aggregate 列映射，服务端聚合最新两期
  const aggregate = body.aggregate;
  if (isPlainObject(aggregate)) {
    const periodKey = typeof aggregate.periodKey === 'string' ? aggregate.periodKey.trim() : '';
    const metricKey = typeof aggregate.metricKey === 'string' ? aggregate.metricKey.trim() : '';
    const dimKey = typeof aggregate.dimKey === 'string' ? aggregate.dimKey.trim() : undefined;
    if (!periodKey || !metricKey) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'aggregate 需提供 periodKey 与 metricKey' });
    }
    const agg = aggregateTwoPeriods(rowsRaw, { dimKey: dimKey || undefined, periodKey, metricKey });
    if (agg.ok !== true) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: `归因聚合失败：${agg.reason}` });
    }
    periods = agg.periods;
    rows.push(...agg.rows);
  } else {
    // 模式一：rows 已是 { dims, current, previous } 归因行（前端自行聚合）
    for (const r of rowsRaw) {
      if (!isPlainObject(r)) {
        return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'rows 行格式不正确' });
      }
      const dims = strList(r.dims, MAX_ATTRIBUTION_DIMS);
      if (!dims || dims.length === 0) {
        return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '每行需提供 dims（1~3 个维度值）' });
      }
      const current = Number(r.current);
      const previous = Number(r.previous);
      if (!Number.isFinite(current) || !Number.isFinite(previous)) {
        return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '每行需提供数值型 current 与 previous' });
      }
      rows.push({ dims, current, previous });
    }
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 80) : '';
  const interpret = body.interpret !== false;

  let attribution;
  try {
    attribution = attributeDelta(rows);
  } catch (err: any) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: err?.message || '归因数据不合法' });
  }

  let interpretation: Record<string, unknown> | null = null;
  if (interpret) {
    const system =
      '你是一个数据分析解读助手。根据指标的维度贡献度拆解结果输出中文业务结论，仅输出 JSON 对象：' +
      '{"summary":"2-3 句总体结论（谁拉高/拉低了指标）","keyDrivers":[{"dimension":"维度值","reason":"1 句原因推断"}],"actions":["2-3 条可落地的核查或改进建议"]}。' +
      '只引用输入中出现的维度与数值，不要编造；不要包含 markdown 代码块标记或其他说明文字。';
    const fmt = (items: typeof attribution.topPositive) =>
      items.map((i) => `${i.dims.join('/')}：${i.delta > 0 ? '+' : ''}${i.delta}（贡献 ${i.contribution}%，共 ${i.previous}→${i.current}）`).join('；') || '（无）';
    const userMsg = [
      `指标：${subject || '未命名指标'}`,
      `总体变化：${attribution.total.previous} → ${attribution.total.current}（${attribution.total.delta > 0 ? '+' : ''}${attribution.total.delta}${attribution.total.deltaPct === null ? '' : `，${attribution.total.deltaPct}%`}）`,
      `拉高 TOP：${fmt(attribution.topPositive)}`,
      `拉低 TOP：${fmt(attribution.topNegative)}`,
      `统计诊断：${attribution.diagnostics.join('；')}`,
    ].join('\n');
    interpretation = await tryInterpret(system, userMsg);
  }

  writeAudit({
    userId: user.id,
    username: user.username,
    endpoint: 'analytics',
    status: 'SUCCESS',
    detail: `多维归因：${subject || '指标'}（${rows.length} 个维度组合，总变化 ${attribution.total.delta > 0 ? '+' : ''}${attribution.total.delta}）`,
  });
  res.json({ ok: true, attribution, periods, interpretation });
});

// ---------- P1-9 情景推演 ----------

router.post('/whatif', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const body = req.body ?? {};
  const dataSourceId = typeof body.dataSourceId === 'string' ? body.dataSourceId.trim() : '';
  const sql = typeof body.sql === 'string' ? body.sql.trim() : '';
  const scenario = typeof body.scenario === 'string' ? body.scenario.trim() : '';
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  if (!dataSourceId || !sql) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少数据源或原始 SQL' });
  }
  if (sql.length > MAX_SCENARIO_SQL_LENGTH) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '原始 SQL 过长' });
  }
  if (!scenario) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '请描述要模拟的情景（如"收紧华东区域投放 20% 后不良率如何变化"）' });
  }
  if (scenario.length > 500) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '情景描述过长（≤500 字）' });
  }
  if (!(await checkDataSourceAccess(user, dataSourceId))) {
    return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '数据源不存在或无权访问' });
  }

  try {
    const ctx = await loadSchemaContext(dataSourceId, undefined);
    if (!isLiveCapableType(ctx.dsType, ctx.fileBacked)) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '当前数据源不支持情景推演（需数据库型或已落库文件数据源）' });
    }

    // 1) 执行原始 SQL 作为基准
    const beforeOutcome = await executeSafeSql(dataSourceId, sql, ctx.schema, ctx.sensitiveRemoved, WHATIF_ROW_LIMIT, ctx.rowFilters);
    if (beforeOutcome.ok !== true) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: `原始 SQL 执行失败：${beforeOutcome.reason}` });
    }
    const beforeRows = beforeOutcome.result.rows;

    // 2) LLM 依场景改写 SQL
    let plan;
    try {
      plan = await generateWhatIfPlan({ baseSql: sql, scenario, schema: ctx.schema, question: question || undefined });
    } catch (err: any) {
      return res.status(422).json({ code: ERROR_CODES.INVALID_INPUT, error: `情景改写失败：${err?.message || '模型输出未通过校验'}` });
    }

    // 3) 执行情景 SQL（executeSafeSql 二次安全校验：单条 SELECT + 表白名单 + 危险关键字）
    const afterOutcome = await executeSafeSql(dataSourceId, plan.scenarioSql, ctx.schema, ctx.sensitiveRemoved, WHATIF_ROW_LIMIT, ctx.rowFilters);
    if (afterOutcome.ok !== true) {
      return res.status(422).json({ code: ERROR_CODES.INVALID_INPUT, error: `情景 SQL 未通过安全校验或执行失败：${afterOutcome.reason}` });
    }
    const afterRows = afterOutcome.result.rows;

    // 4) 对比计算 + LLM 解读
    const comparisons = compareOutcomes(beforeRows, afterRows);
    const summaryLines = summarizeComparison(comparisons);
    let interpretation: Record<string, unknown> | null = null;
    try {
      const system =
        '你是一个数据分析解读助手。根据"情景推演"的对比结果输出中文解读，仅输出 JSON 对象：' +
        '{"summary":"2-3 句总体结论（情景带来的主要变化）","verdict":"一句话判断该情景的影响方向与强度","caveats":["2-3 条口径提醒或数据局限说明"]}。' +
        '只引用输入中出现的指标与数值，不要编造；不要包含 markdown 代码块标记或其他说明文字。';
      const userMsg = [
        `原始提问：${question || '（未提供）'}`,
        `模拟情景：${scenario}`,
        `改写说明：${plan.explanation}`,
        plan.parameterChanges.length > 0
          ? `参数改动：${plan.parameterChanges.map((c) => `${c.column} ${c.from}→${c.to}`).join('；')}`
          : '',
        `对比结果（原始 → 情景）：\n${summaryLines.join('\n')}`,
        `原始 SQL 返回 ${beforeRows.length} 行，情景 SQL 返回 ${afterRows.length} 行`,
      ]
        .filter(Boolean)
        .join('\n');
      interpretation = await tryInterpret(system, userMsg);
    } catch (err: any) {
      logger.warn('[Analytics] whatif 解读降级:', err?.message || err);
    }

    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'analytics',
      status: 'SUCCESS',
      detail: `情景推演：${plan.explanation}（对比列 ${comparisons.length} 个）`,
      executedSql: plan.scenarioSql,
    });
    res.json({
      ok: true,
      plan,
      before: { sql, rowCount: beforeRows.length, rows: beforeRows.slice(0, WHATIF_ROWS_RETURN) },
      after: { sql: plan.scenarioSql, rowCount: afterRows.length, rows: afterRows.slice(0, WHATIF_ROWS_RETURN) },
      comparisons,
      summaryLines,
      interpretation,
    });
  } catch (err: any) {
    logger.error('[Analytics] whatif error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '情景推演执行失败' });
  }
});

export default router;
