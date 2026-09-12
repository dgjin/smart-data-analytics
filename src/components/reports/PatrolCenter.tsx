import React from 'react';
import { Radar } from 'lucide-react';
import { PatrolPanel } from '../admin/PatrolPanel';

/**
 * 异常巡检（页面壳）：固定页头 + PatrolPanel 内容组件（P0-1）。
 * 同一 PatrolPanel 亦嵌入「系统管理 → 异常巡检」分类，双入口共用单一实现。
 */
export const PatrolCenter: React.FC = () => {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div className="flex items-center space-x-3 px-6 py-4 border-b border-slate-800/60 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-amber-600/20 border border-amber-500/30 flex items-center justify-center">
          <Radar className="w-4 h-4 text-amber-400" />
        </div>
        <div>
          <h1 className="text-base font-bold text-slate-100">异常巡检</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            数据源级自动巡检：按期扫描最新真实数据报表，异常波动主动预警
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <PatrolPanel />
      </div>
    </div>
  );
};
