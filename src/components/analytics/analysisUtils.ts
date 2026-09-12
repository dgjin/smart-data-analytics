/**
 * P1 高级分析面板共享工具：看板数据列的数值/时间样判定与默认列推断。
 * 供预测（选 x/y 列）与归因（选维度/时期/指标列）视图复用。
 */

export type DataRow = Record<string, unknown>;

/** 列的数值占比 ≥ threshold 视为数值列（空值不计入分母） */
export function isNumericColumn(rows: DataRow[], key: string, threshold = 0.8): boolean {
  let total = 0;
  let numeric = 0;
  for (const r of rows) {
    const v = r?.[key];
    if (v === null || v === undefined || v === '') continue;
    total++;
    if (Number.isFinite(Number(v))) numeric++;
  }
  return total > 0 && numeric / total >= threshold;
}

/** 列名是否含时间语义（月/日/期/季度/年/date/month/year 等） */
export function isTimeLikeColumn(key: string): boolean {
  return /月|日|期|时间|季度|年度|年|date|time|month|year|period|quarter|day/i.test(key);
}

export interface ColumnProfile {
  all: string[];
  numeric: string[];
  timeLike: string[];
  labels: string[];
}

export function profileColumns(rows: DataRow[]): ColumnProfile {
  const all: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) if (!all.includes(k)) all.push(k);
  }
  const numeric = all.filter((k) => isNumericColumn(rows, k));
  const timeLike = all.filter((k) => isTimeLikeColumn(k) && !numeric.includes(k));
  const labels = all.filter((k) => !numeric.includes(k));
  return { all, numeric, timeLike, labels };
}

/** 预测视图默认列：y = 最后一个数值列（数值列多时取末列，通常是主指标）；x = 时间样列，否则第一个非数值列 */
export function pickForecastDefaults(profile: ColumnProfile): { xKey: string; yKey: string } {
  const yKey = profile.numeric.length > 0 ? profile.numeric[profile.numeric.length - 1] : '';
  const xKey = profile.timeLike[0] ?? profile.labels[0] ?? '';
  return { xKey, yKey };
}

/** 归因视图默认列：维度 = 第一个非数值非时间列；时期 = 时间样列；指标 = 最后一个数值列 */
export function pickAttributionDefaults(profile: ColumnProfile): { dimKey: string; periodKey: string; metricKey: string } {
  const periodKey = profile.timeLike[0] ?? '';
  const dimKey = profile.labels.find((k) => k !== periodKey) ?? '';
  const metricKey = profile.numeric.length > 0 ? profile.numeric[profile.numeric.length - 1] : '';
  return { dimKey, periodKey, metricKey };
}

/** 安全读取 LLM 解读字段（Record 结构，字段缺失/类型不符返回 undefined） */
export function readStr(obj: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 安全读取字符串数组字段 */
export function readStrList(obj: Record<string, unknown> | null | undefined, key: string): string[] {
  const v = obj?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && !!x.trim());
}
