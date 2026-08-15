/**
 * P1 报表真实化：双阶段高管报表编排。
 * 阶段一：LLM 按报表主题生成 2-4 条聚合查询计划（仅 SQL，不编造数据）；
 * 执行：逐条过安全执行层（允许部分失败，至少 1 条成功才继续）；
 * 阶段二：全部真实 rows 摘要回喂 LLM 生成高管摘要、洞察、KPI 与各图解读。
 */
import { callLLMJson } from './llmClient';
import { executeSafeSql } from './sqlExecutor';
import { safeParseJson } from '../src/utils/queryResultNormalizer';
import { buildColumnNames, buildColumnStats, coerceNumericColumns, dialectPromptOf, extractBusinessNotes } from './liveQuery';
import { getStateStore, isRedisEnabled } from './stateStore';

const MAX_REPORT_QUERIES = 4;
const SAMPLE_ROWS_PER_CHART = 10;

export interface LiveReportInput {
  templateType: string;
  customPrompt: string;
  schema: any[];
  guidance: string;
  dataSourceId: string;
  /** 数据源类型（mysql/postgresql/greenplum），用于阶段一 SQL 方言提示 */
  dsType?: string;
  sensitiveRemoved: string[];
  /** P1-3 行级权限（实际表名 → 谓词）：执行层 AST 强制注入 */
  rowFilters?: Record<string, string>;
  /** M4 报告计划批准：用户已批准的查询计划，存在时跳过阶段一重新生成 */
  approvedPlans?: { reportTitle: string; plans: ReportQueryPlan[] };
}

export type LiveReportOutcome =
  | { ok: true; report: Record<string, any>; executedSqls: string[]; totalRows: number }
  | { ok: false; error: string; executedSqls: string[] };

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
  expiresAt: number;
};
const reportPlanStore = new Map<string, ReportPlanEntry>();

export function newReportPlanId(): string {
  return `rplan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function storeReportPlan(
  plan: { reportTitle: string; plans: ReportQueryPlan[] },
  meta: { templateType: string; userId: number; dataSourceId: string },
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
  const parsed = await generateStage1Plans(input.templateType, input.customPrompt, input.schema, input.guidance, input.dsType);
  if (!parsed) return { ok: false, error: '报表查询计划生成失败' };
  return { ok: true, plan: parsed };
}

/** 阶段一：LLM 生成 2-4 条聚合查询计划（含 1 次校验重试） */
async function generateStage1Plans(
  templateType: string,
  customPrompt: string,
  schema: any[],
  guidance: string,
  dsType?: string
): Promise<{ reportTitle: string; plans: ReportQueryPlan[] } | null> {
  let parsed: { reportTitle: string; plans: ReportQueryPlan[] } | null = null;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const userPrompt =
      attempt === 0
        ? `报表主题：${templateType}\n额外要求：${customPrompt}`
        : `报表主题：${templateType}\n额外要求：${customPrompt}\n\n（上次输出未通过校验：${lastError}，请修正后按同一 JSON 契约重新输出。）`;
    let text: string;
    try {
      text = await callLLMJson(buildReportStage1System(schema, guidance, dsType), userPrompt);
    } catch {
      return null;
    }
    parsed = parseReportPlans(text);
    if (parsed) break;
    lastError = 'LLM 输出未通过查询计划契约校验';
  }
  return parsed;
}

function buildReportStage1System(schema: any[], guidance: string, dsType?: string): string {
  const dialect = dialectPromptOf(dsType);
  return `你是企业级 NL2SQL 引擎，为高管报表规划真实数据查询。根据报表主题与数据库 Schema，生成 2-4 条 ${dialect.label} SELECT 聚合查询。你不生成任何数据，只生成 SQL。

数据库 Schema（已经过权限与敏感字段过滤，只能使用其中的表与列）:
${JSON.stringify(schema)}

${extractBusinessNotes(schema)}${guidance ? `可用维度与指标摘要:\n${guidance}\n` : ''}
【强制约束】
- 仅输出 JSON 对象: {"reportTitle":"报表标题","queries":[{"title","sql","chartType","xAxisKey","yAxisKeys","columnNames","purpose"}]}
- columnNames: 该查询 SQL 输出每一列的中文表头映射 {"列名/别名": "中文名"}，维度列与聚合别名都要覆盖
- 每条 sql 为单条 SELECT；表名与列名必须逐字来自上述 Schema 的 name 字段，严禁添加 tbl_/t_ 等前缀、后缀或编造不存在的表/列；指标用聚合函数并用 AS 起英文/拼音别名
${dialect.rules}- queries 之间应选择不同维度（如时间趋势、类别对比、结构占比），避免重复
- chartType 从 bar/line/area/pie/donut/radar/treemap/heatmap 选择（时间趋势用 line/area，类别对比用 bar，占比结构用 pie/donut，层级占比用 treemap，多指标横向对照用 heatmap）；xAxisKey 与 yAxisKeys 必须与 SQL 输出列严格一致
- purpose: 一句话说明该图回答的业务问题
- 结果行数控制在 50 行以内（通过聚合或 LIMIT）

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
      yAxisKeys: Array.isArray(q.yAxisKeys) ? q.yAxisKeys.filter((k: any) => typeof k === 'string') : [],
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

function buildReportStage2System(): string {
  return `你是资深数据分析总监。你将收到一组真实数据库查询结果（各图表的 SQL、行数、列统计与数据样本）。基于这些真实数据撰写高管报表内容。

【强制约束】
- 仅输出 JSON 对象: {"title","summary","insights","kpiList","commentaries"}
- 所有数值必须来自给定的真实数据与列统计，严禁编造
- title: 报表标题；summary: 200 字以内高管摘要，概括真实数据反映的经营事实
- insights: 4 条战略洞察 [{"title","type","content","actionItem"}]，type 从 positive/warning/info/critical 选择，content 须引用真实数值
- kpiList: 4 个核心 KPI [{"label","value","change","status"}]，value 必须由真实数据计算（可引用列统计），change 仅在数据支持时给出，status 从 good/bad/neutral 选择
- commentaries: 字符串数组，按给定图表顺序逐图解读（每张图 60 字以内，须引用该图真实数据）

请只输出纯 JSON，不要包含 markdown 代码块标记或其他说明文字。`;
}

export async function runLiveReport(input: LiveReportInput): Promise<LiveReportOutcome> {
  const { templateType, customPrompt, schema, guidance, dataSourceId, dsType, sensitiveRemoved, rowFilters } = input;
  const executedSqls: string[] = [];

  // 阶段一：生成查询计划（已批准计划直接复用，跳过重新生成）
  let parsed: { reportTitle: string; plans: ReportQueryPlan[] } | null = input.approvedPlans ?? null;
  if (!parsed) {
    parsed = await generateStage1Plans(templateType, customPrompt, schema, guidance, dsType);
  }
  if (!parsed) {
    return { ok: false, error: '查询计划生成失败', executedSqls };
  }

  // 执行：逐条过安全执行层，允许部分失败
  const charts: Record<string, any>[] = [];
  const chartDigests: string[] = [];
  let totalRows = 0;
  for (const plan of parsed.plans) {
    const outcome = await executeSafeSql(dataSourceId, plan.sql, schema, sensitiveRemoved, 500, rowFilters || {});
    if (outcome.ok !== true) {
      console.warn(`[LiveReport] 查询失败已跳过: ${outcome.reason} | sql: ${plan.sql.slice(0, 200)}`);
      continue;
    }
    const rows = coerceNumericColumns(outcome.result.rows);
    executedSqls.push(outcome.result.finalSql);
    totalRows += outcome.result.rowCount;

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
        `SQL: ${outcome.result.finalSql}`,
        `行数: ${outcome.result.rowCount}`,
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
    '',
    '以下为各图表的真实查询结果：',
    ...chartDigests,
  ].join('\n\n');

  let analysis: Record<string, any>;
  try {
    const text2 = await callLLMJson(buildReportStage2System(), stage2User);
    analysis = safeParseJson(text2) || {};
  } catch {
    analysis = {};
  }

  const commentaries = Array.isArray(analysis.commentaries)
    ? analysis.commentaries.filter((s: any) => typeof s === 'string')
    : [];
  charts.forEach((c, i) => {
    c.commentary = commentaries[i] || `本图基于真实查询返回的 ${(c.data as any[]).length} 行数据。`;
  });

  const report = {
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
      .filter((k: any) => k && typeof k === 'object' && typeof k.label === 'string' && k.label.trim())
      .map((k: any) => ({
        label: String(k.label).trim(),
        value: k.value != null ? String(k.value) : '',
        change: k.change != null ? String(k.change) : '',
        status: ['good', 'bad', 'neutral'].includes(k.status) ? k.status : 'neutral',
      })),
    charts,
  };

  return { ok: true, report, executedSqls, totalRows };
}
