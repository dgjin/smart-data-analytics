/**
 * P1-6 多维自动归因引擎（纯函数，无 IO 依赖）：
 * 对两组期次数据按维度组合做贡献度拆解——delta_i 占全部行变化量绝对值之和的比重，
 * 正=拉高总指标、负=拉低；输出按 |delta| 排序的贡献表、拉高/拉低 TOP 与中文诊断。
 * 语义约定：适配可加指标（金额/数量/余额）；比率型指标（如不良率）需上游先按
 * 权重结构（分子/分母）展开为可加量后再归因，避免简单求和失真。
 */

export interface AttributionInputRow {
  /** 维度值组合（1~3 维，如 ['华东', 'M1']） */
  dims: string[];
  /** 当期值 */
  current: number;
  /** 对比期值 */
  previous: number;
}

export interface AttributionItem {
  dims: string[];
  current: number;
  previous: number;
  delta: number;
  /** 自身变化率（%，对比期为 0 时为 null） */
  deltaPct: number | null;
  /** 对总体变化的贡献占比（%）：delta_i / Σ|delta_j| × 100（分母为 0 时全 0） */
  contribution: number;
  /** 按 |delta| 降序排名（1-based） */
  rank: number;
}

export interface AttributionResult {
  items: AttributionItem[];
  total: { current: number; previous: number; delta: number; deltaPct: number | null };
  /** 拉高总指标 TOP N（delta > 0，按 |delta| 降序） */
  topPositive: AttributionItem[];
  /** 拉低总指标 TOP N（delta < 0，按 |delta| 降序） */
  topNegative: AttributionItem[];
  /** 中文诊断（集中度、反向行数、无效分母等） */
  diagnostics: string[];
}

export const MAX_ATTRIBUTION_ROWS = 200;
export const MAX_ATTRIBUTION_DIMS = 3;

export function attributeDelta(rows: AttributionInputRow[], opts?: { topN?: number }): AttributionResult {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('至少需要一行归因数据');
  }
  if (rows.length > MAX_ATTRIBUTION_ROWS) {
    throw new Error(`归因数据行数超出上限（最多 ${MAX_ATTRIBUTION_ROWS} 行）`);
  }
  const topN = Number.isFinite(opts?.topN) && (opts?.topN as number) > 0 ? Math.floor(opts?.topN as number) : 3;

  let curSum = 0;
  let prevSum = 0;
  const raw = rows.map((r) => {
    const current = Number(r.current);
    const previous = Number(r.previous);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      throw new Error('归因数据包含非数值项');
    }
    curSum += current;
    prevSum += previous;
    return { dims: Array.isArray(r.dims) ? r.dims.map(String) : [], current, previous, delta: current - previous };
  });

  const absSum = raw.reduce((a, r) => a + Math.abs(r.delta), 0);

  const items: AttributionItem[] = raw.map((r) => ({
    dims: r.dims,
    current: round4(r.current),
    previous: round4(r.previous),
    delta: round4(r.delta),
    deltaPct: Math.abs(r.previous) > 1e-9 ? round2((r.delta / Math.abs(r.previous)) * 100) : null,
    contribution: absSum > 1e-9 ? round2((r.delta / absSum) * 100) : 0,
    rank: 0,
  }));

  // 按 |delta| 降序排名
  [...items]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .forEach((item, idx) => {
      item.rank = idx + 1;
    });

  const totalDelta = curSum - prevSum;
  const topPositive = items.filter((i) => i.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, topN);
  const topNegative = items.filter((i) => i.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, topN);

  return {
    items,
    total: {
      current: round4(curSum),
      previous: round4(prevSum),
      delta: round4(totalDelta),
      deltaPct: Math.abs(prevSum) > 1e-9 ? round2((totalDelta / Math.abs(prevSum)) * 100) : null,
    },
    topPositive,
    topNegative,
    diagnostics: describe(items, totalDelta, absSum),
  };
}

function describe(items: AttributionItem[], totalDelta: number, absSum: number): string[] {
  const out: string[] = [];
  out.push(`共 ${items.length} 个维度组合参与拆解，总体变化 ${totalDelta > 0 ? '+' : ''}${round4(totalDelta)}`);
  if (absSum < 1e-9) {
    out.push('各行变化量绝对值之和为 0（数据无变化），贡献占比不适用');
    return out;
  }
  const reversed = items.filter((i) => totalDelta !== 0 && Math.sign(i.delta) !== 0 && Math.sign(i.delta) !== Math.sign(totalDelta)).length;
  if (reversed > 0) {
    out.push(`存在 ${reversed} 个与总体方向相反的维度组合（整体${totalDelta > 0 ? '上升' : '下降'}中仍${totalDelta > 0 ? '下降' : '上升'}的部分）`);
  }
  const sorted = [...items].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const topAbs = Math.abs(sorted[0].delta);
  const concentration = (topAbs / absSum) * 100;
  if (concentration >= 50) {
    out.push(`变化高度集中：居首维度组合贡献了全部变化量的 ${concentration.toFixed(1)}%，建议优先排查该组合`);
  } else {
    const top3 = sorted.slice(0, 3).reduce((a, b) => a + Math.abs(b.delta), 0);
    out.push(`变化相对分散：前 3 大维度组合合计占全部变化量的 ${((top3 / absSum) * 100).toFixed(1)}%`);
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---------- 原始数据 → 两期归因行的聚合（路由与 Agent Executor 共用） ----------

export interface AggregateTwoPeriodsOptions {
  /** 维度列（可空：整表作为单行"合计"） */
  dimKey?: string;
  /** 时期列（必填） */
  periodKey: string;
  /** 指标列（必填，按维度求和） */
  metricKey: string;
}

export type AggregateTwoPeriodsOutcome =
  | { ok: true; rows: AttributionInputRow[]; periods: [string, string] }
  | { ok: false; reason: string };

/**
 * 从原始行数据聚合出最新两期的归因输入行：
 * 按时期值（字符串排序）取最新两期，按维度求和当期/对比期指标值。
 */
export function aggregateTwoPeriods(rows: Record<string, unknown>[], opts: AggregateTwoPeriodsOptions): AggregateTwoPeriodsOutcome {
  const { dimKey, periodKey, metricKey } = opts;
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: '数据为空' };
  if (!periodKey) return { ok: false, reason: '缺少时期列' };
  if (!metricKey) return { ok: false, reason: '缺少指标列' };

  const allPeriods = Array.from(
    new Set(rows.map((r) => String(r?.[periodKey] ?? '')).filter((v) => v !== '' && v !== 'null' && v !== 'undefined')),
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (allPeriods.length < 2) {
    return { ok: false, reason: `时期列仅有 ${allPeriods.length} 期取值（需至少两期）` };
  }
  const [previousPeriod, currentPeriod] = allPeriods.slice(-2);

  const grouped = new Map<string, { current: number; previous: number }>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const dimVal = dimKey ? String((r as Record<string, unknown>)[dimKey] ?? '') : '合计';
    const periodVal = String((r as Record<string, unknown>)[periodKey]);
    const metricVal = Number((r as Record<string, unknown>)[metricKey]);
    if (!dimVal || !Number.isFinite(metricVal)) continue;
    if (periodVal !== currentPeriod && periodVal !== previousPeriod) continue;
    const entry = grouped.get(dimVal) ?? { current: 0, previous: 0 };
    if (periodVal === currentPeriod) entry.current += metricVal;
    else entry.previous += metricVal;
    grouped.set(dimVal, entry);
  }
  if (grouped.size === 0) return { ok: false, reason: '最新两期无可聚合数据' };

  return {
    ok: true,
    periods: [previousPeriod, currentPeriod],
    rows: Array.from(grouped.entries()).map(([dim, v]) => ({ dims: [dim], current: v.current, previous: v.previous })),
  };
}
