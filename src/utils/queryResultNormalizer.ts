/**
 * LLM 响应归一化与 Schema 校验模块
 * 统一处理 AI 返回的 JSON：字段兼容（data/rows）、类型矫正、必填校验。
 * 服务端与单元测试共享该逻辑，避免裸 JSON.parse 直接信任模型输出。
 */

const VALID_CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'scatter', 'kpi', 'table'] as const;

/**
 * 剥离模型输出中可能包裹的 markdown 代码块标记
 */
export function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/**
 * 安全解析 JSON，失败时尝试从文本中提取首个 JSON 对象
 */
export function safeParseJson(text: string): Record<string, any> | null {
  const cleaned = stripCodeFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 尝试从混杂文本中提取 JSON 对象片段
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface NormalizedQueryResult {
  generatedSQL: string;
  thoughtProcess: string[];
  aiExplanation: string;
  keyInsights: string[];
  chartConfig: {
    type: string;
    title: string;
    xAxisKey: string;
    yAxisKeys: string[];
    yAxisNames?: Record<string, string>;
    stacked?: boolean;
    description?: string;
  } | null;
  rows: Record<string, any>[];
  columns: string[];
  totalCount: number;
  kpiMetrics?: {
    label: string;
    value: string | number;
    change?: number;
    trend?: 'up' | 'down' | 'neutral';
    subtext?: string;
  }[];
  suggestedQuestions: string[];
}

/**
 * 归一化自然语言查询结果。
 * 兼容 LLM 返回 `data` 或 `rows` 字段；校验失败返回 null（调用方走 fallback）。
 */
export function normalizeQueryResult(raw: any): NormalizedQueryResult | null {
  if (!raw || typeof raw !== 'object') return null;

  // 数据行：兼容 data / rows 两种字段名
  const rawRows = Array.isArray(raw.rows) ? raw.rows : Array.isArray(raw.data) ? raw.data : null;
  if (!rawRows) return null;
  const rows = rawRows.filter((r) => r && typeof r === 'object');

  // 图表配置校验与矫正
  let chartConfig: NormalizedQueryResult['chartConfig'] = null;
  const cc = raw.chartConfig;
  if (cc && typeof cc === 'object') {
    const type = (VALID_CHART_TYPES as readonly string[]).includes(cc.type) ? cc.type : 'bar';
    const yAxisKeys = Array.isArray(cc.yAxisKeys) ? cc.yAxisKeys.filter((k: any) => typeof k === 'string') : [];
    const xAxisKey = typeof cc.xAxisKey === 'string' ? cc.xAxisKey : Object.keys(rows[0] || {})[0] || '';

    if (yAxisKeys.length > 0 && xAxisKey) {
      chartConfig = {
        type,
        title: typeof cc.title === 'string' ? cc.title : '数据分析图表',
        xAxisKey,
        yAxisKeys,
        stacked: Boolean(cc.stacked),
      };
      if (cc.yAxisNames && typeof cc.yAxisNames === 'object') chartConfig.yAxisNames = cc.yAxisNames;
      if (typeof cc.description === 'string') chartConfig.description = cc.description;
    }
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    generatedSQL: typeof raw.generatedSQL === 'string' ? raw.generatedSQL : '',
    thoughtProcess: Array.isArray(raw.thoughtProcess)
      ? raw.thoughtProcess.filter((s: any) => typeof s === 'string')
      : [],
    aiExplanation: typeof raw.aiExplanation === 'string' ? raw.aiExplanation : '',
    keyInsights: Array.isArray(raw.keyInsights)
      ? raw.keyInsights.filter((s: any) => typeof s === 'string')
      : [],
    chartConfig,
    rows,
    columns,
    totalCount: rows.length,
    kpiMetrics: Array.isArray(raw.kpiMetrics)
      ? raw.kpiMetrics
          .filter((m: any) => m && typeof m === 'object' && m.label)
          .map((m: any) => ({
            label: String(m.label),
            value: m.value,
            change: typeof m.change === 'number' ? m.change : undefined,
            trend: ['up', 'down', 'neutral'].includes(m.trend) ? m.trend : undefined,
            subtext: typeof m.subtext === 'string' ? m.subtext : undefined,
          }))
      : undefined,
    suggestedQuestions: Array.isArray(raw.suggestedQuestions)
      ? raw.suggestedQuestions.filter((s: any) => typeof s === 'string').slice(0, 5)
      : [],
  };
}

/**
 * 归一化高管报告生成结果；关键字段缺失返回 null。
 */
export function normalizeReport(raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.title !== 'string' || typeof raw.summary !== 'string') return null;
  if (!Array.isArray(raw.insights) && !Array.isArray(raw.charts)) return null;
  return {
    ...raw,
    insights: Array.isArray(raw.insights) ? raw.insights : [],
    kpiList: Array.isArray(raw.kpiList) ? raw.kpiList : [],
    charts: Array.isArray(raw.charts) ? raw.charts : [],
  };
}
