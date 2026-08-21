/**
 * 判定图表 x 轴取值是否构成时间序列（同比/环比对比的前提条件）。
 *
 * 同比/环比的基线取自「上一条 / 周期偏移条」数据行，仅当 x 轴是按时间排列的
 * 序列时该基线才有历史对比意义；机构名、产品名等分类维度下启用对比会把
 * 其他分类的值误当历史基线，产生看似真实、实则维度错配的百分比。
 *
 * 判定规则（保守取向，识别不了就不允许对比）：
 * - 全部非空样本均可解析为时间表达：年 / 年月 / 年月日 / 年季 / 中文年月日 / 裸月 / 裸季度 / Date；
 *   数字仅当落在 1900–2100 视为年份，其余数字（编号、金额等）不算时间；
 * - 解析出的时间戳整体单调（升序或降序，允许相邻相等），乱序序列的偏移基线会错位。
 */

const YEAR_RE = /^(19|20)\d{2}$/;
const YM_RE = /^(19|20)\d{2}[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/;
const CN_DATE_RE = /^(19|20)\d{2}年(?:(\d{1,2})月)?(?:(\d{1,2})日)?$/;
const QUARTER_RE = /^(19|20)\d{2}\s*[Qq]([1-4])$/;
const QUARTER_CN_RE = /^(19|20)\d{2}年?第([1-4])季度$/;
const MONTH_BARE_RE = /^(\d{1,2})月$/;
const QUARTER_BARE_RE = /^第([1-4])季度$/;

/** 将单个取值解析为时间戳；无法识别为时间表达时返回 null。裸月/裸季度以 2000 年为虚拟年份保序。 */
function parseTemporalValue(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();

  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  if (!s) return null;

  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    // 纯数字仅当年份对待；20240313 这类紧凑日期或编号、金额一律不算（保守）
    if (Number.isInteger(num) && num >= 1900 && num <= 2100) return Date.UTC(num, 0);
    return null;
  }

  let m = s.match(YM_RE);
  if (m) return Date.UTC(Number(s.slice(0, 4)), Number(m[1]) - 1, m[2] ? Number(m[2]) : 1);

  m = s.match(CN_DATE_RE);
  if (m) return Date.UTC(Number(s.slice(0, 4)), m[1] ? Number(m[1]) - 1 : 0, m[2] ? Number(m[2]) : 1);

  m = s.match(QUARTER_RE);
  if (m) return Date.UTC(Number(s.slice(0, 4)), (Number(m[1]) - 1) * 3);

  m = s.match(QUARTER_CN_RE);
  if (m) return Date.UTC(Number(s.slice(0, 4)), (Number(m[1]) - 1) * 3);

  m = s.match(MONTH_BARE_RE);
  if (m) return Date.UTC(2000, Number(m[1]) - 1);

  m = s.match(QUARTER_BARE_RE);
  if (m) return Date.UTC(2000, (Number(m[1]) - 1) * 3);

  return null;
}

/** x 轴取值列表是否构成（按序排列的）时间序列。 */
export function detectTemporalAxis(values: unknown[]): boolean {
  const samples = (values || []).filter(
    (v) => v !== null && v !== undefined && String(v).trim() !== ''
  );
  if (samples.length < 2) return false;

  const ts = samples.map(parseTemporalValue);
  // 存在任一不可解析样本（机构名、「合计」行等）即视为非时间轴
  if (ts.some((t) => t === null)) return false;

  let nonDecreasing = true;
  let nonIncreasing = true;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i]! < ts[i - 1]!) nonDecreasing = false;
    if (ts[i]! > ts[i - 1]!) nonIncreasing = false;
  }
  return nonDecreasing || nonIncreasing;
}
