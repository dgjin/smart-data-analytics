import React from 'react';
import {
  BarChart2,
  LineChart as LineIcon,
  AreaChart as AreaIcon,
  PieChart as PieIcon,
  Layers,
  Sparkles,
} from 'lucide-react';
import { ChartConfig, ChartType } from '../../types/analytics';

interface ChartCustomizerProps {
  config: ChartConfig;
  onChange: (newConfig: ChartConfig) => void;
  onPinToDashboard?: () => void;
}

export const ChartCustomizer: React.FC<ChartCustomizerProps> = ({
  config,
  onChange,
  onPinToDashboard,
}) => {
  const chartTypeOptions: { type: ChartType; label: string; icon: any }[] = [
    { type: 'bar', label: '柱状图', icon: BarChart2 },
    { type: 'line', label: '折线图', icon: LineIcon },
    { type: 'area', label: '面积图', icon: AreaIcon },
    { type: 'pie', label: '饼图', icon: PieIcon },
    { type: 'donut', label: '环形图', icon: PieIcon },
  ];

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-900/90 border border-slate-800 rounded-xl text-xs">
      {/* Chart Type Selector Buttons */}
      <div className="flex items-center space-x-1 overflow-x-auto py-0.5">
        <span className="text-slate-400 font-medium mr-1.5 shrink-0">图表形态:</span>
        {chartTypeOptions.map((opt) => {
          const Icon = opt.icon;
          const isActive = config.type === opt.type;
          return (
            <button
              key={opt.type}
              onClick={() => onChange({ ...config, type: opt.type })}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg transition-all shrink-0 ${
                isActive
                  ? 'bg-indigo-600 text-white font-medium shadow'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {/* Right Action Tools */}
      <div className="flex items-center space-x-2 shrink-0">
        {/* Toggle Stacked Mode for Bar/Area */}
        {(config.type === 'bar' || config.type === 'area') && (
          <button
            onClick={() => onChange({ ...config, stacked: !config.stacked })}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
              config.stacked
                ? 'bg-indigo-950 text-indigo-300 border-indigo-500/40'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>堆叠模式 {config.stacked ? '已开启' : '已关闭'}</span>
          </button>
        )}

        {/* Pin to Custom Dashboard Button */}
        {onPinToDashboard && (
          <button
            onClick={onPinToDashboard}
            className="flex items-center space-x-1 px-2.5 py-1 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white rounded-lg font-medium shadow-sm transition-all"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>固定至看板</span>
          </button>
        )}
      </div>
    </div>
  );
};
