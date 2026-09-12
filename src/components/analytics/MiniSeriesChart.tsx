import React from 'react';

/**
 * P1-5 预测视图迷你趋势图（SVG 自绘，不引入图表库）：
 * 历史实测线 + 预测虚线段 + 置信区间带（上界/下界闭合填充）。
 */

export interface MiniForecastPoint {
  step: number;
  yhat: number;
  lower: number;
  upper: number;
}

interface MiniSeriesChartProps {
  history: number[];
  points: MiniForecastPoint[];
  height?: number;
}

const W = 640;
const PAD_X = 44;
const PAD_Y = 16;

export const MiniSeriesChart: React.FC<MiniSeriesChartProps> = ({ history, points, height = 180 }) => {
  const H = height;
  const yc = H - 26;
  const n = history.length + points.length;
  if (n < 2) return null;

  const allValues = [...history, ...points.flatMap((p) => [p.lower, p.upper])];
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = max - min || Math.abs(max) || 1;
  const yMin = min - span * 0.08;
  const yMax = max + span * 0.08;

  const xAt = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / (n - 1);
  const yAt = (v: number) => PAD_Y + ((yMax - v) / (yMax - yMin)) * (yc - PAD_Y);

  const histPts = history.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  // 预测线从历史末端接续（视觉连续）
  const forecastPts = [history[history.length - 1], ...points.map((p) => p.yhat)]
    .map((v, i) => `${xAt(history.length - 1 + i).toFixed(1)},${yAt(v).toFixed(1)}`)
    .join(' ');
  // 区间带：上界正序 + 下界倒序闭合
  const bandTop = points.map((p, i) => `${xAt(history.length + i).toFixed(1)},${yAt(p.upper).toFixed(1)}`);
  const bandBottom = [...points]
    .reverse()
    .map((p, i) => `${xAt(n - 1 - i).toFixed(1)},${yAt(p.lower).toFixed(1)}`);
  const bandPath = `M${xAt(history.length - 1).toFixed(1)},${yAt(history[history.length - 1]).toFixed(1)} ` +
    bandTop.map((p) => `L${p}`).join(' ') +
    ' ' +
    bandBottom.map((p) => `L${p}`).join(' ') +
    ' Z';

  // y 轴网格：min / mid / max 三档
  const gridValues = [yMax, (yMax + yMin) / 2, yMin];
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="时序预测趋势图">
      {/* 网格与 y 轴标签 */}
      {gridValues.map((v, i) => (
        <g key={i}>
          <line x1={PAD_X} y1={yAt(v)} x2={W - PAD_X} y2={yAt(v)} stroke="#334155" strokeWidth="0.6" strokeDasharray="4 4" />
          <text x={PAD_X - 6} y={yAt(v) + 3} textAnchor="end" fontSize="9" fill="#64748b">
            {fmt(v)}
          </text>
        </g>
      ))}
      {/* 历史/预测分隔线 */}
      <line
        x1={xAt(history.length - 1)}
        y1={PAD_Y}
        x2={xAt(history.length - 1)}
        y2={yc}
        stroke="#8b5cf6"
        strokeWidth="0.8"
        strokeDasharray="3 3"
        opacity="0.6"
      />
      {/* 区间带 */}
      <path d={bandPath} fill="#8b5cf6" opacity="0.14" />
      {/* 历史线 */}
      <polyline points={histPts} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinejoin="round" />
      {/* 预测线（虚线） */}
      <polyline points={forecastPts} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" />
      {/* 历史末点 */}
      <circle cx={xAt(history.length - 1)} cy={yAt(history[history.length - 1])} r="2.6" fill="#38bdf8" />
      {/* 预测点 */}
      {points.map((p, i) => (
        <circle key={p.step} cx={xAt(history.length + i)} cy={yAt(p.yhat)} r="2.6" fill="#8b5cf6" />
      ))}
      {/* 图例 */}
      <g fontSize="9">
        <line x1={W - 210} y1={10} x2={W - 192} y2={10} stroke="#38bdf8" strokeWidth="2" />
        <text x={W - 188} y={13} fill="#94a3b8">历史</text>
        <line x1={W - 150} y1={10} x2={W - 132} y2={10} stroke="#8b5cf6" strokeWidth="2" strokeDasharray="4 3" />
        <text x={W - 128} y={13} fill="#94a3b8">预测</text>
        <rect x={W - 90} y={5} width="14" height="9" fill="#8b5cf6" opacity="0.25" />
        <text x={W - 72} y={13} fill="#94a3b8">80% 区间</text>
      </g>
    </svg>
  );
};
