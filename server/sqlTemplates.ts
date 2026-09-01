/**
 * v0.4.15 复杂 SQL 构建能力：参数化分析模板引擎。
 * 本地开源模型自由生成复杂 SQL（窗口函数/同比环比/复杂聚合）可靠性弱于云端旗舰模型，
 * 通过预置参数化模板由 LLM 做轻量“模板选择 + 参数填充”，服务端确定性拼装 SQL，
 * 保证口径零偏差且零依赖复杂语法生成能力；未命中模板时回退自由生成（liveQuery 中配置）。
 */

export type TemplateId = 'year_over_year' | 'month_over_month' | 'top_n_with_pct' | 'conditional_agg_cross_tab';

export interface AnalysisTemplate<T extends object = object> {
  id: TemplateId;
  label: string;
  description: string;
  paramSchema: T;
  buildSql(params: T, dialect?: 'mysql' | 'pg'): string;
}

interface YoYParams {
  dimension: string;
  filterYear: number;
  prevYear: number;
}

interface MoMParams {
  dimension: string;
  currentMonth: string;
  prevMonth: string;
}

interface TopNWithPctParams {
  metricAlias: string;
  dimension: string;
  topN: number;
  sortBy: 'ASC' | 'DESC';
}

interface CrossTabParams {
  rows: string;
  cols: Array<{ value: number; label: string }>;
}

const yearOverYear: AnalysisTemplate<YoYParams> = {
  id: 'year_over_year',
  label: '同比对比',
  description: '两期对比（本年 vs 去年），使用 LEFT JOIN 派生表计算同期数据',
  paramSchema: {} as YoYParams,
  buildSql(params, dialect = 'mysql'): string {
    const { dimension, filterYear, prevYear } = params;
    return `SELECT r.${dimension}, r.sum_curr AS curr_${filterYear}, COALESCE(p.sum_prev, 0) AS prev_${prevYear} FROM (SELECT ${dimension}, SUM(amt) sum_curr FROM t WHERE yr = ${filterYear} GROUP BY ${dimension}) r LEFT JOIN (SELECT ${dimension}, SUM(amt) sum_prev FROM t WHERE yr = ${prevYear} GROUP BY ${dimension}) p ON r.${dimension} = p.${dimension} ORDER BY r.sum_curr DESC LIMIT 100`;
  },
};

const monthOverMonth: AnalysisTemplate<MoMParams> = {
  id: 'month_over_month',
  label: '环比对比',
  description: '相邻月度对比（本月 vs 上月），按月聚合后 JOIN',
  paramSchema: {} as MoMParams,
  buildSql(params, dialect = 'mysql'): string {
    const { dimension, currentMonth, prevMonth } = params;
    return `SELECT r.${dimension}, r.sum_curr AS curr_month, COALESCE(p.sum_prev, 0) AS prev_month FROM (SELECT ${dimension}, SUM(amt) sum_curr FROM t WHERE dt >= '${currentMonth}-01' AND dt < '${currentMonth}.02' GROUP BY ${dimension}) r LEFT JOIN (SELECT ${dimension}, SUM(amt) sum_prev FROM t WHERE dt >= '${prevMonth}-01' AND dt < '${prevMonth}.02' GROUP BY ${dimension}) p ON r.${dimension} = p.${dimension} ORDER BY r.sum_curr DESC LIMIT 100`;
  },
};

const topNWithPct: AnalysisTemplate<TopNWithPctParams> = {
  id: 'top_n_with_pct',
  label: 'TOP-N 占比',
  description: '统计 TOP-N 维度及其合计占比（ROUND 保留两位小数）',
  paramSchema: {} as TopNWithPctParams,
  buildSql(params, dialect = 'mysql'): string {
    const { metricAlias, dimension, topN, sortBy } = params;
    const order = sortBy === 'DESC' ? 'DESC' : 'ASC';
    return `WITH ranked AS (SELECT ${dimension}, SUM(amt) AS ${metricAlias}, RANK() OVER (ORDER BY SUM(amt) ${order}) AS rn FROM t GROUP BY ${dimension}) SELECT ${dimension}, ${metricAlias}, ROUND(${metricAlias}*100.0/(SELECT SUM(amt) FROM t), 2) AS pct FROM ranked WHERE rn <= ${topN} ORDER BY ${metricAlias} ${order} LIMIT ${topN}`;
  },
};

const crossTab: AnalysisTemplate<CrossTabParams> = {
  id: 'conditional_agg_cross_tab',
  label: '条件聚合交叉表',
  description: '横向展开多维度指标（CASE WHEN + SUM）生成交叉表',
  paramSchema: {} as CrossTabParams,
  buildSql(params, dialect = 'mysql'): string {
    const { rows, cols } = params;
    const caseCols = cols.map((c) => `SUM(CASE WHEN yr = ${c.value} THEN amt ELSE 0 END) AS amt_${c.value}`).join(', ');
    const years = cols.map((c) => c.value).join(',');
    return `SELECT ${rows}, ${caseCols} FROM t WHERE yr IN (${years}) GROUP BY ${rows} ORDER BY amt_${cols[0]?.value || 0} DESC LIMIT 100`;
  },
};

export const AVAILABLE_TEMPLATES: AnalysisTemplate[] = [yearOverYear, monthOverMonth, topNWithPct, crossTab];

export function validateTemplateParams<T>(id: TemplateId, params: unknown): { ok: true; params: T } | { ok: false; reason: string } {
  if (typeof params !== 'object' || params === null) return { ok: false, reason: '参数必须是对象' };
  const t = params as any;

  switch (id) {
    case 'year_over_year': {
      if (!t.dimension || !Number.isInteger(t.filterYear) || !Number.isInteger(t.prevYear)) return { ok: false, reason: '缺少必要参数' };
      return { ok: true, params: t as T };
    }
    case 'month_over_month': {
      if (!t.dimension || !String(t.currentMonth) || !String(t.prevMonth)) return { ok: false, reason: '缺少必要参数' };
      return { ok: true, params: t as T };
    }
    case 'top_n_with_pct': {
      if (!t.metricAlias || !t.dimension || !Number.isInteger(t.topN) || !['ASC', 'DESC'].includes(t.sortBy)) return { ok: false, reason: '缺少必要参数或排序方向无效' };
      return { ok: true, params: t as T };
    }
    case 'conditional_agg_cross_tab': {
      if (!Array.isArray(t.cols) || t.cols.length === 0 || !t.rows) return { ok: false, reason: 'COLS 为空或缺 ROWS' };
      for (const c of t.cols) if (typeof c.value !== 'number' || typeof c.label !== 'string') return { ok: false, reason: 'COLS 项格式非法' };
      return { ok: true, params: t as T };
    }
    default:
      return { ok: false, reason: '未知模板 ID' };
  }
}
