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
  ScatterChart,
  Scatter,
  Treemap,
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
import { detectTemporalAxis } from '../../utils/temporalAxis';

export type ComparisonMode = 'none' | 'yoy' | 'mom';

interface DynamicChartProps {
  config: ChartConfig;
  data: Record<string, any>[];
  height?: number;
  globalThemeId?: string;
  autoOptimizeContrast?: boolean;
  comparisonMode?: ComparisonMode;
  showDiffBadges?: boolean;
  /** P2-2 点击下钻：点击图表维度时回调（维度键、维度值） */
  onDrill?: (dimensionKey: string, dimensionValue: string | number) => void;
  /** 是否允许下钻（仅 Cartesian 图表有效） */
  drillable?: boolean;
}

export const DynamicChart: React.FC<DynamicChartProps> = ({
  config,
  data,
  height = 320,
  globalThemeId = 'cyber',
  autoOptimizeContrast = true,
  comparisonMode = 'none',
  showDiffBadges = true,
  onDrill,
  drillable = false,
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
    // 仅时间序列 x 轴允许同/环比：分类维度（机构名等）下偏移基线是维度错配的伪数据
    const temporal = detectTemporalAxis((data || []).map((d) => d?.[config.xAxisKey]));
    const momOk = temporal && len >= 3;
    const yoyOk = temporal && len > (len >= 13 ? 12 : 4);
    if (activeComparisonMode === 'mom' && !momOk) setActiveComparisonMode('none');
    if (activeComparisonMode === 'yoy' && !yoyOk) setActiveComparisonMode('none');
  }, [data, activeComparisonMode, config.xAxisKey]);

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
  // 且仅限时间序列 x 轴：分类维度下「上一条/周期偏移条」不是历史同期，
  // 对其计算同/环比会把其他分类的值误当基线（v0.4.2 修复）。
  const yoyOffset = data.length >= 13 ? 12 : 4;
  const isTemporalX = detectTemporalAxis(data.map((d) => d?.[xAxisKey]));
  const canCompareMom = isTemporalX && data.length >= 3;
  const canCompareYoy = isTemporalX && data.length > yoyOffset;

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

  // Format number in tooltip/axis：千分位 + 非整数补足两位小数（整数不补零）；
  // 不再自动缩写为万/亿——金额单位已由问数侧选定（SQL 按单位换算、表头带单位），二次缩写会与所选单位冲突
  const formatValue = (val: any) => {
    if (typeof val === 'number') {
      return Number.isInteger(val)
        ? val.toLocaleString()
        : val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      const isPieLike = type === 'pie' || type === 'donut';
      // pie/donut：label 为空，维度值在 payload[0].name（nameKey）；标题补维度中文名（如"客户类型: 产业客户"）
      const dimValue = isPieLike ? payload[0]?.name : label;
      const titleText =
        isPieLike && config.xAxisName && dimValue
          ? `${config.xAxisName}: ${dimValue}`
          : dimValue || '数据详情';
      return (
        <div className="bg-slate-900/95 border border-slate-700/80 p-3 rounded-xl shadow-xl text-xs space-y-1.5 z-50 min-w-[180px]">
          <div className="font-semibold text-slate-200 border-b border-slate-800 pb-1 flex items-center justify-between">
            <span>{titleText}</span>
            {activeComparisonMode !== 'none' && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold">
                {activeComparisonMode === 'yoy' ? '同比 (YoY) 对比' : '环比 (MoM) 对比'}
              </span>
            )}
          </div>
          {payload.map((entry: any, index: number) => {
            if (entry.dataKey && String(entry.dataKey).endsWith('_diff_pct')) return null;
            // pie/donut 的 entry.name 是维度值（已在标题展示），系列行改显示指标中文名
            const seriesName = isPieLike
              ? config.yAxisNames?.[yAxisKeys[0]] || '数值'
              : entry.name;
            return (
              <div key={index} className="flex items-center justify-between space-x-4">
                <span className="flex items-center space-x-1.5" style={{ color: entry.color }}>
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-slate-300 font-medium">{seriesName}:</span>
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

  // P2-2 下钻点击：从图表点击事件提取维度值
  const handleChartClick = (state: any) => {
    if (!drillable || !onDrill || !state || !state.activeLabel) return;
    onDrill(xAxisKey, state.activeLabel);
  };

  const renderChart = () => {
    switch (type) {
      case 'line':
        return (
          <LineChart data={chartData} onClick={handleChartClick}>
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
          <AreaChart data={chartData} onClick={handleChartClick}>
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

      case 'scatter': {
        const syKey = yAxisKeys[0];
        return (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} opacity={0.5} />
            <XAxis dataKey={xAxisKey} stroke={textColor} fontSize={12} tickLine={false} tickFormatter={formatValue} />
            <YAxis dataKey={syKey} stroke={textColor} fontSize={12} tickLine={false} tickFormatter={formatValue} />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Scatter data={data} fill={effectiveColors[0]} name={config.yAxisNames?.[syKey] || syKey} />
          </ScatterChart>
        );
      }

      case 'treemap': {
        const tmValueKey = yAxisKeys[0] || 'value';
        return (
          <Treemap
            data={data}
            dataKey={tmValueKey}
            nameKey={xAxisKey}
            stroke="#0f172a"
            content={(props: any) => {
              const { x, y, width, height, name, index } = props;
              if (!width || !height || width <= 0 || height <= 0) return <g key={`tm-${index}`} />;
              const fill = effectiveColors[(index || 0) % effectiveColors.length];
              const label = String(name ?? '');
              return (
                <g key={`tm-${index}`}>
                  <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={0.72} stroke="#0f172a" strokeWidth={1.5} rx={4} />
                  {width > 46 && height > 20 && (
                    <text x={x + 7} y={y + 17} fill="#f1f5f9" fontSize={11} fontWeight={600}>
                      {label.slice(0, Math.max(1, Math.floor(width / 13)))}
                    </text>
                  )}
                </g>
              );
            }}
          />
        );
      }

      case 'heatmap': {
        const metrics = yAxisKeys;
        const nums = data.flatMap((r) => metrics.map((m) => Number(r[m]))).filter((v) => Number.isFinite(v));
        const maxV = nums.length ? Math.max(...nums) : 0;
        const minV = nums.length ? Math.min(...nums) : 0;
        const baseColor = effectiveColors[0];
        return (
          <div className="w-full h-full overflow-auto p-2">
            <div className="grid gap-px" style={{ gridTemplateColumns: `130px repeat(${metrics.length}, minmax(64px, 1fr))` }}>
              <div />
              {metrics.map((m) => (
                <div key={m} className="text-[10px] text-slate-300 font-medium p-1.5 text-center truncate">
                  {config.yAxisNames?.[m] || m}
                </div>
              ))}
              {data.map((r, ri) => (
                <React.Fragment key={ri}>
                  <div className="text-[10px] text-slate-300 p-1.5 truncate flex items-center">{String(r[xAxisKey])}</div>
                  {metrics.map((m) => {
                    const v = Number(r[m]);
                    if (!Number.isFinite(v)) {
                      return (
                        <div key={m} className="text-[10px] text-slate-500 p-1.5 text-center bg-slate-900 rounded flex items-center justify-center">
                          -
                        </div>
                      );
                    }
                    const t = maxV === minV ? 0.5 : (v - minV) / (maxV - minV);
                    return (
                      <div
                        key={m}
                        className="text-[10px] text-slate-100 p-1.5 text-center rounded flex items-center justify-center font-mono"
                        style={{ backgroundColor: baseColor, opacity: 0.18 + t * 0.82 }}
                        title={`${config.yAxisNames?.[m] || m}: ${formatValue(v)}`}
                      >
                        {formatValue(v)}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      }

      case 'bar':
      default:
        return (
          <BarChart data={chartData} onClick={handleChartClick}>
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
                title={canCompareYoy ? '同比 Year-over-Year (与去年同期对比)' : !isTemporalX ? '仅时间序列维度支持同比对比' : '数据点不足，无法计算同比'}
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
                title={canCompareMom ? '环比 Month-over-Month (与上期值对比)' : !isTemporalX ? '仅时间序列维度支持环比对比' : '数据点不足，无法计算环比'}
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
        {type === 'heatmap' ? (
          renderChart()
        ) : (
          <ResponsiveContainer width="100%" height="90%">
            {renderChart()}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};

