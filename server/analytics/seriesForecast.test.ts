import { describe, expect, it } from 'vitest';
import { forecastSeries, evaluateFit, MIN_SERIES_LENGTH } from './seriesForecast';

/** 生成 y = intercept + slope*i + amplitude*sin(2πi/period) 的合成序列 */
function synth(n: number, intercept: number, slope: number, amplitude = 0, period = 4): number[] {
  return Array.from({ length: n }, (_, i) =>
    intercept + slope * i + (amplitude === 0 ? 0 : amplitude * Math.sin((2 * Math.PI * i) / period)),
  );
}

describe('seriesForecast: 时序预测统计引擎', () => {
  it('完美线性序列：auto 选线性回归，外推精确', () => {
    const series = Array.from({ length: 10 }, (_, i) => 2 * i + 1); // 1,3,...,19
    const r = forecastSeries(series, { periods: 3 });
    expect(r.model).toBe('lr');
    expect(r.points.map((p) => p.yhat)).toEqual([21, 23, 25]);
    expect(r.fit.r2).toBeCloseTo(1, 6);
    expect(r.fit.rmse).toBeCloseTo(0, 9);
    // 线性完美拟合残差为 0：区间退化为点预测
    expect(r.points[0].lower).toBeCloseTo(21, 6);
    expect(r.points[0].upper).toBeCloseTo(21, 6);
  });

  it('常数序列：预测保持常数，区间宽度为 0，诊断提示平稳', () => {
    const r = forecastSeries([5, 5, 5, 5, 5], { periods: 2 });
    expect(r.model).toBe('ma');
    expect(r.points.map((p) => p.yhat)).toEqual([5, 5]);
    expect(r.points[0].upper - r.points[0].lower).toBe(0);
    expect(r.diagnostics.join('')).toContain('平稳');
  });

  it('移动平均含漂移修正：线性序列短期外推延续趋势', () => {
    const r = forecastSeries([1, 2, 3, 4, 5], { periods: 2, model: 'ma' });
    expect(r.points[0].yhat).toBeCloseTo(5.5, 6);
    expect(r.points[1].yhat).toBeCloseTo(6.5, 6);
  });

  it('季节序列：auto 选季节分解，预测贴合真实相位', () => {
    const n = 24;
    const series = synth(n, 10, 0.5, 3, 4);
    const r = forecastSeries(series, { periods: 4 });
    expect(r.model).toBe('seasonal');
    const actual = [24, 25, 26, 27].map((i) => 10 + 0.5 * i + 3 * Math.sin((2 * Math.PI * i) / 4));
    r.points.forEach((p, idx) => {
      expect(Math.abs(p.yhat - actual[idx])).toBeLessThan(1.5);
    });
  });

  it('auto 回测返回候选模型 MAPE 列表（样本充足时）', () => {
    const r = forecastSeries(synth(24, 10, 0.5, 3, 4), { periods: 2 });
    expect(r.backtest.length).toBeGreaterThanOrEqual(2);
    expect(r.backtest.some((b) => b.model === 'seasonal')).toBe(true);
    expect(r.backtest.every((b) => b.mape === null || b.mape >= 0)).toBe(true);
  });

  it('预测区间随步长扩大', () => {
    // 带噪声的上升序列：残差 > 0，区间应逐步张开
    const series = [10, 12, 9, 13, 11, 14, 12, 15, 13, 16, 14, 17];
    const r = forecastSeries(series, { periods: 3, model: 'lr' });
    const w0 = r.points[0].upper - r.points[0].lower;
    const w2 = r.points[2].upper - r.points[2].lower;
    expect(w2).toBeGreaterThan(w0);
  });

  it('样本过短（<8）跳过回测直接用移动平均', () => {
    const r = forecastSeries([3, 4, 5, 6, 7], { periods: 1 });
    expect(r.model).toBe('ma');
    expect(r.backtest).toEqual([]);
    expect(r.diagnostics.join('')).toContain('样本量偏少');
  });

  it('参数与序列校验：过短/非数值/期数越界均抛错', () => {
    expect(() => forecastSeries([1, 2], { periods: 1 })).toThrow(`至少需要 ${MIN_SERIES_LENGTH}`);
    expect(() => forecastSeries([1, 2, Number.NaN], { periods: 1 })).toThrow('非数值');
    expect(() => forecastSeries([1, 2, 3], { periods: 0 })).toThrow('预测期数');
    expect(() => forecastSeries([1, 2, 3], { periods: 99 })).toThrow('预测期数');
    expect(() => forecastSeries([1, 2, 3], { periods: 1, model: 'seasonal', seasonalPeriod: 4 })).toThrow('季节模型');
  });

  it('evaluateFit：完美拟合 R²=1、RMSE=0、MAPE=0', () => {
    const series = [1, 2, 3];
    const fit = evaluateFit(series, series);
    expect(fit.r2).toBe(1);
    expect(fit.rmse).toBe(0);
    expect(fit.mape).toBe(0);
  });

  it('evaluateFit：恒定序列 R² 为 null（无总方差）', () => {
    const fit = evaluateFit([5, 5, 5], [5, 5, 5]);
    expect(fit.r2).toBeNull();
  });
});
