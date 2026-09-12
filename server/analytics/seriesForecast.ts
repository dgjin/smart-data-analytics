/**
 * P1-5 时序预测统计引擎（纯函数，无 IO 依赖）：
 * 三档统计模型——移动平均（含漂移修正）/ 最小二乘线性回归 / 加法季节分解，
 * auto 模式通过尾部回测（留出法）按 MAPE 择优，输出点预测 + 波动区间 + 中文诊断。
 * 说明：不做数据插值/补点，调用方负责按时间顺序传入数值序列。
 */

export type ForecastModel = 'auto' | 'ma' | 'lr' | 'seasonal';
export type ResolvedModel = Exclude<ForecastModel, 'auto'>;

export interface ForecastPoint {
  /** 距历史终点的步长（1 = 下一期） */
  step: number;
  yhat: number;
  /** 区间下界（默认 80% 置信） */
  lower: number;
  /** 区间上界（默认 80% 置信） */
  upper: number;
}

export interface ForecastFit {
  /** 平均绝对百分比误差（%，真值含 0 时跳过该点；全部无效则为 null） */
  mape: number | null;
  /** 拟合优度 R²（序列恒定等退化情形为 null） */
  r2: number | null;
  rmse: number;
}

export interface ForecastResult {
  model: ResolvedModel;
  points: ForecastPoint[];
  fit: ForecastFit;
  /** 各候选模型回测 MAPE（auto 模式择优依据，供前端展示） */
  backtest: { model: ResolvedModel; mape: number | null }[];
  /** 中文诊断说明（样本量/趋势/季节/拟合质量） */
  diagnostics: string[];
}

export interface ForecastOptions {
  /** 预测期数（1~24） */
  periods: number;
  model?: ForecastModel;
  /** 季节周期（seasonal 模型必填；auto 回测候选由内部生成） */
  seasonalPeriod?: number;
  /** 区间 z 值，默认 1.28（约 80%） */
  intervalZ?: number;
}

export const MIN_SERIES_LENGTH = 3;
export const MAX_FORECAST_PERIODS = 24;
const MA_WINDOW_MAX = 3;

interface FittedModel {
  name: ResolvedModel;
  /** 全样本拟合值（长度 = 输入长度；拟合不可得的头部位置用原值占位） */
  fitted: number[];
  /** 预测未来第 h 期（h 从 1 开始） */
  predict: (h: number) => number;
  /** 趋势斜率（每期变化量，用于诊断） */
  slope: number;
  seasonPeriod?: number;
}

/** 入口：输入历史数值序列，输出预测点与诊断；序列非法或过短抛错（调用方应先行校验并转 400） */
export function forecastSeries(values: number[], opts: ForecastOptions): ForecastResult {
  if (!Array.isArray(values) || values.length < MIN_SERIES_LENGTH) {
    throw new Error(`至少需要 ${MIN_SERIES_LENGTH} 个历史数据点`);
  }
  const series = values.map((v) => Number(v));
  if (series.some((v) => !Number.isFinite(v))) {
    throw new Error('历史序列包含非数值项');
  }
  const periods = Math.floor(opts.periods);
  if (!Number.isFinite(periods) || periods < 1 || periods > MAX_FORECAST_PERIODS) {
    throw new Error(`预测期数需为 1~${MAX_FORECAST_PERIODS} 的整数`);
  }
  const z = Number.isFinite(opts.intervalZ) && (opts.intervalZ as number) > 0 ? (opts.intervalZ as number) : 1.28;

  const requested = opts.model || 'auto';
  const { chosen, backtest } = requested === 'auto'
    ? pickByBacktest(series)
    : { chosen: fitResolved(series, requested, opts.seasonalPeriod), backtest: [] };

  const diagnostics = describe(series, chosen, chosen.name === 'seasonal' ? chosen.seasonPeriod : undefined);

  const fit = evaluateFit(series, chosen.fitted);
  // 波动区间：残差标准差 × z × sqrt(step)（步长越大不确定性越高）
  const residualStd = fit.rmse;

  const points: ForecastPoint[] = [];
  for (let h = 1; h <= periods; h++) {
    const yhat = chosen.predict(h);
    const band = z * residualStd * Math.sqrt(h);
    points.push({
      step: h,
      yhat: round4(yhat),
      lower: round4(yhat - band),
      upper: round4(yhat + band),
    });
  }
  return { model: chosen.name, points, fit, backtest, diagnostics };
}

/** 指定模型拟合（模型名已解析，非 auto） */
function fitResolved(series: number[], model: ResolvedModel, seasonalPeriod?: number): FittedModel {
  if (model === 'seasonal') {
    const p = Number.isFinite(seasonalPeriod) && (seasonalPeriod as number) >= 2 ? Math.floor(seasonalPeriod as number) : 0;
    if (p < 2 || series.length < 2 * p) {
      throw new Error(`季节模型需要至少 ${2 * (p || 2)} 个数据点与合法周期（当前周期 ${p || '未指定'}）`);
    }
    return fitSeasonal(series, p);
  }
  if (model === 'lr') return fitLinear(series);
  return fitMovingAverage(series);
}

/** auto：尾部留出回测按 MAPE 择优；候选不可用/回测无效时降级 */
function pickByBacktest(series: number[]): { chosen: FittedModel; backtest: { model: ResolvedModel; mape: number | null }[] } {
  const n = series.length;
  // 样本过短：回测不可靠，直接用移动平均
  if (n < 8) {
    return { chosen: fitMovingAverage(series), backtest: [] };
  }
  const holdout = Math.min(3, Math.max(2, Math.floor(n * 0.2)));
  const train = series.slice(0, n - holdout);
  const actual = series.slice(n - holdout);

  const candidates: { model: ResolvedModel; p?: number }[] = [{ model: 'ma' }, { model: 'lr' }];
  for (const p of [4, 12]) {
    if (train.length >= 2 * p) candidates.push({ model: 'seasonal', p });
  }

  const backtest: { model: ResolvedModel; mape: number | null }[] = [];
  let best: { model: ResolvedModel; p?: number; mape: number } | null = null;
  for (const c of candidates) {
    // 两分支均显式赋值（try 成功 / catch 置 null），无需初始值
    let mape: number | null;
    try {
      const fitted = fitResolved(train, c.model, c.p);
      mape = mapeOf(actual, Array.from({ length: holdout }, (_, i) => fitted.predict(i + 1)));
    } catch {
      mape = null;
    }
    backtest.push({ model: c.model, mape: mape === null ? null : round2(mape) });
    if (mape !== null && (best === null || mape < best.mape)) {
      best = { model: c.model, p: c.p, mape };
    }
  }
  // 回测全失败（如训练段恒定）：回退移动平均
  if (!best) return { chosen: fitMovingAverage(series), backtest };
  return { chosen: fitResolved(series, best.model, best.p), backtest };
}

// ---------- 模型实现 ----------

/** 移动平均 + 漂移修正：窗口 min(3, n/2)，外推 = 平滑末端 + 窗口内斜率 × h */
function fitMovingAverage(series: number[]): FittedModel {
  const n = series.length;
  const w = Math.max(1, Math.min(MA_WINDOW_MAX, Math.floor(n / 2)));
  const smoothed: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - w + 1);
    const window = series.slice(from, i + 1);
    smoothed.push(window.reduce((a, b) => a + b, 0) / window.length);
  }
  const last = smoothed[n - 1];
  // 漂移 = 平滑序列在最近 w 步的平均斜率（跨越期数不足时按实际间隔归一）
  const from = Math.max(0, n - 1 - w);
  const drift = (last - smoothed[from]) / Math.max(1, n - 1 - from);
  return {
    name: 'ma',
    fitted: smoothed,
    predict: (h) => last + drift * h,
    slope: drift,
  };
}

/** 最小二乘线性回归 y = a + b·x（x = 1..n） */
function fitLinear(series: number[]): FittedModel {
  const n = series.length;
  const meanX = (n + 1) / 2;
  const meanY = series.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = i + 1 - meanX;
    sxy += dx * (series[i] - meanY);
    sxx += dx * dx;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = meanY - b * meanX;
  return {
    name: 'lr',
    fitted: series.map((_, i) => a + b * (i + 1)),
    predict: (h) => a + b * (n + h),
    slope: b,
  };
}

/** 加法季节分解：居中移动平均取趋势 → 去趋势求季节增量（按相位归平均、整体均值归零）→ 趋势回归外推 + 季节增量 */
function fitSeasonal(series: number[], p: number): FittedModel {
  const n = series.length;
  const trend: (number | null)[] = new Array(n).fill(null);
  const half = Math.floor(p / 2);
  // 居中移动平均（窗口 p，仅偶数周期精确；奇数周期时会偏半格，作为近似可接受）
  for (let i = half; i < n - half; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= n) continue;
      sum += series[j];
      cnt++;
    }
    trend[i] = cnt > 0 ? sum / cnt : null;
  }
  // 季节增量：按相位聚合去趋势偏差
  const seasonalSum = new Array(p).fill(0);
  const seasonalCnt = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    if (trend[i] === null) continue;
    const phase = i % p;
    seasonalSum[phase] += series[i] - (trend[i] as number);
    seasonalCnt[phase]++;
  }
  const seasonal = seasonalSum.map((s, i) => (seasonalCnt[i] > 0 ? s / seasonalCnt[i] : 0));
  const seasonMean = seasonal.reduce((a, b) => a + b, 0) / p;
  for (let i = 0; i < p; i++) seasonal[i] -= seasonMean;
  // 趋势：对可得趋势点做线性回归（x 为原始位置 1-based）
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (trend[i] !== null) idx.push(i);
  const xs = idx.map((i) => i + 1);
  const ys = idx.map((i) => trend[i] as number);
  const { a, b } = ols(xs, ys);
  return {
    name: 'seasonal',
    fitted: series.map((_, i) => a + b * (i + 1) + seasonal[i % p]),
    predict: (h) => a + b * (n + h) + seasonal[(n + h - 1) % p],
    slope: b,
    seasonPeriod: p,
  };
}

function ols(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0 };
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    sxy += dx * (ys[i] - meanY);
    sxx += dx * dx;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: meanY - b * meanX, b };
}

// ---------- 评估与诊断 ----------

/** in-sample 拟合评估：MAPE / RMSE / R² */
export function evaluateFit(series: number[], fitted: number[]): ForecastFit {
  const n = series.length;
  let sse = 0;
  let mapeSum = 0;
  let mapeCnt = 0;
  for (let i = 0; i < n; i++) {
    const diff = series[i] - fitted[i];
    sse += diff * diff;
    if (Math.abs(series[i]) > 1e-9) {
      mapeSum += Math.abs(diff / series[i]);
      mapeCnt++;
    }
  }
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let sst = 0;
  for (let i = 0; i < n; i++) sst += (series[i] - mean) ** 2;
  return {
    mape: mapeCnt > 0 ? round2((mapeSum / mapeCnt) * 100) : null,
    r2: sst > 1e-12 ? round4(1 - sse / sst) : null,
    rmse: round4(Math.sqrt(sse / n)),
  };
}

function mapeOf(actual: number[], predicted: number[]): number | null {
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i]) > 1e-9) {
      sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
      cnt++;
    }
  }
  return cnt > 0 ? (sum / cnt) * 100 : null;
}

const MODEL_LABELS: Record<ResolvedModel, string> = {
  ma: '移动平均（含趋势修正）',
  lr: '线性回归',
  seasonal: '季节分解（趋势 + 周期）',
};

function describe(series: number[], model: FittedModel, seasonPeriod?: number): string[] {
  const out: string[] = [];
  out.push(`基于 ${series.length} 期历史，采用${MODEL_LABELS[model.name]}模型`);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const relSlope = Math.abs(mean) > 1e-9 ? (model.slope / mean) * 100 : 0;
  if (Math.abs(relSlope) < 1) out.push('整体呈平稳走势（每期变化不足均值的 1%，趋势信号弱）');
  else out.push(`整体呈${model.slope > 0 ? '上升' : '下降'}趋势（每期约 ${model.slope > 0 ? '+' : ''}${round4(model.slope)}，约占均值 ${Math.abs(relSlope).toFixed(1)}%）`);
  if (model.name === 'seasonal' && seasonPeriod) out.push(`识别到周期长度 ${seasonPeriod} 的季节性波动，预测已按相位叠加季节增量`);
  if (series.length < 8) out.push('样本量偏少（不足 8 期），预测不确定性较高，请结合业务判断');
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
