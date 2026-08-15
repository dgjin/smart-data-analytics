/**
 * P1-5 演示模式报告服务（与 liveReport.ts 对位）：非数据库直连数据源时，
 * LLM 单阶段生成演示报表，响应显式标记 simulated。
 * prompt 构建与结构校验收敛在本模块；审计与 fallback 属路由关注点。
 */
import { callLLMJson } from './llmClient';
import { normalizeReport, safeParseJson } from '../src/utils/queryResultNormalizer';

export interface SimulatedReportInput {
  templateType: string;
  customPrompt: string;
  schema: any[];
  guidance: string;
}

export interface SimulatedReportSuccess {
  ok: true;
  report: NonNullable<ReturnType<typeof normalizeReport>>;
}

export interface SimulatedReportFailure {
  ok: false;
  error: string;
}

export type SimulatedReportOutcome = SimulatedReportSuccess | SimulatedReportFailure;

/** 演示模式报表 system prompt（纯函数抽出便于单测） */
export function buildSimulatedReportSystem(schema: any[], guidance: string): string {
  return `你是一个资深数据分析总监（Head of Analytics），负责为CEO/CFO生成数据可视化决策报表。
当前数据源为演示模式（非 MySQL 直连），无法执行真实查询，请生成逼真的演示数据。

${guidance ? `当前数据源的完整 Schema 与可用维度/指标（由真实表结构提取）:
维度/指标摘要:
${guidance}

Schema 明细:
${JSON.stringify(schema, null, 2)}

【强制约束】kpiList 与 charts 中的指标和维度必须结合报告主题，从上述 Schema 中选取：
- chartConfig.xAxisKey 使用 Schema 中的维度列，chartConfig.yAxisKeys 使用指标列，字段名必须与 Schema 完全一致，严禁编造。
- 3 个 charts 应分别选取不同的维度（如时间趋势、类别对比、结构占比）与相关指标。
` : ''}
请输出标准JSON报告对象:
1. title: 报告标题 (例如: "2026年半年度运营与商业决策深度分析")
2. summary: 200字精炼高管摘要
3. createdAt: 日期字符串
4. insights: 4条核心战略洞察数组，包含 title, type ('positive'|'warning'|'info'|'critical'), content, actionItem
5. kpiList: 4个核心KPI卡片，包含 label, value, change, status ('good'|'bad'|'neutral')
6. charts: 3个不同维度的数据图表块，每个包含:
   - title: 图表标题
   - chartConfig: { type ('line'|'bar'|'area'|'pie'), title, xAxisKey, yAxisKeys (数组) }
   - data: 图表数据对象数组 (6-10条记录，字段名与 chartConfig 一致)
   - commentary: 该图表的数据解读

请只输出纯JSON，不要包含任何markdown代码块标记或其他说明文字。`;
}

/** 演示模式报表：LLM 生成 + 结构校验（与原主路由内联实现逐字对齐） */
export async function runSimulatedReport(input: SimulatedReportInput): Promise<SimulatedReportOutcome> {
  try {
    const prompt = `为企业决策层生成一份深度分析报告（演示数据模式），主题/类型为：${input.templateType}。用户额外要求：${input.customPrompt}`;
    const resultText = await callLLMJson(buildSimulatedReportSystem(input.schema, input.guidance), prompt);
    const parsed = safeParseJson(resultText);
    const report = parsed ? normalizeReport(parsed) : null;
    if (!report) {
      return { ok: false, error: 'LLM 报告内容未通过结构化校验' };
    }
    return { ok: true, report };
  } catch (err: any) {
    console.error('Report Generation Error:', err);
    return { ok: false, error: String(err?.message || err) };
  }
}
