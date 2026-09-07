/**
 * liveQuery 纯函数工具层：金额单位口径、真实 rows 后处理与统计、自纠错候选数、
 * 结果签名（多数表决）、阶段二规则化降级解读。零 LLM/IO 依赖，供编排层与测试复用。
 */
import type { SchemaTable } from './schemaTypes';

export const VALID_STAGE1_CHARTS = ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'scatter', 'treemap', 'heatmap'] as const;

/** 问数金额单位选项：用户问数前自选，SQL 生成时按除数换算（divisor=元为原值） */
export const AMOUNT_UNIT_OPTIONS: Record<string, { label: string; divisor: number; suffix: string }> = {
  '亿元': { label: '亿元', divisor: 100000000, suffix: 'yi' },
  '百万元': { label: '百万元', divisor: 1000000, suffix: 'baiwan' },
  '万元': { label: '万元', divisor: 10000, suffix: 'wan' },
  '元': { label: '元', divisor: 1, suffix: 'yuan' },
};

/** 金额单位白名单归一：非白名单值返回 undefined（不注入约定，保持原值口径） */
export function normalizeAmountUnit(v: unknown): string | undefined {
  const s = String(v || '').trim();
  return AMOUNT_UNIT_OPTIONS[s] ? s : undefined;
}

/** 金额单位 prompt 约定：拼在阶段一用户消息首位，指令 SQL 对金额列统一除以除数并带单位后缀；v0.5.2 起导出供报表链路复用 */
export function buildAmountUnitPrompt(unit?: string): string {
  const opt = unit ? AMOUNT_UNIT_OPTIONS[unit] : undefined;
  if (!opt) return '';
  return `【金额单位约定】本次查询所有金额类指标统一以「${opt.label}」为单位输出：SQL 中对金额列聚合结果除以 ${opt.divisor} 并用 ROUND 保留两位小数（如 ROUND(SUM(金额列)/${opt.divisor}, 2)），别名带 _${opt.suffix} 后缀，列名/图表/解读沿用该单位。${opt.divisor === 1 ? '「元」为原值口径：直接 ROUND(SUM(金额列), 2)，不要除以 1。' : ''}\n\n`;
}

// ---------- 真实 rows 后处理与统计 ----------

/** mysql2 将 DECIMAL/聚合值返回为字符串；把可安全转换的列统一转为 number，便于图表与统计 */
export function coerceNumericColumns(rows: Record<string, any>[]): Record<string, any>[] {
  if (rows.length === 0) return rows;
  const cols = Object.keys(rows[0]);
  const numericCols = cols.filter((c) => {
    let seen = 0;
    for (const r of rows.slice(0, 50)) {
      const v = r[c];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number') { seen++; continue; }
      if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim())) { seen++; continue; }
      return false;
    }
    return seen > 0;
  });
  if (numericCols.length === 0) return rows;
  return rows.map((r) => {
    const next: Record<string, any> = { ...r };
    for (const c of numericCols) {
      const v = next[c];
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) next[c] = n;
      }
    }
    return next;
  });
}

/** 列统计摘要：数值列给 sum/avg/min/max，维度列给 distinct，辅助阶段二不编造数值 */
export function buildColumnStats(rows: Record<string, any>[]): Record<string, any> {
  if (rows.length === 0) return {};
  const stats: Record<string, any> = {};
  for (const c of Object.keys(rows[0])) {
    const nums = rows
      .map((r) => r[c])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (nums.length >= Math.max(1, Math.floor(rows.length * 0.5))) {
      const sum = nums.reduce((a, b) => a + b, 0);
      stats[c] = {
        总计: Math.round(sum * 100) / 100,
        均值: Math.round((sum / nums.length) * 100) / 100,
        最小: Math.min(...nums),
        最大: Math.max(...nums),
      };
    } else {
      const distinct = new Set(rows.map((r) => String(r[c]))).size;
      stats[c] = { 去重取值数: distinct };
    }
  }
  return stats;
}

/** 矫正图表轴键：必须与真实 rows 的列名一致，否则前端渲染空白 */
export function rectifyChartKeys(
  rows: Record<string, any>[],
  xAxisKey: unknown,
  yAxisKeys: unknown
): { xAxisKey: string; yAxisKeys: string[] } {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  const numericCols = cols.filter((c) => rows.some((r) => typeof r[c] === 'number'));
  const dimCols = cols.filter((c) => !numericCols.includes(c));

  let x = typeof xAxisKey === 'string' && cols.includes(xAxisKey) ? xAxisKey : '';
  if (!x) x = dimCols[0] || cols[0] || '';

  let ys = Array.isArray(yAxisKeys)
    ? yAxisKeys.filter((k): k is string => typeof k === 'string' && cols.includes(k))
    : [];
  if (ys.length === 0) ys = numericCols.length > 0 ? numericCols.slice(0, 3) : cols.filter((c) => c !== x).slice(0, 1);
  return { xAxisKey: x, yAxisKeys: ys };
}

/**
 * 组装结果列的中文表头映射：schema 列 description（管理员维护）为底，
 * yAxisNames / LLM columnNames 覆盖（聚合别名的中文名只有 LLM 知道）。
 * 只保留真实出现在结果行中的列，键全部限定为白名单内的列名。
 */
export function buildColumnNames(
  rows: Array<Record<string, unknown>>,
  schema: SchemaTable[],
  ...overrides: Array<Record<string, string> | undefined>
): Record<string, string> {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  if (cols.length === 0) return {};
  const out: Record<string, string> = {};
  const tables = Array.isArray(schema) ? schema : [];
  for (const col of cols) {
    for (const t of tables) {
      const c = (t?.columns || []).find((x) => x && x.name === col);
      if (c && typeof c.description === 'string' && c.description.trim()) {
        out[col] = c.description.trim();
        break;
      }
    }
  }
  for (const map of overrides) {
    if (!map || typeof map !== 'object') continue;
    for (const col of cols) {
      const v = map[col];
      if (typeof v === 'string' && v.trim()) out[col] = v.trim().slice(0, 50);
    }
  }
  return out;
}

/**
 * P1-B/P1-7 自纠错候选数（借鉴 DB-GPT Self-consistency 思想）。
 * 多候选 SQL 生成后逐候选执行、结果集多数表决择优，提升复杂问题准确率。
 * P1-7 分档触发：未显式配置时按问题结构复杂度分档——复杂问题（多表/嵌套/需清洗链）3 候选，
 * 简单问题保持 1 以控成本；env SELF_CORRECT_CANDIDATES 显式设置（1-3）时优先于分档（1 = 强制关闭多候选）。
 */
export function selfCorrectCandidates(complex?: boolean): number {
  const raw = process.env.SELF_CORRECT_CANDIDATES;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n <= 1 ? 1 : Math.min(3, Math.floor(n));
  }
  return complex === true ? 3 : 1;
}

/** 结果集规范化签名（多数表决用）：列名排序 + 数值列归一，消除列序/数值字符串差异 */
export function resultSignature(rows: Record<string, any>[]): string {
  const normalized = coerceNumericColumns(rows).map((r) => {
    const sorted: Record<string, any> = {};
    for (const k of Object.keys(r).sort()) sorted[k] = r[k];
    return sorted;
  });
  return JSON.stringify(normalized);
}

// ---------- 阶段二：真实 rows → 分析解读 ----------

/**
 * 阶段二异常降级：基于列统计生成规则化解读（不依赖 LLM）。
 * 当 LLM 调用失败/超时/返回无效 JSON 时，用已有 stats + rows 构造有数据支撑的解读，
 * 避免 "查询返回 N 行" 这种无信息量的兜底文案。
 */
export function buildFallbackAnalysis(
  rows: Array<Record<string, unknown>>,
  stats: Record<string, { 总计?: number; 均值?: number; 最小?: number | string; 最大?: number | string; 去重取值数?: number }>,
  columnNames: Record<string, string>,
  chartConfig: { xAxisKey?: string; yAxisKeys?: string[] }
): { aiExplanation: string; keyInsights: string[]; kpiMetrics: Array<{ label: string; value: string; subtext: string }> } {
  const rowCount = rows.length;
  // 数值列统计四字段同生同灭（buildColumnStats 一次写入 总计/均值/最小/最大），守卫判定 总计 后按完整形态使用
  type NumericStat = { 总计: number; 均值: number; 最小: number | string; 最大: number | string };
  const isNumericStat = (v: { 总计?: number } | undefined): v is NumericStat => !!v && typeof v.总计 === 'number';
  const numericStats = new Map<string, NumericStat>();
  for (const [key, value] of Object.entries(stats)) {
    if (isNumericStat(value)) numericStats.set(key, value);
  }
  const numericCols = [...numericStats.keys()];
  const dimCols = Object.keys(stats).filter((c) => !numericStats.has(c));

  // 1. aiExplanation：按数据特征组织
  const parts: string[] = [];
  parts.push(`查询共返回 ${rowCount} 条记录`);

  if (numericCols.length > 0) {
    const top = numericCols.slice(0, 2);
    const descs = top.map((c) => {
      const s = numericStats.get(c)!;
      const name = columnNames[c] || c;
      return `${name}总计 ${s.总计.toLocaleString('zh-CN')}，均值 ${s.均值.toLocaleString('zh-CN')}，区间 ${s.最小} ~ ${s.最大}`;
    });
    parts.push(`；${descs.join('；')}`);
  }

  if (dimCols.length > 0) {
    const d = dimCols[0];
    const name = columnNames[d] || d;
    parts.push(`；按${name}划分共 ${stats[d].去重取值数} 个维度`);
  }

  if (chartConfig.xAxisKey && chartConfig.yAxisKeys && chartConfig.yAxisKeys.length > 0) {
    const xName = columnNames[chartConfig.xAxisKey] || chartConfig.xAxisKey;
    parts.push(`，图表以 ${xName} 为维度展示`);
  }

  parts.push('。');

  // 2. keyInsights：从 stats 中提取 3 条
  const insights: string[] = [];
  if (numericCols.length > 0) {
    const c = numericCols[0];
    const s = numericStats.get(c)!;
    const name = columnNames[c] || c;
    insights.push(`${name}最高达 ${s.最大.toLocaleString('zh-CN')}，最低 ${s.最小.toLocaleString('zh-CN')}，波动幅度较大`);
    if (numericCols.length > 1) {
      const c2 = numericCols[1];
      const s2 = numericStats.get(c2)!;
      const name2 = columnNames[c2] || c2;
      insights.push(`${name2}均值为 ${s2.均值.toLocaleString('zh-CN')}，总计 ${s2.总计.toLocaleString('zh-CN')}`);
    }
  }
  if (dimCols.length > 0 && insights.length < 3) {
    const d = dimCols[0];
    const name = columnNames[d] || d;
    insights.push(`按${name}细分共 ${stats[d].去重取值数} 个分组，可进一步下钻分析`);
  }

  // 3. kpiMetrics：取前 2 个数值列做 KPI 卡片
  const kpis: Array<{ label: string; value: string; subtext: string }> = [];
  for (const c of numericCols.slice(0, 2)) {
    const s = numericStats.get(c)!;
    const name = columnNames[c] || c;
    kpis.push({ label: `${name}（总计）`, value: s.总计.toLocaleString('zh-CN'), subtext: `均值 ${s.均值.toLocaleString('zh-CN')}` });
    kpis.push({ label: `${name}（峰值）`, value: s.最大.toLocaleString('zh-CN'), subtext: `最小 ${s.最小.toLocaleString('zh-CN')}` });
  }

  return {
    aiExplanation: parts.join(''),
    keyInsights: insights.slice(0, 3),
    kpiMetrics: kpis.slice(0, 4),
  };
}
