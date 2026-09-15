/**
 * LLM 响应归一化与 Schema 校验模块
 * 统一处理 AI 返回的 JSON：字段兼容（data/rows）、类型矫正、必填校验。
 * 服务端与单元测试共享该逻辑，避免裸 JSON.parse 直接信任模型输出。
 */

const VALID_CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'scatter', 'treemap', 'heatmap', 'kpi', 'table'] as const;

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
export function safeParseJson(text: string): Record<string, unknown> | null {
  const cleaned = stripCodeFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // 尝试从混杂文本中提取 JSON 对象片段
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
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
    xAxisName?: string;
    stacked?: boolean;
    description?: string;
  } | null;
  rows: Record<string, unknown>[];
  columnNames?: Record<string, string>;
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
  /** 本次回答使用的专家角色标签（按问题关键词路由，见 server/expertPersona.ts） */
  expertPersona?: string;
}

/**
 * 归一化自然语言查询结果。
 * 兼容 LLM 返回 `data` 或 `rows` 字段；校验失败返回 null（调用方走 fallback）。
 */
export function normalizeQueryResult(raw: unknown): NormalizedQueryResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;

  // 数据行：兼容 data / rows 两种字段名
  const rawRows = Array.isArray(src.rows) ? src.rows : Array.isArray(src.data) ? src.data : null;
  if (!rawRows) return null;
  const rows = rawRows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');

  // 图表配置校验与矫正
  let chartConfig: NormalizedQueryResult['chartConfig'] = null;
  const cc = src.chartConfig;
  if (cc && typeof cc === 'object') {
    const c = cc as Record<string, unknown>;
    const type = typeof c.type === 'string' && (VALID_CHART_TYPES as readonly string[]).includes(c.type) ? c.type : 'bar';
    const yAxisKeys = Array.isArray(c.yAxisKeys) ? c.yAxisKeys.filter((k): k is string => typeof k === 'string') : [];
    const xAxisKey = typeof c.xAxisKey === 'string' ? c.xAxisKey : Object.keys(rows[0] || {})[0] || '';

    if (yAxisKeys.length > 0 && xAxisKey) {
      chartConfig = {
        type,
        title: typeof c.title === 'string' ? c.title : '数据分析图表',
        xAxisKey,
        yAxisKeys,
        stacked: Boolean(c.stacked),
      };
      if (c.yAxisNames && typeof c.yAxisNames === 'object') chartConfig.yAxisNames = c.yAxisNames as Record<string, string>;
      if (typeof c.xAxisName === 'string') chartConfig.xAxisName = c.xAxisName;
      if (typeof c.description === 'string') chartConfig.description = c.description;
    }
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    generatedSQL: typeof src.generatedSQL === 'string' ? src.generatedSQL : '',
    thoughtProcess: Array.isArray(src.thoughtProcess)
      ? src.thoughtProcess.filter((s): s is string => typeof s === 'string')
      : [],
    aiExplanation: typeof src.aiExplanation === 'string' ? src.aiExplanation : '',
    keyInsights: Array.isArray(src.keyInsights)
      ? src.keyInsights.filter((s): s is string => typeof s === 'string')
      : [],
    chartConfig,
    rows,
    columnNames:
      src.columnNames && typeof src.columnNames === 'object'
        ? (Object.fromEntries(
            Object.entries(src.columnNames).filter(
              ([k, v]) => typeof k === 'string' && typeof v === 'string'
            )
          ) as Record<string, string>)
        : undefined,
    columns,
    totalCount: rows.length,
    kpiMetrics: Array.isArray(src.kpiMetrics)
      ? src.kpiMetrics
          .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !!m.label)
          .map((m) => ({
            label: String(m.label),
            value: m.value as string | number,
            change: typeof m.change === 'number' ? m.change : undefined,
            trend: ['up', 'down', 'neutral'].includes(m.trend as string) ? (m.trend as 'up' | 'down' | 'neutral') : undefined,
            subtext: typeof m.subtext === 'string' ? m.subtext : undefined,
          }))
      : undefined,
    suggestedQuestions: Array.isArray(src.suggestedQuestions)
      ? src.suggestedQuestions.filter((s): s is string => typeof s === 'string').slice(0, 5)
      : [],
    expertPersona: typeof src.expertPersona === 'string' ? src.expertPersona : undefined,
  };
}

/**
 * 归一化高管报告生成结果；关键字段缺失返回 null。
 */
export function normalizeReport(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.title !== 'string' || typeof src.summary !== 'string') return null;
  if (!Array.isArray(src.insights) && !Array.isArray(src.charts)) return null;
  return {
    ...src,
    insights: Array.isArray(src.insights) ? src.insights : [],
    // KPI 字段矫正：LLM 输出的 change 可能是 null/number/缺省，统一为字符串（前端异常扫描依赖）
    kpiList: (Array.isArray(src.kpiList) ? src.kpiList : [])
      .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object' && typeof k.label === 'string' && !!k.label.trim())
      .map((k) => ({
        label: String(k.label).trim(),
        value: k.value != null ? String(k.value) : '',
        change: k.change != null ? String(k.change) : '',
        status: typeof k.status === 'string' && ['good', 'bad', 'neutral'].includes(k.status) ? k.status : 'neutral',
      })),
    charts: Array.isArray(src.charts) ? src.charts : [],
  };
}
