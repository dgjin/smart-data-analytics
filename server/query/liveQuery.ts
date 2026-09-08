/**
 * 智能问数双阶段真实查询编排（系统核心链路，HTTP 入口见 routes/query.ts）。
 *
 * 核心流程：
 * - 阶段一：LLM 仅生成 SQL 计划与图表配置（不编造数据）；生成前并行构建七路上下文
 *   （few-shot 样例 / 知识库 RAG / 外部知识库 / 语义指标 / 点踩反例 / 个人对话沉淀 / 铁律规则），
 *   模板命中时改走确定性 SQL 拼装；复杂问题多候选并行生成 + 多数表决择优，澄清/拒答竞速返回。
 * - 执行：executeSafeSql 安全执行层（SELECT-only + 表白名单 + 行级权限 + 超时）；失败把原因
 *   回喂 LLM 重试（最多 3 次），EXPLAIN 防线拦截仅给一次「收窄条件」自纠错机会（防自纠错空转）。
 * - 阶段二：真实 rows（采样 + 列统计）回喂 LLM 生成解读与 KPI；LLM 异常时规则化降级解读兜底。
 *
 * 关键设计：任一步骤失败由调用方降级到演示模式，保证可用性（降级不撒谎，结果带明确标识）。
 * 本文件仅保留接口定义与主编排：prompt 组装 / 响应解析 / 工具函数拆分至
 * liveQueryPrompts / liveQueryParsers / liveQueryUtils，经下方 re-export 保持统一入口 API 面不变。
 */
import { callLLMJson, sqlStageRoute, analysisStageRoute, ChatMessage } from '../llm/llmClient';
import { executeSafeSql } from './sqlExecutor';
import { resolveExpertPersonaAsync } from '../llm/expertPersona';
import { selectRelevantTablesAsync, pruneWideTableColumnsAsync, metricColumnsByTable } from './schemaLinking';
import { loadFewShotExamples, FewShotExample, loadNegativeExamples, NegativeExample } from './queryFeedback';
import { loadConversationFewShot } from './conversationHistory';
import { retrieveKnowledgeSnippets } from '../knowledge/knowledgeBase';
import { searchExternalKnowledge } from '../knowledge/externalKnowledge';
import { loadActiveMetrics, matchMetrics, buildMetricPrompt } from './metrics';
import { loadActiveIronRules, buildIronRulesPrompt } from './ironRules';
import type { SchemaTable } from './schemaTypes';
import { budgetText, budgetHistory, KNOWLEDGE_TOKEN_BUDGET } from '../llm/promptBudget';
import { serializeSchemaForPrompt } from './schemaGuidance';
import { safeParseJson } from '../../src/utils/queryResultNormalizer';
import type { TraceStep } from './queryTrace';
import type { QueryPlan } from './queryPlan';
import {
  assessComplexity,
  runAnalysisChain,
  extractAitRefs,
  getRegisteredAitNames,
  executeOnAppDb,
  describeIntermediateTables,
  IntermediateTableInfo,
} from './analysisChain';
import { AVAILABLE_TEMPLATES, validateTemplateParams } from './sqlTemplates';
import type { TemplateId } from './sqlTemplates';
import { logger } from '../infra/logger';
import {
  AMOUNT_UNIT_OPTIONS,
  VALID_STAGE1_CHARTS,
  buildAmountUnitPrompt,
  buildColumnNames,
  buildColumnStats,
  buildFallbackAnalysis,
  coerceNumericColumns,
  normalizeAmountUnit,
  rectifyChartKeys,
  resultSignature,
  sanitizeQueryResultChinese,
  selfCorrectCandidates,
} from './liveQueryUtils';
import {
  formatIntrospectionRows,
  parseClarification,
  parseIntrospection,
  parseRefusal,
  parseStage1,
  type Clarification,
  type Stage1Plan,
} from './liveQueryParsers';
import {
  buildStage1System,
  buildStage2System,
  candidatePrompt,
  dialectPromptOf,
  extractBusinessNotes,
} from './liveQueryPrompts';

/** 阶段二回喂 LLM 的真实行采样上限：兼顾 token 预算与统计代表性（列统计另由 buildColumnStats 提供） */
const SAMPLE_ROWS_FOR_LLM = 15;

export interface LiveQueryInput {
  /** 用户自然语言问题 */
  query: string;
  /** 多轮对话历史（按 token 预算截断后注入阶段一） */
  history: ChatMessage[];
  /** 数据源完整 Schema（安全白名单用全量；prompt 注入前经圈表/列裁剪） */
  schema: SchemaTable[];
  /** 业务口径指引文本（注入阶段一系统提示词） */
  guidance: string;
  /** 数据源 ID（few-shot/知识库/指标/铁律等上下文均按此隔离加载） */
  dataSourceId: string;
  /** 数据源显示名（注入 prompt 防止 LLM 把库名当数据过滤值） */
  dataSourceName?: string;
  /** 数据源类型（mysql/postgresql/greenplum），用于阶段一 SQL 方言提示 */
  dsType?: string;
  /** 已被 DLP 剔除的敏感列名（执行层二次拦截，prompt 中亦声明避免 LLM 引用） */
  sensitiveRemoved: string[];
  /** P1-3 行级权限（实际表名 → 谓词）：执行层 AST 强制注入，LLM 无法绕过 */
  rowFilters?: Record<string, string>;
  /** 数据源级数据自省开关（Vanna intermediate_sql 借鉴，默认关） */
  allowIntrospection?: boolean;
  /** SSE 阶段进度回调（P2-7）：understanding/executed/introspecting/analyzing */
  onStage?: (stage: string, info?: Record<string, unknown>) => void;
  /** M1 推导留痕回调：每步记录（旁路，实现方自行异步落库） */
  onTrace?: (step: TraceStep) => void;
  /** M2 计划模式：用户已批准的分析计划（按步骤引导 SQL 生成，跳过澄清） */
  approvedPlan?: QueryPlan;
  /** M3 深度分析：强制启用中间表清洗链（缺省由复杂度评估自动判定） */
  deepAnalysis?: boolean;
  /** M3 问数用户 ID：中间表归属与配额管理 */
  userId: number;
  /** M3 本次问数 trace ID：中间表注册关联 */
  traceId: string;
  /** 金额输出单位（亿元/百万元/万元/元）：阶段一 SQL 生成按除数换算，白名单外不生效 */
  amountUnit?: string;
}

export interface LiveQuerySuccess {
  ok: true;
  /** 组装完成、可直接过 normalizeQueryResult 的结果对象 */
  result: Record<string, any>;
  executedSql: string;
  rowCount: number;
  /** 阶段一/二 LLM 重试次数（0 表示一次通过） */
  retries: number;
}

export interface LiveQueryFailure {
  ok: false;
  error: string;
  executedSql?: string;
}


/** 歧义澄清：问题存在多种合理解读时返回，由前端渲染选项供用户确认后重发（仅首轮首个候选接受） */
export interface LiveQueryClarify {
  ok: 'clarify';
  clarification: Clarification;
}

/** 问题与当前数据源无关或超出系统能力时返回拒答：如实反馈，不走演示数据托底 */
export interface LiveQueryRefuse {
  ok: 'refuse';
  reason: string;
}

export type LiveQueryOutcome = LiveQuerySuccess | LiveQueryFailure | LiveQueryClarify | LiveQueryRefuse;



// ---------- 主编排 ----------

// 模块拆分外观 re-export：保持 liveQuery 统一入口 API 面不变（routes/测试等外部 import 路径零改动）
export {
  AMOUNT_UNIT_OPTIONS,
  VALID_STAGE1_CHARTS,
  buildAmountUnitPrompt,
  buildColumnNames,
  buildColumnStats,
  buildFallbackAnalysis,
  buildIdentifierNameMap,
  coerceNumericColumns,
  normalizeAmountUnit,
  rectifyChartKeys,
  replaceIdentifiersWithChinese,
  resultSignature,
  sanitizeQueryResultChinese,
  selfCorrectCandidates,
} from './liveQueryUtils';
export {
  enrichRefusalReason,
  formatIntrospectionRows,
  parseClarification,
  parseIntrospection,
  parseRefusal,
} from './liveQueryParsers';
export type { Clarification, ClarificationOption } from './liveQueryParsers';
export {
  buildStage1System,
  candidatePrompt,
  dialectPromptOf,
  extractBusinessNotes,
} from './liveQueryPrompts';

/**
 * 执行一次真实问数：阶段一生成 SQL → 安全执行 → 阶段二生成解读，全程推导留痕（onTrace）。
 * @param input 问数入参（问题/历史/Schema/数据源/权限/回调等，字段含义见 LiveQueryInput）
 * @returns 四分支结果：成功（ok=true）/ 失败（ok=false，附错误诊断）/ 歧义澄清（ok='clarify'）/ 拒答（ok='refuse'）；
 *          澄清与拒答仅在首轮首个候选上接受，重试与计划模式下按 SQL 契约直接执行
 */
export async function runLiveQuery(input: LiveQueryInput): Promise<LiveQueryOutcome> {
  const { query, history, schema, guidance, dataSourceId, dsType, sensitiveRemoved } = input;
  const trace = (step: TraceStep) => {
    try {
      input.onTrace?.(step);
    } catch {
      // 留痕失败不阻断主链路
    }
  };
  const t0 = Date.now();
  input.onStage?.('understanding');
  // M2 计划模式：已批准计划先留痕，阶段一按其步骤引导生成（并跳过歧义澄清）
  if (input.approvedPlan) {
    trace({
      stepType: 'plan',
      title: '按已批准计划执行',
      inputSummary: input.approvedPlan.understanding,
      outputSummary: `${input.approvedPlan.steps.length} 个步骤：${input.approvedPlan.steps.map((s) => s.title).join(' → ')}`,
      durationMs: Date.now() - t0,
    });
  }
  // Schema Linking（借鉴 Chat2DB AI 数据集）：大 schema 时只把相关表注入 prompt（P2-9 关键词粗排 + embedding 精排）；
  // 安全白名单（executeSafeSql）仍用全量 schema，召回遗漏不会误杀合法 SQL
  const promptSchemaBase = await selectRelevantTablesAsync(schema, query);
  trace({
    stepType: 'linking',
    title: 'Schema 圈表：选定相关表',
    inputSummary: query,
    outputSummary: `命中 ${promptSchemaBase.length}/${Array.isArray(schema) ? schema.length : 0} 张表：${promptSchemaBase.map((t) => String(t?.name || '')).join(', ')}`,
    durationMs: Date.now() - t0,
  });
  // 上下文构建并行化：few-shot / 知识库 RAG / 外部知识库 / 语义指标 / 点踩反例 / 个人对话沉淀 / 铁律规则七者互不依赖，并发执行（各自失败不阻断）
  const [fewShotPairs, knowledgeRaw, externalKb, metricHits, negativePairs, convPairs, ironRules] = await Promise.all([
    // P0 Few-shot（DAIL-SQL 双维度）：用圈定表名引导样例贴近当前可查表
    loadFewShotExamples(
      dataSourceId,
      query,
      promptSchemaBase.map((t) => String(t?.name || ''))
    ).catch(() => [] as FewShotExample[]),
    // P1-A 知识库 RAG：检索业务知识片段注入 prompt，按 token 预算截断
    retrieveKnowledgeSnippets(dataSourceId, query).catch(() => ''),
    // 外部知识库接入：管理员配置的企业级外部 RAG 检索，与本地知识一并作为自主学习来源（单源失败降级空）
    searchExternalKnowledge(dataSourceId, query).catch(() => null),
    // P1-1 语义指标层：问题命中指标名/同义词时模板化注入权威口径
    loadActiveMetrics(dataSourceId)
      .then((ms) => matchMetrics(query, ms))
      .catch(() => []),
    // 自主学习·反例：同数据源点踩问答对作为反面教材注入阶段一 prompt
    loadNegativeExamples(dataSourceId, query).catch(() => [] as NegativeExample[]),
    // 自主学习·个人沉淀：本人同数据源历史成功问答对作为个人 few-shot
    loadConversationFewShot(
      input.userId,
      dataSourceId,
      query,
      promptSchemaBase.map((t) => String(t?.name || ''))
    ).catch(() => []),
    // 铁律规则库（v0.9.35）：该数据源全部 ACTIVE 铁律恒注入（最高优先级强制约束，不按问题匹配）
    loadActiveIronRules(dataSourceId).catch(() => []),
  ]);
  // Vanna 借鉴：few-shot 以 user/assistant 消息对注入对话历史（比平铺文本更贴合 LLM 多轮格式）；
  // 团队样例库在前，个人对话沉淀在后，均为「先问题后 SQL」格式
  const fewShotHistory: ChatMessage[] = [
    ...fewShotPairs.map((ex) => ({ question: ex.question, sql: ex.sql })),
    ...convPairs,
  ].flatMap((ex) => [
    { role: 'user' as const, content: ex.question },
    { role: 'assistant' as const, content: ex.sql },
  ]);
  const knowledge = budgetText(knowledgeRaw, KNOWLEDGE_TOKEN_BUDGET);
  // 外部知识库片段独立预算控制，追加在本地知识之后（互不挤占注入槽位）
  const externalSnippet = externalKb?.snippet || '';
  trace({
    stepType: 'knowledge',
    title: '知识库检索与 Few-shot 样例',
    inputSummary: query,
    outputSummary: `知识片段 ${knowledge ? knowledge.length : 0} 字${externalSnippet ? `；外部知识库 ${externalSnippet.length} 字（成功 ${externalKb?.okSources ?? 0} 源${externalKb?.failSources ? `，失败 ${externalKb.failSources} 源` : ''}）` : ''}；few-shot 样例 ${fewShotPairs.length} 组（个人沉淀 ${convPairs.length} 组）；点踩反例 ${negativePairs.length} 组`,
    durationMs: Date.now() - t0,
  });
  const metricPrompt = buildMetricPrompt(metricHits);
  if (metricHits.length > 0) {
    trace({
      stepType: 'metrics',
      title: '语义指标层命中',
      inputSummary: query,
      outputSummary: `命中 ${metricHits.length} 个指标定义：${metricHits.map((m) => m.name).join('、')}`,
      durationMs: Date.now() - t0,
    });
  }
  // 铁律规则全量恒注入（v0.9.35）：ACTIVE 即最高优先级强制约束，注入留痕便于推导审计
  const ironRulesPrompt = buildIronRulesPrompt(ironRules);
  if (ironRules.length > 0) {
    trace({
      stepType: 'metrics',
      title: '铁律规则注入',
      inputSummary: query,
      outputSummary: `注入 ${ironRules.length} 条铁律：${ironRules.map((r) => r.title).join('、')}`,
      durationMs: Date.now() - t0,
    });
  }
  // P1-5 列级 Schema Linking：宽表（>50 列）圈表后再做列级相关性排序，仅注入 top-N 相关列
  // + 指标层引用列/主键（强制保留），降低宽表 prompt token 占用；安全白名单仍用全量 schema
  const columnPrune = await pruneWideTableColumnsAsync(promptSchemaBase, query, metricColumnsByTable(metricHits));
  const promptSchema = columnPrune.tables;
  if (columnPrune.pruned.length > 0) {
    trace({
      stepType: 'linking',
      title: '列级裁剪：宽表 top-N 列注入',
      inputSummary: query,
      outputSummary: columnPrune.pruned.map((p) => `${p.table} ${p.before}→${p.after} 列`).join('；'),
      durationMs: Date.now() - t0,
    });
  }
  // M3 中间表清洗链：复杂度评估自动触发（multi-step）或「深度分析」开关强制；
  // 清洗结果落库应用库中间表，阶段一可引用（仅引用 ait_* 时改在应用库执行）
  let chainTables: IntermediateTableInfo[] = [];
  const assessAt = Date.now();
  // 深度分析开关强制时需 LLM 产出清洗计划（force）；否则启发式预门控无信号直接判 simple
  const assessment = await assessComplexity(query, promptSchema, { force: Boolean(input.deepAnalysis) });
  trace({
    stepType: 'plan',
    title: '复杂度评估',
    inputSummary: query,
    outputSummary: assessment.complexity === 'multi-step' ? `多步复杂分析，清洗计划 ${assessment.steps.length} 步` : '简单问题，直接生成 SQL',
    durationMs: Date.now() - assessAt,
  });
  if (input.deepAnalysis || assessment.complexity === 'multi-step') {
    const chain = await runAnalysisChain({
      question: query,
      dataSourceId,
      schema,
      sensitiveRemoved,
      assessment,
      userId: input.userId,
      traceId: input.traceId,
      onTrace: input.onTrace,
    }).catch(() => null);
    if (chain) chainTables = chain.tables;
  }
  const stage1System = buildStage1System(promptSchema, guidance, knowledge + externalSnippet, fewShotPairs.length + convPairs.length, dsType, Boolean(input.allowIntrospection), input.approvedPlan, chainTables, metricPrompt, negativePairs, input.dataSourceName, ironRulesPrompt);
  // 多轮历史按 token 预算截断（保留最近轮次），与 few-shot 消息对拼接后注入阶段一
  const budgetedHistory = budgetHistory(history);
  // 专家角色路由：库化配置按 sortOrder 升序关键词匹配（仅 ADMIN 维护，v0.9.40），库异常时回退内置常量
  const persona = await resolveExpertPersonaAsync(query);

  let retries = 0;
  let plan: Stage1Plan | null = null;
  let exec: Awaited<ReturnType<typeof executeSafeSql>> | null = null;
  let lastError = '';
  // EXPLAIN 防线拦截标记：LLM 最多获得一次"收窄条件"自纠错机会，二次拦截即终止（防自纠错空转）
  let guardBlocked = false;
  // 数据自省仅首次尝试允许一轮（防止递归内省拖慢响应）
  let introspected = false;

  // P1-7 自纠错：按问题结构复杂度分档生成多候选（Self-Consistency 多数表决择优）。
  // 复杂信号：schema linking 圈定 ≥2 张表（多表 JOIN 场景）或复杂度评估判定需清洗链（multi-step/嵌套）。
  // 注意：assessment.complexity 的语义是「是否需要中间清洗链」，不等于 SQL 结构复杂度，不能单独作分档依据。
  // P0 性能优化：小模型路由表数阈值环境变量化（LLM_SQL_ROUTE_MAX_TABLES，默认 1 = 仅单表走快速模型，v0.5.0 原行为）。
  // 设为 2 时双表非 multi-step 查询也走快速模型（提速 3~5 倍）；
  // 注意实测风险：快速模型在多表 JOIN 时易漏 COUNT(DISTINCT) 造成重复计数，放宽后需关注准确率回归（可设回 1 一键回退）。
  const sqlRouteMaxTables = (() => {
    const raw = Number(process.env.LLM_SQL_ROUTE_MAX_TABLES);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  })();
  const isComplexQuery = assessment.complexity === 'multi-step' || promptSchema.length > sqlRouteMaxTables;
  const candidateCount = selfCorrectCandidates(isComplexQuery);
  // 阶段一模型分档：简单单表问题走配置的快速模型路由（flash），复杂/多表问题强制主模型。
  // 实测快速模型在多表 JOIN 时易漏 COUNT(DISTINCT) 造成重复计数，且同源多候选多数表决无法纠正系统性偏差，
  // 故复杂问题以口径正确性优先（P1-7 多候选择优仍保留）；未配置 LLM_SQL_* 时 sqlStageRoute() 返回 undefined 全程主模型。
  const stage1Route = isComplexQuery ? undefined : sqlStageRoute();

  // v0.4.15 C2: 模板匹配前置——优先尝试用 LLM 做"模板选择 + 参数填充"，命中则直接用模板引擎确定性拼装 SQL
  // 背景：本地开源模型自由生成复杂 SQL（窗口函数/同比环比）可靠性弱于云端旗舰，确定性模板零偏差兜底
  let templateSql: string | null = null;
  let matchedTemplateId: string | null = null;
  if (!input.approvedPlan && AVAILABLE_TEMPLATES.length > 0) {
    try {
      // 轻量 LLM 调用：输出 {templateId,params}；未命中时返回 null
      const templateMatchPrompt = `你是一个模板选择引擎。根据用户问题和 Schema，判断是否命中以下分析模板之一。若命中则输出 JSON{"templateId":"<id>","params":{<paramSchema>}}; 否则输出 null。

可用模板:
${AVAILABLE_TEMPLATES.map((t, i) => `${i + 1}. [${t.id}] ${t.label}: ${t.description}`).join('\n')}

Schema: ${serializeSchemaForPrompt(schema)}

用户问题：${query}

仅输出纯 JSON 或 null，不要任何 markdown 标记。`;
      const matchRaw = await callLLMJson(templateMatchPrompt, query, [], { route: stage1Route }).catch(() => null);
      const matchResult = matchRaw ? (safeParseJson(matchRaw) as { templateId?: string; params?: Record<string, unknown> } | null) : null;
      if (matchResult?.templateId && matchResult.params) {
        // templateId 来自 LLM 输出的动态字符串，此处单次受控断言收窄类型；非法值由 validateTemplateParams 白名单校验拒绝
        const validation = validateTemplateParams<object>(matchResult.templateId as TemplateId, matchResult.params);
        if (validation.ok) {
          const template = AVAILABLE_TEMPLATES.find((t) => t.id === matchResult.templateId);
          if (template) {
            templateSql = template.buildSql(validation.params, dsType === 'postgresql' || dsType === 'greenplum' ? 'pg' : 'mysql');
            matchedTemplateId = matchResult.templateId;
            trace({ stepType: 'template_match', title: '模板命中', inputSummary: query, outputSummary: `模板:${matchedTemplateId}`, status: 'ok' });
          }
        }
      }
    } catch {
      // 模板匹配失败不阻断主流程，落到下方自由生成路径
    }
  }

  // 阶段一 + 执行，失败时把原因回喂 LLM 重试一次（v0.4.15 D: 重试次数 2→3）
  for (let attempt = 0; attempt < 3; attempt++) {
    const unitPrefix = buildAmountUnitPrompt(normalizeAmountUnit(input.amountUnit));
    const basePrompt =
      attempt === 0
        ? `${unitPrefix}${query}`
        : `${unitPrefix}${query}\n\n（上次生成的 SQL 未通过校验或执行失败：${lastError}。请修正后按同一 JSON 契约重新输出。）`;
    const plans: Stage1Plan[] = [];

    // v0.4.15 C2: 模板命中标识——若模板引擎确定拼装 SQL，走下方统一执行流程（仍经安全层 SELECT-only/白名单/行过滤校验）；
    // 执行失败或结果异常时在循环尾清空模板，下一 attempt 回退自由生成兜底（方案 C：未命中回退自由生成）
    if (templateSql) {
      plans.push({
        sql: templateSql,
        title: `【模板】${AVAILABLE_TEMPLATES.find((t) => t.id === matchedTemplateId)?.label || matchedTemplateId}`,
        chartType: 'bar',
        xAxisKey: '',
        yAxisKeys: [],
        thoughtProcess: [`命中「${matchedTemplateId}」分析模板，由模板引擎确定性拼装 SQL（本地模型复杂语法生成能力的零偏差兜底）`],
      });
    } else {

    // 首轮即全并行生成 candidateCount 个候选（性能优化：原「首候选串行 + 成功后再并行补发 N-1 个」墙钟
    // ≈ 首候选耗时 + 最慢补发耗时 ≈ 2×单次，全并行 ≈ 最慢单候选 ≈ 1×）；候选 0 提示词与串行时代完全一致
    //（candidatePrompt index=0 恒返回原文），澄清/拒答/自省仍在收齐后的首个候选上按序判定，语义不变
    const n = candidateCount;
    const tasks: Promise<{ index: number; text: string }>[] = Array.from({ length: n }, (_, i) =>
      callLLMJson(stage1System, candidatePrompt(basePrompt, i, n), [...fewShotHistory, ...budgetedHistory], { route: stage1Route })
        .then((text) => ({ index: i, text }))
    );
    // 澄清/拒答竞速先行：首个成功候选立即判定，命中即返回不等其余候选收齐（避免全并行下澄清场景等待退化
    // 为最慢候选耗时）；未命中则落回收齐后的原判定路径（首个候选按序复查，语义不变）
    if (attempt === 0 && !input.approvedPlan) {
      let firstOk: { index: number; text: string } | null = null;
      try {
        firstOk = await Promise.any(tasks);
      } catch {
        // 全部候选网络层失败：落到下方统一处理
      }
      if (firstOk) {
        const clarification = parseClarification(firstOk.text);
        if (clarification) return { ok: 'clarify', clarification };
        const refusal = parseRefusal(firstOk.text);
        if (refusal) {
          trace({ stepType: 'sql_gen', title: 'SQL 生成（拒答）', inputSummary: query, outputSummary: refusal.reason, status: 'fail', durationMs: Date.now() - t0 });
          return { ok: 'refuse', reason: refusal.reason };
        }
      }
    }
    const settled = await Promise.allSettled(tasks);
    const texts: string[] = [];
    let firstRejectReason = '';
    for (const r of settled) {
      if (r.status === 'fulfilled') texts.push(r.value.text);
      else if (!firstRejectReason) firstRejectReason = String(r.reason?.message || r.reason).slice(0, 200);
    }
    // 首轮全部候选网络层失败：保持快速失败语义并返回明确诊断（不重试放大故障）
    if (attempt === 0 && texts.length === 0) {
      return { ok: false, error: `LLM 调用失败：${firstRejectReason || '全部候选生成失败'}` };
    }
    let candidateIndex = 0;
    for (const text of texts) {
      // 歧义澄清：仅首次尝试的第一个候选在接受（重试阶段视为用户已确认，按 SQL 契约执行）；
      // 计划模式下用户已批准计划，视为已确认理解，不再触发澄清
      if (attempt === 0 && candidateIndex === 0 && !input.approvedPlan) {
        const clarification = parseClarification(text);
        if (clarification) return { ok: 'clarify', clarification };
        // 拒答：问题与数据源无关/超出能力，如实反馈，不走演示数据托底（仅首候选首次尝试接受）
        const refusal = parseRefusal(text);
        if (refusal) {
          trace({ stepType: 'sql_gen', title: 'SQL 生成（拒答）', inputSummary: query, outputSummary: refusal.reason, status: 'fail', durationMs: Date.now() - t0 });
          return { ok: 'refuse', reason: refusal.reason };
        }
      }
      // 数据自省（Vanna intermediate_sql）：真实执行轻量自省 SQL，把实际取值回喂后再生成最终 SQL
      if (attempt === 0 && candidateIndex === 0 && input.allowIntrospection && !introspected) {
        const intro = parseIntrospection(text);
        if (intro) {
          introspected = true;
          input.onStage?.('introspecting', { note: intro.note });
          const introAt = Date.now();
          const introExec = await executeSafeSql(dataSourceId, intro.sql, schema, sensitiveRemoved, 500, input.rowFilters || {});
          if (introExec.ok === true) {
            trace({
              stepType: 'introspection',
              title: '数据自省：确认实际取值',
              inputSummary: intro.note || '确认过滤条件的真实取值',
              sqlText: intro.sql,
              rowCount: introExec.result.rows.length,
              durationMs: Date.now() - introAt,
            });
            try {
              const finalText = await callLLMJson(
                stage1System,
                `${query}\n\n【数据自省结果】${formatIntrospectionRows(introExec.result.rows)}\n请基于上述真实取值确定过滤条件，直接输出最终 SQL 的 JSON 契约（禁止再输出 needClarification 或 needIntrospection）`,
                [...fewShotHistory, ...budgetedHistory],
                { route: stage1Route }
              );
              const fp = parseStage1(finalText);
              if (fp) plans.push(fp);
            } catch {
              // 自省后的最终生成失败，走常规重试链路
            }
            // 自省链已二次生成最终 SQL；break 丢弃其余并行候选（基于猜测取值，不混入自省链）
            break;
          }
        }
      }
      const p = parseStage1(text);
      if (p) plans.push(p);
      candidateIndex++;
    }
    }
    if (plans.length === 0) {
      lastError = 'LLM 输出未通过 SQL 契约校验';
      retries++;
      trace({ stepType: 'sql_gen', title: `SQL 生成（第 ${attempt + 1} 次）`, inputSummary: query, outputSummary: lastError, status: 'fail', durationMs: Date.now() - t0 });
      continue;
    }
    trace({
      stepType: 'sql_gen',
      title: `SQL 生成（第 ${attempt + 1} 次${plans.length > 1 ? `，${plans.length} 个候选择优` : ''}）`,
      inputSummary: query,
      outputSummary: plans.map((p) => p.title).join('；'),
      sqlText: plans[0].sql,
      durationMs: Date.now() - t0,
    });
    // P2-1 SQL 先行回显：候选确定即推送（执行前），长执行等待期用户可先看到生成的 SQL
    input.onStage?.('sql_ready', { sql: plans[0].sql });
    // 逐候选执行（SELECT-only 只读，安全）；多候选时执行全部成功候选做结果集多数表决（P1-7 Self-Consistency）；
    // M3：仅引用已注册 ait_* 中间表的 SQL 改在应用库执行（不得与源表混用）
    let succeeded = false;
    const registeredAit = chainTables.length > 0 ? await getRegisteredAitNames() : new Set<string>();
    type ExecSuccess = Extract<Awaited<ReturnType<typeof executeSafeSql>>, { ok: true }>;
    const successes: { p: Stage1Plan; exec: ExecSuccess }[] = [];
    for (const p of plans) {
      const execAt = Date.now();
      const aitRefs = extractAitRefs(p.sql);
      let cur: Awaited<ReturnType<typeof executeSafeSql>>;
      if (aitRefs.length > 0) {
        cur = await executeOnAppDb(p.sql, registeredAit);
      } else {
        cur = await executeSafeSql(dataSourceId, p.sql, schema, sensitiveRemoved, 500, input.rowFilters || {});
      }
      if (cur.ok === true) {
        successes.push({ p, exec: cur });
        trace({
          stepType: 'execution',
          title: aitRefs.length > 0 ? '安全执行 SQL（分析库中间表）' : '安全执行 SQL',
          inputSummary: aitRefs.length > 0 ? `引用中间表：${aitRefs.join(', ')}` : 'SELECT-only 白名单校验通过',
          sqlText: cur.result.finalSql,
          rowCount: cur.result.rows.length,
          durationMs: Date.now() - execAt,
        });
        // 单候选：首个成功即收工；多候选：继续执行其余候选收集表决票
        if (plans.length === 1) break;
      } else {
        lastError = cur.reason;
        // EXPLAIN 防线拦截：推导链留痕，标记后下一轮给 LLM 一次收窄机会（reason 已含收窄指引）
        if (cur.guardBlocked) {
          guardBlocked = true;
          trace({
            stepType: 'execution',
            title: 'EXPLAIN 防线拦截',
            inputSummary: p.sql.slice(0, 120),
            outputSummary: cur.reason.replace(/^EXPLAIN_GUARD:\s*/, '').slice(0, 160),
            status: 'fail',
            durationMs: Date.now() - execAt,
          });
        }
      }
    }
    if (successes.length > 0) {
      succeeded = true;
      let winner = successes[0];
      if (successes.length > 1) {
        // 结果集多数表决：按规范化签名分组，多数派胜出；无多数（各候选互不相同）取首个成功候选
        const groups = new Map<string, { count: number; item: { p: Stage1Plan; exec: ExecSuccess } }>();
        for (const s of successes) {
          const sig = resultSignature(s.exec.result.rows);
          const g = groups.get(sig);
          if (g) g.count++;
          else groups.set(sig, { count: 1, item: s });
        }
        let best: { count: number; item: (typeof successes)[number] } | null = null;
        for (const g of groups.values()) {
          if (!best || g.count > best.count) best = g;
        }
        if (best && best.count > successes.length / 2) winner = best.item;
        trace({
          stepType: 'execution',
          title: 'Self-Consistency 多数表决',
          inputSummary: `${successes.length} 个候选执行成功，${groups.size} 种不同结果`,
          outputSummary: `采纳「${winner.p.title}」（${best ? best.count : 1}/${successes.length} 票）`,
          durationMs: 0,
        });
      }
      plan = winner.p;
      exec = winner.exec;
      input.onStage?.('executed', { sql: exec.result.finalSql, rowCount: exec.result.rows.length });
    }

    // v0.4.15 D: 结果合理性校验——检测到异常模式则回喂原因再生成一轮（本地算力免费，值得多一轮）
    if (succeeded && exec && exec.ok === true && !input.approvedPlan) {
      const rows = exec.result.rows || [];
      let reasonToRetry: string | null = null;
      if (rows.length === 0) reasonToRetry = '结果为空，请检查过滤条件或改用更宽松的统计口径';
      else if (rows.every((r) => Object.values(r).every((v) => v === null || v === undefined))) reasonToRetry = '所有列均为 NULL，查询逻辑可能有误';
      if (reasonToRetry) {
        trace({ stepType: 'result_check', title: '结果合理性校验', inputSummary: `${rows.length} 行`, outputSummary: reasonToRetry, status: 'fail', durationMs: 0 });
        lastError = `执行成功但结果异常：${reasonToRetry}`;
        succeeded = false;
      }
    }
    if (succeeded) break;
    // EXPLAIN 防线二次拦截：LLM 已有一次收窄机会仍未通过，终止自纠错（本地模型单轮生成慢，防空转）
    if (guardBlocked && attempt > 0) break;
    // 模板路径失败（执行失败或结果异常）：清空模板，下一 attempt 回退自由生成兜底
    if (templateSql) {
      trace({ stepType: 'template_match', title: '模板回退自由生成', inputSummary: query, outputSummary: lastError, status: 'fail', durationMs: 0 });
      templateSql = null;
      matchedTemplateId = null;
    }
    retries++;
    plan = attempt === 2 ? plans[plans.length - 1] : null;
  }

  if (!exec || exec.ok !== true) {
    // EXPLAIN 防线最终拦截：以拒答形态返回——用户需要的是收窄指引而非演示数据托底（FALLBACK 会给假数据）
    if (guardBlocked) {
      return { ok: 'refuse', reason: lastError.replace(/^EXPLAIN_GUARD:\s*/, '') };
    }
    return { ok: false, error: lastError || 'SQL 生成或执行失败' };
  }
  if (!plan) {
    return { ok: false, error: 'SQL 契约校验失败', executedSql: exec.result.finalSql };
  }

  const rows = coerceNumericColumns(exec.result.rows);
  const finalSql = exec.result.finalSql;
  const keys = rectifyChartKeys(rows, plan.xAxisKey, plan.yAxisKeys);
  const columnNames = buildColumnNames(rows, schema, plan.yAxisNames, plan.columnNames);
  // 图表轴名中文化：yAxisNames 缺失的指标用 columnNames 补齐（图例/tooltip 不再出现英文列名），并补维度中文名
  const yAxisNames: Record<string, string> = {};
  for (const k of keys.yAxisKeys) {
    const n = plan.yAxisNames?.[k] || columnNames[k];
    if (n) yAxisNames[k] = n;
  }
  const chartConfig = {
    type: plan.chartType,
    title: plan.title,
    xAxisKey: keys.xAxisKey,
    yAxisKeys: keys.yAxisKeys,
    ...(Object.keys(yAxisNames).length > 0 ? { yAxisNames } : {}),
    ...(columnNames[keys.xAxisKey] ? { xAxisName: columnNames[keys.xAxisKey] } : {}),
  };

  // 空结果集：跳过阶段二，直接给出真实结论
  if (rows.length === 0) {
    return {
      ok: true,
      executedSql: finalSql,
      rowCount: 0,
      retries,
      result: sanitizeQueryResultChinese({
        generatedSQL: finalSql,
        thoughtProcess: plan.thoughtProcess,
        aiExplanation: '查询已成功执行，但当前条件下没有匹配的数据。可尝试放宽筛选条件或更换维度重新提问。',
        keyInsights: ['真实查询返回 0 行数据'],
        chartConfig,
        data: [],
        kpiMetrics: [],
        suggestedQuestions: [],
        expertPersona: persona.label,
      }, schema),
    };
  }

  // 阶段二：真实 rows 摘要回喂 LLM 生成解读
  input.onStage?.('analyzing');
  const analyzeAt = Date.now();
  const stats = buildColumnStats(rows);
  const sample = rows.slice(0, SAMPLE_ROWS_FOR_LLM);
  const stage2User = [
    `用户问题：${query}`,
    '',
    `真实查询结果：`,
    `- SQL: ${finalSql}`,
    `- 总行数: ${exec.result.rowCount}${exec.result.truncated ? '（超出部分已截断）' : ''}`,
    `- 列统计: ${JSON.stringify(stats)}`,
    `- 数据样本（前 ${sample.length} 行）: ${JSON.stringify(sample)}`,
    `- 图表配置: ${JSON.stringify(chartConfig)}`,
  ].join('\n');

  let analysis: Record<string, any>;
  let analysisFailed = false;
  try {
    // 阶段二解读支持快速模型路由（LLM_ANALYSIS_ENGINE/LLM_ANALYSIS_MODEL）；未配置时用主模型保证质量
    const text2 = await callLLMJson(buildStage2System(persona.rolePrompt), stage2User, [], { route: analysisStageRoute() });
    analysis = safeParseJson(text2) || {};
  } catch (err: any) {
    analysis = {};
    analysisFailed = true;
    logger.warn('[Analysis] 阶段二解读失败，降级规则化解读:', err?.message || err);
  }

  // 降级：LLM 失败或返回空 aiExplanation 时，用 stats + rows 构造有数据支撑的解读
  const hasValidExplanation = typeof analysis.aiExplanation === 'string' && analysis.aiExplanation.trim().length > 0;
  if (analysisFailed || !hasValidExplanation) {
    const fallback = buildFallbackAnalysis(rows, stats, columnNames, chartConfig);
    analysis.aiExplanation = fallback.aiExplanation;
    if (!Array.isArray(analysis.keyInsights) || analysis.keyInsights.length === 0) {
      analysis.keyInsights = fallback.keyInsights;
    }
    if (!Array.isArray(analysis.kpiMetrics) || analysis.kpiMetrics.length === 0) {
      analysis.kpiMetrics = fallback.kpiMetrics;
    }
  }

  trace({
    stepType: 'analysis',
    title: `数据解读（${persona.label}）${analysisFailed ? '【LLM 失败，规则降级】' : ''}`,
    inputSummary: `真实结果 ${exec.result.rowCount} 行 + 列统计回喂`,
    outputSummary: typeof analysis.aiExplanation === 'string' ? analysis.aiExplanation : '解读生成失败，使用兜底文案',
    durationMs: Date.now() - analyzeAt,
  });

  return {
    ok: true,
    executedSql: finalSql,
    rowCount: exec.result.rowCount,
    retries,
    // 铁律「表头及说明必须中文」服务端兜底：LLM 未遵守时强制替换残留英文标识符（v0.9.39）
    result: sanitizeQueryResultChinese({
      generatedSQL: finalSql,
      thoughtProcess: plan.thoughtProcess,
      aiExplanation: analysis.aiExplanation,
      keyInsights: Array.isArray(analysis.keyInsights)
        ? analysis.keyInsights.filter((s: unknown): s is string => typeof s === 'string').slice(0, 5)
        : [],
      chartConfig,
      data: rows,
      columnNames,
      kpiMetrics: Array.isArray(analysis.kpiMetrics) ? analysis.kpiMetrics : [],
      suggestedQuestions: Array.isArray(analysis.suggestedQuestions)
        ? analysis.suggestedQuestions.filter((s: unknown): s is string => typeof s === 'string').slice(0, 5)
        : [],
      expertPersona: persona.label,
    }, schema),
  };
}
