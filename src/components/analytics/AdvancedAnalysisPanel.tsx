/**
 * P1 高级分析面板：看板图表卡片的「高级分析」入口弹层。
 * 三个 Tab 复用同一份 widget 数据：
 * - 时序预测（P1-5）：统计引擎出未来 N 期 + 波动区间 + AI 解读；
 * - 多维归因（P1-6）：最新两期贡献度拆解 + 排序 + AI 结论；
 * - 情景推演（P1-9）：基于固化 SQL 的场景改写对比执行。
 * Esc / 点击遮罩关闭；面板打开时锁定页面滚动。
 */
import React, { useEffect, useState } from 'react';
import { BarChart3, FlaskConical, TrendingUp, X } from 'lucide-react';
import { DashboardWidget } from '../../types/analytics';
import { ForecastView } from './ForecastView';
import { AttributionView } from './AttributionView';
import { WhatIfView } from './WhatIfView';

type AnalysisTab = 'forecast' | 'attribution' | 'whatif';

const TABS: { id: AnalysisTab; label: string; icon: React.ReactNode }[] = [
  { id: 'forecast', label: '时序预测', icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { id: 'attribution', label: '多维归因', icon: <BarChart3 className="w-3.5 h-3.5" /> },
  { id: 'whatif', label: '情景推演', icon: <FlaskConical className="w-3.5 h-3.5" /> },
];

export const AdvancedAnalysisPanel: React.FC<{ widget: DashboardWidget; onClose: () => void }> = ({ widget, onClose }) => {
  const [tab, setTab] = useState<AnalysisTab>('forecast');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[88vh] bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + Tab */}
        <div className="px-5 pt-4 pb-0 border-b border-slate-800 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 min-w-0">
              <div className="w-7 h-7 rounded-xl bg-indigo-500/20 text-indigo-300 flex items-center justify-center shrink-0">
                <TrendingUp className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-sm text-slate-100 truncate">高级分析 · {widget.title}</div>
                <div className="text-[10px] text-slate-500">
                  基于该图表固化的 {widget.data.length} 行数据与 SQL 口径；预测与归因为统计计算，推演为安全改写后对比执行
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              title="关闭（Esc）"
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center space-x-1 mt-3">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-t-xl text-[11px] font-semibold transition-colors border-b-2 ${
                  tab === t.id
                    ? 'text-indigo-300 border-indigo-500 bg-slate-950/50'
                    : 'text-slate-500 border-transparent hover:text-slate-300'
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 内容区 */}
        <div className="p-5 overflow-y-auto">
          {tab === 'forecast' && <ForecastView widget={widget} />}
          {tab === 'attribution' && <AttributionView widget={widget} />}
          {tab === 'whatif' && <WhatIfView widget={widget} />}
        </div>
      </div>
    </div>
  );
};
