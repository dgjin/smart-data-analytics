/**
 * 可视化决策报表双阶段真实生成编排（HTTP 入口见 routes/report.ts）。
 *
 * 核心流程：
 * - 阶段一：LLM 按报表主题生成 2-4 条聚合查询计划（仅 SQL，不编造数据）；
 *   生成前注入 Schema 业务备注 + 语义指标口径（命中才注入）+ 铁律规则（全量恒注入，v0.9.35）
 *   + 知识库 RAG 片段（v0.9.19，与问数同一检索函数与 token 预算）。
 * - 执行：多条计划并行过安全执行层（v0.9.20，允许部分失败，至少 1 条成功才继续）。
 * - 阶段二：全部真实 rows 摘要回喂 LLM 生成高管摘要、洞察、KPI 与各图解读；
 *   组装后统一做英文标识符中文化兜底替换（v0.5.1）。
 *
 * 关键设计：与问数链路（query/liveQuery.ts）共享同一套语义资产与安全执行层，
 * 凡问数新增的 prompt 注入项（指标/知识库/铁律等）必须同步核对本链路（见说明书「多链路注入一致性」）。
 */
import { analysisStageRoute, callLLMJson } from '../llm/llmClient';
import { executeSafeSql, QueryScenario } from '../query/sqlExecutor';
import { safeParseJson } from '../../src/utils/queryResultNormalizer';
import { buildColumnNames, buildColumnStats, coerceNumericColumns, dialectPromptOf, extractBusinessNotes, buildAmountUnitPrompt, buildIdentifierNameMap, replaceIdentifiersWithChinese } from '../query/liveQuery';
import { getStateStore, isRedisEnabled } from '../infra/stateStore';
import { loadActiveMetrics, matchMetrics, buildMetricPrompt } from '../query/metrics';
import { loadActiveIronRules, buildIronRulesPrompt } from '../query/ironRules';
import { retrieveKnowledgeSnippets } from '../knowledge/knowledgeBase';
import { budgetText, KNOWLEDGE_TOKEN_BUDGET } from '../llm/promptBudget';
import { serializeSchemaForPrompt } from '../query/schemaGuidance';
import type { SchemaTable } from '../query/schemaTypes';
import { logger } from '../infra/logger';

/** 单份报表的查询计划条数上限：控制生成时长与执行资源占用（与连接池 chain 场景配额对齐） */
const MAX_REPORT_QUERIES = 4;
/** 阶段二每图回喂 LLM 的真实行采样上限（token 预算保护） */
const SAMPLE_ROWS_PER_CHART = 10;

// v0.9.39 中文化函数已下沉至 query/liveQueryUtils（问数/报表双链路复用）；re-export 保持本模块 API 面不变
export { buildIdentifierNameMap, replaceIdentifiersWithChinese };

/**
 * v0.5.1 报表文案中文化：对阶段二输出的所有文案字段做英文标识符 → 中文名替换（LLM 不守约束时的服务端兜底）
 */
export function sanitizeReportNarrative<T extends Record<string, unknown>>(report: T, schema: SchemaTable[]): T {
  const nameMap = buildIdentifierNameMap(schema);
  if (Object.keys(nameMap).length === 0) return report;
  const fix = (s: unknown): unknown => (typeof s === 'string' ? replaceIdentifiersWithChinese(s, nameMap) : s);
  /** 对报表子对象（insight/kpi/chart）的指定文案字段做标识符中文化，非对象原样透传 */
  const fixObjKeys = (o: unknown, keys: string[]): unknown => {
    if (!o || typeof o !== 'object') return o;
    const next = { ...(o as Record<string, unknown>) };
    for (const k of keys) next[k] = fix(next[k]);
    return next;
  };
  const out: Record<string, unknown> = { ...report };
  if (typeof out.title === 'string') out.title = fix(out.title);
  if (typeof out.summary === 'string') out.summary = fix(out.summary);
  if (Array.isArray(out.insights)) {
    out.insights = out.insights.map((i) => fixObjKeys(i, ['title', 'content', 'actionItem']));
  }
  if (Array.isArray(out.kpiList)) {
    out.kpiList = out.kpiList.map((k) => fixObjKeys(k, ['label', 'value', 'change']));
  }
  if (Array.isArray(out.charts)) {
    out.charts = out.charts.map((c) => fixObjKeys(c, ['title', 'commentary']));
  }
  return out as T;
}

export interface LiveReportInput {
  /** 报表主题模板 ID（预置/自定义模板，见系统管理「报告模板」） */
  templateType: string;
  /** 用户自定义补充要求（可为空串，与模板提示词合并注入阶段一） */
  customPrompt: string;
  /** 数据源完整 Schema（安全白名单用全量） */
  schema: SchemaTable[];
  /** 业务口径指引文本（注入阶段一系统提示词） */
  guidance: string;
  /** 数据源 ID（指标/铁律/知识库检索均按此隔离） */
  dataSourceId: string;
  /** 数据源类型（mysql/postgresql/greenplum），用于阶段一 SQL 方言提示 */
  dsType?: string;
  /** 已被 DLP 剔除的敏感列名（执行层二次拦截） */
  sensitiveRemoved: string[];
  /** P1-3 行级权限（实际表名 → 谓词）：执行层 AST 强制注入 */
  rowFilters?: Record<string, string>;
  /** M4 报告计划批准：用户已批准的查询计划，存在时跳过阶段一重新生成 */
  approvedPlans?: { reportTitle: string; plans: ReportQueryPlan[] };
  /** v0.5.2 金额单位（亿元/百万元/万元/元）：与问数口径一致，注入阶段一 SQL 换算约定 */
  amountUnit?: string;
  /** P2-4 查询场景：同步报表链路默认 chain；异步报告/导出任务由 taskHandlers 传 export（独立连接池配额与超时档位） */
  scenario?: QueryScenario;
}

/**
 * 报表生成结果二分支：成功（report 为可直接渲染的完整报告 JSON）/ 失败（error 为诊断文案）；
 * 两种分支均携带 executedSqls（已实际执行的 SQL 列表，供下钻与审计追溯，与 charts 索引对齐）。
 */
export type LiveReportOutcome =
  | { ok: true; report: Record<string, any>; executedSqls: string[]; totalRows: number }
  | { ok: false; error: string; executedSqls: string[] };

/** 报表单条查询计划：阶段一 LLM 输出契约（purpose 用于阶段二解读时说明该图的分析意图） */
interface ReportQueryPlan {
  title: string;
  sql: string;
  chartType: string;
  xAxisKey: string;
  yAxisKeys: string[];
  columnNames?: Record<string, string>;
  purpose: string;
}
export type { ReportQueryPlan };

/** M4 报告计划批准：计划存储（10 分钟 TTL，一次性消费），机制与 queryPlan 一致；
 * P0-2：配置 REDIS_URL 后外置 Redis（rqp: 键 + GETDEL 原子消费） */
const REPORT_PLAN_TTL_MS = 10 * 60 * 1000;
type ReportPlanEntry = {
  plan: { reportTitle: string; plans: ReportQueryPlan[] };
  templateType: string;
  userId: number;
  dataSourceId: string;
  /** v0.5.2 计划生成时的金额单位口径：批准执行时必须一致，防口径互串 */
  amountUnit?: string;
  expiresAt: number;
};
const reportPlanStore = new Map<string, ReportPlanEntry>();

export function newReportPlanId(): string {
  return `rplan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function storeReportPlan(
  plan: { reportTitle: string; plans: ReportQueryPlan[] },
  meta: { templateType: string; userId: number; dataSourceId: string; amountUnit?: string },
  now = Date.now()
): Promise<string> {
  const id = newReportPlanId();
  if (isRedisEnabled()) {
    const entry: ReportPlanEntry = { plan, ...meta, expiresAt: now + REPORT_PLAN_TTL_MS };
    await getStateStore().setEx(`rqp:${id}`, JSON.stringify(entry), Math.ceil(REPORT_PLAN_TTL_MS / 1000) + 10);
    return id;
  }
  reportPlanStore.set(id, { plan, ...meta, expiresAt: now + REPORT_PLAN_TTL_MS });
  return id;
}

export type ReportPlanConsumeResult =
  | { ok: true; plan: { reportTitle: string; plans: ReportQueryPlan[] } }
  | { ok: false; reason: string };

export async function consumeReportPlan(
  planId: string,
  userId: number,
  dataSourceId: string,
  templateType: string,
  amountUnit?: string,
  now = Date.now()
): Promise<ReportPlanConsumeResult> {
  if (isRedisEnabled()) {
    const raw = await getStateStore().getDel(`rqp:${planId}`); // 原子一次性消费防重放
    if (!raw) return { ok: false, reason: '报告计划不存在或已使用，请重新制定' };
    let entry: ReportPlanEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return { ok: false, reason: '报告计划不存在或已使用，请重新制定' };
    }
    if (entry.expiresAt <= now) return { ok: false, reason: '报告计划已过期，请重新制定' };
    if (entry.userId !== userId) return { ok: false, reason: '无权使用他人的报告计划' };
    if (entry.dataSourceId !== dataSourceId || entry.templateType !== templateType) {
      return { ok: false, reason: '报告计划与当前数据源/模板不匹配，请重新制定' };
    }
    // v0.5.2 金额单位口径一致性：计划 SQL 已按生成时单位换算，批准时换单位须重新制定
    if ((entry.amountUnit || '') !== (amountUnit || '')) {
      return { ok: false, reason: '金额单位与计划制定时不一致，请重新制定' };
    }
    return { ok: true, plan: entry.plan };
  }
  const entry = reportPlanStore.get(planId);
  if (!entry) return { ok: false, reason: '报告计划不存在或已使用，请重新制定' };
  reportPlanStore.delete(planId); // 一次性消费防重放（无论后续校验是否通过）
  if (entry.expiresAt <= now) return { ok: false, reason: '报告计划已过期，请重新制定' };
  if (entry.userId !== userId) return { ok: false, reason: '无权使用他人的报告计划' };
  if (entry.dataSourceId !== dataSourceId || entry.templateType !== templateType) {
    return { ok: false, reason: '报告计划与当前数据源/模板不匹配，请重新制定' };
  }
  // v0.5.2 金额单位口径一致性：计划 SQL 已按生成时单位换算，批准时换单位须重新制定
  if ((entry.amountUnit || '') !== (amountUnit || '')) {
    return { ok: false, reason: '金额单位与计划制定时不一致，请重新制定' };
  }
  return { ok: true, plan: entry.plan };
}

export async function clearReportPlanStoreForTest(): Promise<void> {
  reportPlanStore.clear();
  if (isRedisEnabled()) await getStateStore().deleteByPrefix('rqp:');
}

/** M4：仅生成报表查询计划（不执行），供用户批准后携带 planId 生成报表 */
export async function generateReportPlans(input: Omit<LiveReportInput, 'approvedPlans'>): Promise<
  { ok: true; plan: { reportTitle: string; plans: ReportQueryPlan[] } } | { ok: false; error: string }
> {
  const parsed = await generateStage1Plans(input.templateType, input.customPrompt, input.schema, input.guidance, input.dsType, input.amountUnit, input.dataSourceId);
  if (!parsed) return { ok: false, error: '报表查询计划生成失败' };
  return { ok: true, plan: parsed };
}

/** P2-14 报表端语义层接入：报表主题/额外要求命中登记指标时注入权威口径（与问数同一语义资产），失败降级为空串 */
async function buildReportMetricPrompt(dataSourceId: string | undefined, templateType: string, customPrompt: string): Promise<string> {
  if (!dataSourceId) return '';
  try {
    const metrics = await loadActiveMetrics(dataSourceId);
    return buildMetricPrompt(matchMetrics(`${templateType}\n${customPrompt}`, metrics));
  } catch {
    return '';
  }
}

/** 铁律规则库（v0.9.35）：报表阶段一全量恒注入该数据源 ACTIVE 铁律（最高优先级强制约束，不按主题匹配），失败降级为空串 */
async function buildReportIronRulesPrompt(dataSourceId: string | undefined): Promise<string> {
  if (!dataSourceId) return '';
  try {
    return buildIronRulesPrompt(await loadActiveIronRules(dataSourceId));
  } catch {
    return '';
  }
}

/** v0.9.19 报表端知识库 RAG 接入（此前仅问数链路注入，报表 SQL 不遵守知识库口径规则）：
 * 按「报表主题+额外要求」检索业务知识片段（口径红线/枚举写法/计算规则），与问数同一检索函数与 token 预算，失败降级为空串 */
async function buildReportKnowledgePrompt(dataSourceId: string | undefined, templateType: string, customPrompt: string): Promise<string> {
  if (!dataSourceId) return '';
  try {
    const raw = await retrieveKnowledgeSnippets(dataSourceId, `${templateType}\n${customPrompt}`);
    return budgetText(raw, KNOWLEDGE_TOKEN_BUDGET);
  } catch {
    return '';
  }
}

/** 阶段一：LLM 生成 2-4 条聚合查询计划（含 1 次校验重试） */
async function generateStage1Plans(
  templateType: string,
  customPrompt: string,
  schema: SchemaTable[],
  guidance: string,
  dsType?: string,
  amountUnit?: string,
  dataSourceId?: string
): Promise<{ reportTitle: string; plans: ReportQueryPlan[] } | null> {
  let parsed: { reportTitle: string; plans: ReportQueryPlan[] } | null = null;
  let lastError = '';
  // v0.5.2 金额单位约定拼在用户消息首位（与问数链路口径一致）
  const unitPrompt = buildAmountUnitPrompt(amountUnit);
  // 语义层指标 + 铁律规则 + 知识库 RAG 并行检索（互不依赖，各自失败降级空串；v0.9.19 起报表与问数同一知识口径；v0.9.35 铁律全量恒注入）
  const [metricPrompt, ironRulesPrompt, knowledgePrompt] = await Promise.all([
    buildReportMetricPrompt(dataSourceId, templateType, customPrompt),
    buildReportIronRulesPrompt(dataSourceId),
    buildReportKnowledgePrompt(dataSourceId, templateType, customPrompt),
  ]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const userPrompt =
      attempt === 0
        ? `${unitPrompt}报表主题：${templateType}\n额外要求：${customPrompt}`
        : `${unitPrompt}报表主题：${templateType}\n额外要求：${customPrompt}\n\n（上次输出未通过校验：${lastError}，请修正后按同一 JSON 契约重新输出。）`;
    let text: string;
    try {
      text = await callLLMJson(buildReportStage1System(schema, guidance, dsType, metricPrompt, ironRulesPrompt, knowledgePrompt), userPrompt);
    } catch {
      return null;
    }
    parsed = parseReportPlans(text);
    if (parsed) break;
    lastError = 'LLM 输出未通过查询计划契约校验';
  }
  return parsed;
}

function buildReportStage1System(schema: SchemaTable[], guidance: string, dsType?: string, metricPrompt = '', ironRulesPrompt = '', knowledgePrompt = ''): string {
  const dialect = dialectPromptOf(dsType);
  return `你是企业级 NL2SQL 引擎，为高管报表规划真实数据查询。根据报表主题与数据库 Schema，生成 2-4 条 ${dialect.label} SELECT 聚合查询。你不生成任何数据，只生成 SQL。

数据库 Schema（已经过权限与敏感字段过滤，只能使用其中的表与列；格式：表 {"name","displayName"?,"description"?,"columns":[[列名,类型,中文说明?],…]}）:
${serializeSchemaForPrompt(schema)}

${extractBusinessNotes(schema)}${guidance ? `可用维度与指标摘要:\n${guidance}\n` : ''}
${metricPrompt}${ironRulesPrompt}${knowledgePrompt}【强制约束】
- 仅输出 JSON 对象: {"reportTitle":"报表标题","queries":[{"title","sql","chartType","xAxisKey","yAxisKeys","columnNames","purpose"}]}
- columnNames: 该查询 SQL 输出每一列的中文表头映射 {"列名/别名": "中文名"}，维度列与聚合别名都要覆盖
- 每条 sql 为单条 SELECT；表名逐字取自 Schema 表 name，列名逐字取自 columns 数组第 1 项，严禁添加 tbl_/t_ 等前缀、后缀或编造不存在的表/列；指标用聚合函数并用 AS 起英文/拼音别名
${dialect.rules}- queries 之间应选择不同维度（如时间趋势、类别对比、结构占比），避免重复
- chartType 从 bar/line/area/pie/donut/radar/treemap/heatmap 选择（时间趋势用 line/area，类别对比用 bar，占比结构用 pie/donut，层级占比用 treemap，多指标横向对照用 heatmap）；xAxisKey 与 yAxisKeys 必须与 SQL 输出列严格一致
- purpose: 一句话说明该图回答的业务问题
- 结果行数控制在 50 行以内（通过聚合或 LIMIT）
- 【文案中文化】reportTitle/title/purpose 中严禁出现英文表名/列名（如 dn_tzsy、BNTFJE），必须使用 Schema 中 displayName/description 对应的中文业务名称

请只输出纯 JSON，不要包含 markdown 代码块标记或其他说明文字。`;
}

function parseReportPlans(text: string): { reportTitle: string; plans: ReportQueryPlan[] } | null {
  const parsed = safeParseJson(text);
  if (!parsed) return null;
  const queries = Array.isArray(parsed.queries) ? parsed.queries : Array.isArray(parsed.sqls) ? parsed.sqls : null;
  if (!queries) return null;
  const plans: ReportQueryPlan[] = [];
  for (const q of queries) {
    if (!q || typeof q.sql !== 'string' || !q.sql.trim()) continue;
    plans.push({
      title: typeof q.title === 'string' && q.title.trim() ? q.title : '数据图表',
      sql: q.sql,
      chartType: ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'treemap', 'heatmap'].includes(q.chartType) ? q.chartType : 'bar',
      xAxisKey: typeof q.xAxisKey === 'string' ? q.xAxisKey : '',
      yAxisKeys: Array.isArray(q.yAxisKeys) ? q.yAxisKeys.filter((k: unknown): k is string => typeof k === 'string') : [],
      columnNames: q.columnNames && typeof q.columnNames === 'object' ? q.columnNames : undefined,
      purpose: typeof q.purpose === 'string' ? q.purpose : '',
    });
    if (plans.length >= MAX_REPORT_QUERIES) break;
  }
  if (plans.length === 0) return null;
  return {
    reportTitle: typeof parsed.reportTitle === 'string' && parsed.reportTitle.trim() ? parsed.reportTitle : '',
    plans,
  };
}

export function buildReportStage2System(schema: SchemaTable[], amountUnit?: string): string {
  const nameMap = buildIdentifierNameMap(schema);
  const nameMapText = Object.entries(nameMap)
    .map(([en, cn]) => `${en} = ${cn}`)
    .join('；');
  // v0.9.41 金额单位口径注入（与问数阶段二同一规则）：防 LLM 按数字规模自行换算表述
  const unitRule = amountUnit
    ? `\n- 【金额单位口径】所有图表的金额数值均已按「${amountUnit}」口径输出（SQL 已完成换算）：summary/insights/kpiList/commentaries 中引用金额必须逐字沿用「${amountUnit}」表述，禁止任何换算或进位改写（包括但不限于 万/百万/万亿/元，如 54505.36亿元 不得写作 5.45万亿元）`
    : '';
  return `你是资深数据分析总监。你将收到一组真实数据库查询结果（各图表的 SQL、行数、列统计与数据样本）。基于这些真实数据撰写高管报表内容。

【强制约束】
- 仅输出 JSON 对象: {"title","summary","insights","kpiList","commentaries"}
- 所有数值必须来自给定的真实数据与列统计，严禁编造${unitRule}
- title: 报表标题；summary: 200 字以内高管摘要，概括真实数据反映的经营事实
- insights: 4 条战略洞察 [{"title","type","content","actionItem"}]，type 从 positive/warning/info/critical 选择，content 须引用真实数值
- kpiList: 4 个核心 KPI [{"label","value","change","status"}]，value 必须由真实数据计算（可引用列统计），change 仅在数据支持时给出，status 从 good/bad/neutral 选择
- commentaries: 字符串数组，按给定图表顺序逐图解读（每张图 60 字以内，须引用该图真实数据）
- 【文案中文化】title/summary/insights/kpiList/commentaries 中严禁出现英文表名/列名标识符（SQL 中的标识符仅用于理解数据结构，不得出现在文案中），一律使用下列中文业务名称：${nameMapText || '（以 Schema 中文名为准）'}

请只输出纯 JSON，不要包含 markdown 代码块标记或其他说明文字。`;
}

/**
 * 执行一次报表生成：阶段一生成查询计划（或复用已批准计划）→ 并行安全执行 → 阶段二生成文案。
 * @param input 报表入参（模板/自定义要求/Schema/数据源/权限等，字段含义见 LiveReportInput）
 * @returns 成功或失败二分支结果（executedSqls 与报告 charts 索引对齐，供图表下钻使用）
 */
export async function runLiveReport(input: LiveReportInput): Promise<LiveReportOutcome> {
  const { templateType, customPrompt, schema, guidance, dataSourceId, dsType, sensitiveRemoved, rowFilters, amountUnit } = input;
  const executedSqls: string[] = [];

  // 阶段一：生成查询计划（已批准计划直接复用，跳过重新生成）
  let parsed: { reportTitle: string; plans: ReportQueryPlan[] } | null = input.approvedPlans ?? null;
  if (!parsed) {
    parsed = await generateStage1Plans(templateType, customPrompt, schema, guidance, dsType, amountUnit, dataSourceId);
  }
  if (!parsed) {
    return { ok: false, error: '查询计划生成失败', executedSqls };
  }

  // 执行：多条查询计划并行过安全执行层（v0.9.20，对照问数链路并行化）——
  // 各查询互不依赖，墙钟由「逐条相加」降为「最慢一条」；连接池按场景分级配额排队兜底（chain 默认 5/export 默认 2），
  // 允许部分失败（至少 1 条成功才继续）；汇总仍按计划原顺序（executedSqls 与 charts 索引对齐，图表下钻依赖该顺序）
  const execResults = await Promise.all(
    parsed.plans.map(async (plan) => {
      const outcome = await executeSafeSql(dataSourceId, plan.sql, schema, sensitiveRemoved, 500, rowFilters || {}, input.scenario ?? 'chain');
      if (outcome.ok !== true) {
        logger.warn(`[LiveReport] 查询失败已跳过: ${outcome.reason} | sql: ${plan.sql.slice(0, 200)}`);
        return null;
      }
      return { plan, result: outcome.result };
    })
  );

  const charts: Record<string, any>[] = [];
  const chartDigests: string[] = [];
  let totalRows = 0;
  for (const item of execResults) {
    if (!item) continue;
    const { plan, result } = item;
    const rows = coerceNumericColumns(result.rows);
    executedSqls.push(result.finalSql);
    totalRows += result.rowCount;

    const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    const xAxisKey = cols.includes(plan.xAxisKey) ? plan.xAxisKey : cols[0] || '';
    const numericCols = cols.filter((c) => rows.some((r) => typeof r[c] === 'number'));
    const yAxisKeys = plan.yAxisKeys.filter((k) => cols.includes(k));
    const finalYKeys = yAxisKeys.length > 0 ? yAxisKeys : numericCols.slice(0, 2);

    // 图表轴名中文化（图例/tooltip 不再出现英文列名）
    const columnNames = buildColumnNames(rows, schema, plan.columnNames);
    const yAxisNames: Record<string, string> = {};
    for (const k of finalYKeys) {
      if (columnNames[k]) yAxisNames[k] = columnNames[k];
    }

    charts.push({
      title: plan.title,
      chartConfig: {
        type: plan.chartType,
        title: plan.title,
        xAxisKey,
        yAxisKeys: finalYKeys,
        ...(Object.keys(yAxisNames).length > 0 ? { yAxisNames } : {}),
        ...(columnNames[xAxisKey] ? { xAxisName: columnNames[xAxisKey] } : {}),
      },
      data: rows,
      commentary: '',
    });
    chartDigests.push(
      [
        `图表「${plan.title}」（${plan.purpose || '未说明用途'}）`,
        `SQL: ${result.finalSql}`,
        `行数: ${result.rowCount}`,
        `列统计: ${JSON.stringify(buildColumnStats(rows))}`,
        `样本: ${JSON.stringify(rows.slice(0, SAMPLE_ROWS_PER_CHART))}`,
      ].join('\n')
    );
  }

  if (charts.length === 0) {
    return { ok: false, error: '全部报表查询执行失败', executedSqls };
  }

  // 阶段二：真实数据摘要 → 报表文本
  const stage2User = [
    `报表主题：${templateType}`,
    `额外要求：${customPrompt}`,
    ...(amountUnit ? [`金额单位口径：所有图表金额数值均已按「${amountUnit}」输出（SQL 已换算），文案必须沿用该单位`] : []),
    '',
    '以下为各图表的真实查询结果：',
    ...chartDigests,
  ].join('\n\n');

  let analysis: Record<string, any>;
  try {
    // v0.9.20 阶段二接入快速模型路由（对照问数链路 v0.3.6：解读类任务 LLM_ANALYSIS_* 可大幅提速；
    // 未配置时 analysisStageRoute() 返回 undefined 保持主模型，口径不变可一键回退）
    const text2 = await callLLMJson(buildReportStage2System(schema, amountUnit), stage2User, [], { route: analysisStageRoute() });
    analysis = safeParseJson(text2) || {};
    if (Object.keys(analysis).length === 0) {
      logger.warn('[LiveReport] 阶段二 LLM 输出解析为空对象（kpiList/insights 将缺失），原始输出前 200 字:', String(text2).slice(0, 200));
    }
  } catch (err) {
    // v0.5.0：阶段二失败不再静默——记录原因便于诊断（报表降级为兑底摘要，KPI/洞察缺失）
    logger.warn('[LiveReport] 阶段二 LLM 调用失败（kpiList/insights 将缺失）:', err instanceof Error ? err.message : err);
    analysis = {};
  }
  
  const commentaries = Array.isArray(analysis.commentaries)
    ? analysis.commentaries.filter((s: unknown): s is string => typeof s === 'string')
    : [];
  charts.forEach((c, i) => {
    // c.data 为 coerceNumericColumns 产出的行数组（Record<string, any>[]），此处仅取行数
    c.commentary = commentaries[i] || `本图基于真实查询返回的 ${(c.data as Record<string, unknown>[]).length} 行数据。`;
  });

  const rawReport = {
    title:
      (typeof analysis.title === 'string' && analysis.title.trim()) ||
      parsed.reportTitle ||
      `${templateType}（真实数据）`,
    summary:
      (typeof analysis.summary === 'string' && analysis.summary.trim()) ||
      `本报表基于 ${charts.length} 组真实查询、共 ${totalRows} 行数据生成。`,
    createdAt: new Date().toISOString().slice(0, 10),
    insights: Array.isArray(analysis.insights) ? analysis.insights : [],
    // KPI 字段矫正：LLM 常返回 change 为 null/number/缺省，label/value 缺失的项直接丢弃，
    // 保证下发字段符合 SavedReport 契约（前端异常扫描依赖 change 为字符串）
    kpiList: (Array.isArray(analysis.kpiList) ? analysis.kpiList : [])
      .filter((k: unknown): k is Record<string, unknown> => {
        if (!k || typeof k !== 'object') return false;
        const label = (k as Record<string, unknown>).label;
        return typeof label === 'string' && label.trim().length > 0;
      })
      .map((k) => ({
        label: String(k.label).trim(),
        value: k.value != null ? String(k.value) : '',
        change: k.change != null ? String(k.change) : '',
        status: ['good', 'bad', 'neutral'].includes(String(k.status)) ? String(k.status) : 'neutral',
      })),
    charts,
  };

  // v0.5.1 报表文案中文化兜底：阶段二未遵守约束时，服务端将英文表名/列名替换为中文业务名称
  const report = sanitizeReportNarrative(rawReport, schema);

  return { ok: true, report, executedSqls, totalRows };
}
