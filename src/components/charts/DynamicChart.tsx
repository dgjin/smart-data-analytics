import React, { useState, useEffect, useRef } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Brush,
  LabelList,
} from 'recharts';
import { ChartConfig } from '../../types/analytics';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sliders,
  MoveHorizontal,
  Palette,
  Sparkles,
  Printer,
  Percent,
  GitCompare,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { CHART_THEMES, getAutoOptimizedColors, ChartTheme } from '../../utils/chartThemes';

export type ComparisonMode = 'none' | 'yoy' | 'mom';

interface DynamicChartProps {
  config: ChartConfig;
  data: Record<string, any>[];
  height?: number;
  globalThemeId?: string;
  autoOptimizeContrast?: boolean;
  comparisonMode?: ComparisonMode;
  showDiffBadges?: boolean;
}

export const DynamicChart: React.FC<DynamicChartProps> = ({
  config,
  data,
  height = 320,
  globalThemeId = 'cyber',
  autoOptimizeContrast = true,
  comparisonMode = 'none',
  showDiffBadges = true,
}) => {
  const [startIndex, setStartIndex] = useState<number>(0);
  const [endIndex, setEndIndex] = useState<number>(Math.max(0, (data?.length || 1) - 1));
  const [showBrush, setShowBrush] = useState<boolean>(true);
  const [activeThemeId, setActiveThemeId] = useState<string>(globalThemeId);
  const [isAutoContrast, setIsAutoContrast] = useState<boolean>(autoOptimizeContrast);
  const [showThemePicker, setShowThemePicker] = useState<boolean>(false);
  const [activeComparisonMode, setActiveComparisonMode] = useState<ComparisonMode>(comparisonMode);
  const [isDiffBadgeVisible, setIsDiffBadgeVisible] = useState<boolean>(showDiffBadges);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveThemeId(globalThemeId);
  }, [globalThemeId]);

  useEffect(() => {
    setActiveComparisonMode(comparisonMode);
  }, [comparisonMode]);

  useEffect(() => {
    setIsDiffBadgeVisible(showDiffBadges);
  }, [showDiffBadges]);

  useEffect(() => {
    if (data && data.length > 0) {
      setStartIndex(0);
      setEndIndex(data.length - 1);
    }
  }, [data]);

  // Reset comparison mode when the dataset no longer supports it
  useEffect(() => {
    const len = data?.length || 0;
    const momOk = len >= 3;
    const yoyOk = len > (len >= 13 ? 12 : 4);
    if (activeComparisonMode === 'mom' && !momOk) setActiveComparisonMode('none');
    if (activeComparisonMode === 'yoy' && !yoyOk) setActiveComparisonMode('none');
  }, [data, activeComparisonMode]);

  const isCartesian = ['line', 'bar', 'area'].includes(config.type);
  const dataLen = data?.length || 0;

  const handleZoomIn = () => {
    if (!isCartesian || dataLen <= 2) return;
    const range = endIndex - startIndex;
    if (range <= 1) return;
    const step = Math.max(1, Math.floor(range * 0.2));
    setStartIndex((prev) => Math.min(prev + step, endIndex - 1));
    setEndIndex((prev) => Math.max(prev - step, startIndex + 1));
  };

  const handleZoomOut = () => {
    if (!isCartesian) return;
    const range = endIndex - startIndex;
    const step = Math.max(1, Math.floor((dataLen - range) * 0.2) || 2);
    setStartIndex((prev) => Math.max(0, prev - step));
    setEndIndex((prev) => Math.min(dataLen - 1, prev + step));
  };

  const handleResetZoom = () => {
    setStartIndex(0);
    setEndIndex(dataLen - 1);
  };

  // Mouse wheel zoom — attached natively with passive:false so preventDefault works
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isCartesian || dataLen <= 3) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        handleZoomIn();
      } else if (e.deltaY > 0) {
        handleZoomOut();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCartesian, dataLen, startIndex, endIndex]);

  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-slate-400 text-xs bg-slate-900/40 border border-slate-800 rounded-xl"
        style={{ height }}
      >
        暂无数据图表，请输入查询指令
      </div>
    );
  }

  const { type, xAxisKey, yAxisKeys, stacked } = config;

  // Compute colors based on active theme & auto contrast setting
  const activeTheme: ChartTheme = CHART_THEMES[activeThemeId] || CHART_THEMES.cyber;
  const { colors: effectiveColors, explanation: autoContrastNote } = isAutoContrast
    ? getAutoOptimizedColors(data, yAxisKeys, activeThemeId)
    : { colors: activeTheme.colors, explanation: `已使用固定【${activeTheme.name}】配色` };

  const gridColor = activeTheme.gridColor || '#334155';
  const textColor = activeTheme.textColor || '#94a3b8';

  // Filtered data based on zoom window
  const visibleData = isCartesian && data.length > 1
    ? data.slice(startIndex, endIndex + 1)
    : data;

  // YoY / MoM comparison availability — never fabricate baselines.
  // MoM needs at least 3 points; YoY needs a full prior cycle (offset 4 or 12).
  const yoyOffset = data.length >= 13 ? 12 : 4;
  const canCompareMom = data.length >= 3;
  const canCompareYoy = data.length > yoyOffset;

  // Calculate YoY / MoM comparison baselines & difference percentages.
  // Points without a real historical baseline are left undefined (no fabricated data).
  const processComparisonData = (rawData: Record<string, any>[], mode: ComparisonMode) => {
    if (!rawData || rawData.length === 0 || mode === 'none') {
      return rawData;
    }

    return rawData.map((item, idx) => {
      const newItem = { ...item };

      yAxisKeys.forEach((key) => {
        const currVal = Number(item[key]);
        if (isNaN(currVal)) return;

        let priorVal: number | undefined;
        if (mode === 'mom') {
          if (idx > 0 && rawData[idx - 1][key] !== undefined) {
            priorVal = Number(rawData[idx - 1][key]) || 0;
          }
        } else if (mode === 'yoy') {
          if (idx >= yoyOffset && rawData[idx - yoyOffset][key] !== undefined) {
            priorVal = Number(rawData[idx - yoyOffset][key]) || 0;
          }
        }

        if (priorVal === undefined) return;

        const diffPct = priorVal ? Math.round(((currVal - priorVal) / priorVal) * 1000) / 10 : 0;

        newItem[`${key}_prior`] = priorVal;
        newItem[`${key}_diff_pct`] = diffPct;
      });

      return newItem;
    });
  };

  const chartData = processComparisonData(visibleData, activeComparisonMode);

  // Format large number in tooltip/axis
  const formatValue = (val: any) => {
    if (typeof val === 'number') {
      if (Math.abs(val) >= 1000000) return `¥${(val / 1000000).toFixed(1)}M`;
      if (Math.abs(val) >= 10000) return `${(val / 10000).toFixed(1)}万`;
      return val.toLocaleString();
    }
    return val;
  };

  // Custom Badge Renderer for Difference Percentages
  const renderDiffBadge = (props: any) => {
    const { x, y, value, width } = props;
    if (value === undefined || value === null || !isDiffBadgeVisible) return null;
    const numVal = Number(value);
    if (isNaN(numVal)) return null;

    const isPositive = numVal >= 0;
    const text = `${isPositive ? '+' : ''}${numVal}%`;
    const centerX = width ? x + width / 2 : x;
    const posY = y - 14;

    return (
      <g transform={`translate(${centerX},${posY})`}>
        <rect
          x="-22"
          y="-11"
          width="44"
          height="16"
          rx="5"
          fill={isPositive ? '#064e3b' : '#881337'}
          stroke={isPositive ? '#10b981' : '#f43f5e'}
          strokeWidth="1"
          opacity="0.95"
        />
        <text
          x="0"
          y="0"
          fill={isPositive ? '#34d399' : '#fb7185'}
          fontSize="10"
          fontWeight="bold"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {text}
        </text>
      </g>
    );
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-slate-900/95 border border-slate-700/80 p-3 rounded-xl shadow-xl text-xs space-y-1.5 z-50 min-w-[180px]">
          <div className="font-semibold text-slate-200 border-b border-slate-800 pb-1 flex items-center justify-between">
            <span>{label || '维度指标'}</span>
            {activeComparisonMode !== 'none' && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold">
                {activeComparisonMode === 'yoy' ? '同比 (YoY) 对比' : '环比 (MoM) 对比'}
              </span>
            )}
          </div>
          {payload.map((entry: any, index: number) => {
            if (entry.dataKey && String(entry.dataKey).endsWith('_diff_pct')) return null;
            return (
              <div key={index} className="flex items-center justify-between space-x-4">
                <span className="flex items-center space-x-1.5" style={{ color: entry.color }}>
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-slate-300 font-medium">{entry.name}:</span>
                </span>
                <span className="font-bold text-slate-100">{formatValue(entry.value)}</span>
              </div>
            );
          })}

          {/* Display comparison diff percentage inside Tooltip */}
          {activeComparisonMode !== 'none' && payload[0]?.payload && yAxisKeys.length > 0 && (
            <div className="border-t border-slate-800 pt-1.5 space-y-1">
              {yAxisKeys.map((key) => {
                const diffVal = payload[0].payload[`${key}_diff_pct`];
                if (diffVal === undefined) return null;
                const isPositive = diffVal >= 0;
                const keyName = config.yAxisNames?.[key] || key;
                return (
                  <div key={key} className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">{keyName} {activeComparisonMode === 'yoy' ? '同比' : '环比'}差异:</span>
                    <span className={`font-bold font-mono px-1.5 py-0.2 rounded flex items-center space-x-0.5 ${
                      isPositive ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    }`}>
                      <span>{isPositive ? '↑ +' : '↓ '}{diffVal}%</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  const isZoomed = isCartesian && (startIndex > 0 || endIndex < data.length - 1);

  const renderChart = () => {
    switch (type) {
      case 'line':
        return (
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.5} />
            <XAxis dataKey={xAxisKey} stroke={textColor} fontSize={12} tickLine={false} />
            <YAxis stroke={textColor} fontSize={12} tickFormatter={formatValue} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
            {yAxisKeys.map((key, i) => {
              const color = effectiveColors[i % effectiveColors.length];
              const keyName = config.yAxisNames?.[key] || key;
              return (
                <React.Fragment key={key}>
                  <Line
                    type="monotone"
                    dataKey={key}
                    name={keyName}
                    stroke={color}
                    strokeWidth={3}
                    dot={{ r: 4, fill: color }}
                    activeDot={{ r: 7 }}
                  >
                    {isDiffBadgeVisible && activeComparisonMode !== 'none' && i === 0 && (
                      <LabelList dataKey={`${key}_diff_pct`} content={renderDiffBadge} />
                    )}
                  </Line>
                  {activeComparisonMode !== 'none' && (
                    <Line
                      type="monotone"
                      dataKey={`${key}_prior`}
                      name={`${keyName} (${activeComparisonMode === 'yoy' ? '去年同期' : '上期基准'})`}
                      stroke={color}
                      strokeDasharray="4 4"
                      strokeWidth={2}
                      opacity={0.6}
                      dot={{ r: 3, fill: color, fillOpacity: 0.5 }}
                    />
                  )}
                </React.Fragment>
              );
            })}
            {showBrush && data.length > 5 && (
              <Brush
                dataKey={xAxisKey}
                height={22}
                stroke={effectiveColors[0]}
                fill="#0f172a"
                tickFormatter={() => ''}
                startIndex={startIndex}
                endIndex={endIndex}
                onChange={(range) => {
                  if (range && typeof range.startIndex === 'number' && typeof range.endIndex === 'number') {
                    setStartIndex(range.startIndex);
                    setEndIndex(range.endIndex);
                  }
                }}
              />
            )}
          </LineChart>
        );

      case 'area':
        return (
          <AreaChart data={chartData}>
            <defs>
              {yAxisKeys.map((key, i) => {
                const color = effectiveColors[i % effectiveColors.length];
                return (
                  <linearGradient key={key} id={`color-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={color} stopOpacity={0.05} />
                  </linearGradient>
                );
              })}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.5} />
            <XAxis dataKey={xAxisKey} stroke={textColor} fontSize={12} tickLine={false} />
            <YAxis stroke={textColor} fontSize={12} tickFormatter={formatValue} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
            {yAxisKeys.map((key, i) => {
              const color = effectiveColors[i % effectiveColors.length];
              const keyName = config.yAxisNames?.[key] || key;
              return (
                <React.Fragment key={key}>
                  <Area
                    type="monotone"
                    dataKey={key}
                    name={keyName}
                    stroke={color}
                    strokeWidth={2}
                    fillOpacity={1}
                    fill={`url(#color-${key})`}
                    stackId={stacked ? '1' : undefined}
                  >
                    {isDiffBadgeVisible && activeComparisonMode !== 'none' && i === 0 && (
                      <LabelList dataKey={`${key}_diff_pct`} content={renderDiffBadge} />
                    )}
                  </Area>
                  {activeComparisonMode !== 'none' && (
                    <Area
                      type="monotone"
                      dataKey={`${key}_prior`}
                      name={`${keyName} (${activeComparisonMode === 'yoy' ? '去年同期' : '上期基准'})`}
                      stroke={color}
                      strokeDasharray="4 4"
                      strokeWidth={1.5}
                      fillOpacity={0.15}
                      fill={color}
                    />
                  )}
                </React.Fragment>
              );
            })}
            {showBrush && data.length > 5 && (
              <Brush
                dataKey={xAxisKey}
                height={22}
                stroke={effectiveColors[0]}
                fill="#0f172a"
                tickFormatter={() => ''}
                startIndex={startIndex}
                endIndex={endIndex}
                onChange={(range) => {
                  if (range && typeof range.startIndex === 'number' && typeof range.endIndex === 'number') {
                    setStartIndex(range.startIndex);
                    setEndIndex(range.endIndex);
                  }
                }}
              />
            )}
          </AreaChart>
        );

      case 'pie':
      case 'donut': {
        const pieValueKey = yAxisKeys[0] || 'value';
        return (
          <PieChart>
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Pie
              data={data}
              dataKey={pieValueKey}
              nameKey={xAxisKey}
              cx="50%"
              cy="50%"
              innerRadius={type === 'donut' ? 60 : 0}
              outerRadius={95}
              paddingAngle={3}
              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={effectiveColors[index % effectiveColors.length]} />
              ))}
            </Pie>
          </PieChart>
        );
      }

      case 'radar':
        return (
          <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
            <PolarGrid stroke={gridColor} />
            <PolarAngleAxis dataKey={xAxisKey} stroke={textColor} fontSize={11} />
            <PolarRadiusAxis stroke={textColor} fontSize={10} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {yAxisKeys.map((key, i) => (
              <Radar
                key={key}
                name={config.yAxisNames?.[key] || key}
                dataKey={key}
                stroke={effectiveColors[i % effectiveColors.length]}
                fill={effectiveColors[i % effectiveColors.length]}
                fillOpacity={0.4}
              />
            ))}
          </RadarChart>
        );

      case 'bar':
      default:
        return (
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.5} />
            <XAxis dataKey={xAxisKey} stroke={textColor} fontSize={12} tickLine={false} />
            <YAxis stroke={textColor} fontSize={12} tickFormatter={formatValue} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
            {yAxisKeys.map((key, i) => {
              const color = effectiveColors[i % effectiveColors.length];
              const keyName = config.yAxisNames?.[key] || key;
              return (
                <React.Fragment key={key}>
                  <Bar
                    dataKey={key}
                    name={keyName}
                    fill={color}
                    radius={[6, 6, 0, 0]}
                    stackId={stacked ? '1' : undefined}
                  >
                    {isDiffBadgeVisible && activeComparisonMode !== 'none' && i === 0 && (
                      <LabelList dataKey={`${key}_diff_pct`} content={renderDiffBadge} />
                    )}
                  </Bar>
                  {activeComparisonMode !== 'none' && (
                    <Bar
                      dataKey={`${key}_prior`}
                      name={`${keyName} (${activeComparisonMode === 'yoy' ? '去年同期' : '上期基准'})`}
                      fill={color}
                      opacity={0.35}
                      radius={[4, 4, 0, 0]}
                    />
                  )}
                </React.Fragment>
              );
            })}
            {showBrush && data.length > 5 && (
              <Brush
                dataKey={xAxisKey}
                height={22}
                stroke={effectiveColors[0]}
                fill="#0f172a"
                tickFormatter={() => ''}
                startIndex={startIndex}
                endIndex={endIndex}
                onChange={(range) => {
                  if (range && typeof range.startIndex === 'number' && typeof range.endIndex === 'number') {
                    setStartIndex(range.startIndex);
                    setEndIndex(range.endIndex);
                  }
                }}
              />
            )}
          </BarChart>
        );
    }
  };

  return (
    <div className="w-full relative group space-y-1" style={{ height }}>
      {/* Interactive Toolbar with Color Scheme Switcher, YoY/MoM Comparison Toggle & Zoom */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between text-[11px] text-slate-400 px-1 py-0.5 gap-1.5">
        <div className="flex items-center space-x-2 truncate flex-wrap gap-y-1">
          {isCartesian && data.length > 2 && (
            <span className="flex items-center space-x-1 text-[10px] text-indigo-400 font-mono">
              <MoveHorizontal className="w-3 h-3" />
              <span>
                视角: {startIndex + 1} - {endIndex + 1} / {data.length} 条
              </span>
            </span>
          )}

          {activeComparisonMode !== 'none' && (
            <span className="text-[10px] text-slate-500">
              仅基于真实历史数据对比，无历史基线的节点不参与计算
            </span>
          )}

          {/* Active Palette Preview Indicator */}
          <div className="flex items-center space-x-1 border border-slate-800 bg-slate-900 px-2 py-0.5 rounded-lg shrink-0">
            <div className="flex items-center space-x-0.5">
              {effectiveColors.slice(0, 4).map((c, i) => (
                <span
                  key={i}
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <span className="text-[10px] text-slate-300 font-medium ml-1">
              {activeTheme.name.split(' ')[0]}
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-1.5 relative shrink-0 flex-wrap gap-y-1">
          {/* YoY / MoM Analysis Toggle Buttons */}
          {isCartesian && (
            <div className="flex items-center bg-slate-900 border border-slate-800 p-0.5 rounded-lg">
              <button
                type="button"
                onClick={() => setActiveComparisonMode('none')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                  activeComparisonMode === 'none'
                    ? 'bg-slate-800 text-slate-200 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                原值
              </button>
              <button
                type="button"
                onClick={() => setActiveComparisonMode('yoy')}
                disabled={!canCompareYoy}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all flex items-center space-x-0.5 ${
                  activeComparisonMode === 'yoy'
                    ? 'bg-indigo-600/40 text-indigo-200 border border-indigo-500/50 shadow-sm'
                    : canCompareYoy
                      ? 'text-slate-400 hover:text-indigo-300'
                      : 'text-slate-600 cursor-not-allowed opacity-50'
                }`}
                title={canCompareYoy ? '同比 Year-over-Year (与去年同期对比)' : '数据点不足，无法计算同比'}
              >
                <GitCompare className="w-3 h-3 text-indigo-400" />
                <span>同比 YoY</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveComparisonMode('mom')}
                disabled={!canCompareMom}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all flex items-center space-x-0.5 ${
                  activeComparisonMode === 'mom'
                    ? 'bg-cyan-600/40 text-cyan-200 border border-cyan-500/50 shadow-sm'
                    : canCompareMom
                      ? 'text-slate-400 hover:text-cyan-300'
                      : 'text-slate-600 cursor-not-allowed opacity-50'
                }`}
                title={canCompareMom ? '环比 Month-over-Month (与上期值对比)' : '数据点不足，无法计算环比'}
              >
                <TrendingUp className="w-3 h-3 text-cyan-400" />
                <span>环比 MoM</span>
              </button>
            </div>
          )}

          {/* Toggle Difference Percentage Badges */}
          {activeComparisonMode !== 'none' && (
            <button
              type="button"
              onClick={() => setIsDiffBadgeVisible(!isDiffBadgeVisible)}
              className={`px-2 py-1 rounded-lg border text-[10px] font-bold flex items-center space-x-1 transition-all ${
                isDiffBadgeVisible
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300'
              }`}
              title="一键开启或隐藏图表差异百分比标记"
            >
              <Percent className="w-3 h-3 text-emerald-400" />
              <span>{isDiffBadgeVisible ? '差异标记 ON' : '标记 OFF'}</span>
            </button>
          )}

          {/* Theme Palette Picker Button */}
          <div className="relative">
            <button
              onClick={() => setShowThemePicker(!showThemePicker)}
              className="p-1 px-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-indigo-500/50 text-slate-200 hover:text-indigo-300 flex items-center space-x-1 text-[10px] font-bold transition-all"
              title="切换图表配色方案"
            >
              <Palette className="w-3.5 h-3.5 text-indigo-400" />
              <span>智能配色</span>
            </button>

            {/* Theme Picker Dropdown Popover */}
            {showThemePicker && (
              <div className="absolute right-0 top-7 z-50 w-64 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-3 space-y-2.5 text-xs">
                <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                  <span className="font-bold text-slate-200 flex items-center space-x-1">
                    <Palette className="w-3.5 h-3.5 text-indigo-400" />
                    <span>图表配色方案与高对比度设置</span>
                  </span>
                  <button
                    onClick={() => setShowThemePicker(false)}
                    className="text-slate-500 hover:text-slate-300"
                  >
                    ✕
                  </button>
                </div>

                {/* Auto Contrast Toggle */}
                <div className="p-2 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-indigo-300 text-[11px] flex items-center space-x-1">
                      <Sparkles className="w-3 h-3 text-cyan-400" />
                      <span>数据属性智能对比度优化</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={isAutoContrast}
                      onChange={(e) => setIsAutoContrast(e.target.checked)}
                      className="rounded accent-indigo-500"
                    />
                  </div>
                  <p className="text-[10px] text-slate-400 leading-tight">
                    {autoContrastNote}
                  </p>
                </div>

                {/* Theme Options */}
                <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                  {Object.values(CHART_THEMES).map((theme) => {
                    const isSelected = activeThemeId === theme.id;
                    return (
                      <button
                        key={theme.id}
                        onClick={() => {
                          setActiveThemeId(theme.id);
                          setShowThemePicker(false);
                        }}
                        className={`w-full p-2 rounded-xl text-left border text-[11px] flex items-center justify-between transition-all ${
                          isSelected
                            ? 'bg-indigo-600/20 border-indigo-500 text-indigo-200 font-bold'
                            : 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-300'
                        }`}
                      >
                        <div className="space-y-0.5 truncate">
                          <div className="font-bold truncate">{theme.name}</div>
                          <div className="text-[9px] text-slate-400 truncate">{theme.description}</div>
                        </div>

                        {/* Color Swatch */}
                        <div className="flex items-center space-x-0.5 shrink-0 ml-2">
                          {theme.colors.slice(0, 4).map((c, idx) => (
                            <span
                              key={idx}
                              className="w-2.5 h-2.5 rounded-full inline-block border border-slate-900"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Zoom controls */}
          {isCartesian && data.length > 2 && (
            <div className="flex items-center space-x-1 bg-slate-900 border border-slate-800 p-1 rounded-lg">
              <button
                onClick={handleZoomIn}
                className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-indigo-400"
                title="放大"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleZoomOut}
                className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-indigo-400"
                title="缩小"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              {isZoomed && (
                <button
                  onClick={handleResetZoom}
                  className="p-1 hover:bg-slate-800 rounded text-indigo-400 hover:text-indigo-300 flex items-center space-x-0.5"
                  title="重置"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main Chart Container */}
      <div
        ref={containerRef}
        className="w-full h-full"
      >
        <ResponsiveContainer width="100%" height="90%">
          {renderChart()}
        </ResponsiveContainer>
      </div>
    </div>
  );
};

