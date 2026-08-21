import React from 'react';
import { TrendingUp, TrendingDown, Minus, Sparkles } from 'lucide-react';

interface KPIMetric {
  label: string;
  value: string | number;
  change?: number;
  trend?: 'up' | 'down' | 'neutral';
  subtext?: string;
}

interface KPIStatsProps {
  metrics: KPIMetric[];
}

export const KPIStats: React.FC<KPIStatsProps> = ({ metrics }) => {
  if (!metrics || metrics.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {metrics.map((item, idx) => {
        const isPositive = item.trend === 'up' || (item.change !== undefined && item.change > 0);
        const isNegative = item.trend === 'down' || (item.change !== undefined && item.change < 0);

        return (
          <div
            key={idx}
            className="p-3.5 bg-slate-900/90 border border-slate-800 hover:border-slate-700/80 rounded-2xl transition-all shadow-sm space-y-1.5"
          >
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>{item.label}</span>
              {item.change !== undefined && (
                <div
                  className={`flex items-center space-x-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                    isPositive
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                      : isNegative
                      ? 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {isPositive ? (
                    <TrendingUp className="w-3 h-3 mr-0.5" />
                  ) : isNegative ? (
                    <TrendingDown className="w-3 h-3 mr-0.5" />
                  ) : (
                    <Minus className="w-3 h-3 mr-0.5" />
                  )}
                  <span>
                    {item.change > 0 ? `+${item.change}%` : `${item.change}%`}
                  </span>
                </div>
              )}
            </div>

            <div className="text-xl sm:text-2xl font-extrabold text-slate-100 tracking-tight font-mono">
              {/* 数值：千分位 + 非整数补足两位小数（整数不补零）；字符串值（已含单位文字）原样展示 */}
              {typeof item.value === 'number'
                ? Number.isInteger(item.value)
                  ? item.value.toLocaleString()
                  : item.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : item.value}
            </div>

            {item.subtext && (
              <div className="text-[11px] text-slate-400 flex items-center space-x-1">
                <Sparkles className="w-3 h-3 text-indigo-400 shrink-0" />
                <span className="truncate">{item.subtext}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
