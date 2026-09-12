import React from 'react';

/** 分类内顶部 Tab 项（icon 为未选中态图标，color 为其识别色） */
export interface SectionTabItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

/** 选中态分类色系（完整类名静态书写，确保 Tailwind 构建期可扫描生成） */
export type SectionTabAccent = 'cyan' | 'amber' | 'rose' | 'emerald';

const ACCENT_ACTIVE: Record<SectionTabAccent, string> = {
  cyan: 'bg-cyan-600 shadow-lg shadow-cyan-600/30',
  amber: 'bg-amber-600 shadow-lg shadow-amber-600/30',
  rose: 'bg-rose-600 shadow-lg shadow-rose-600/30',
  emerald: 'bg-emerald-600 shadow-lg shadow-emerald-600/30',
};

/**
 * 系统管理分类内的顶部 Tab 分类条（v0.9.57 起多面板分类统一使用：
 * 规则治理 / 质量监控 / 权限审批 / AI 审核，accent 跟随左栏分类色系）。
 */
export function SectionTabs<T extends string>({
  tabs,
  active,
  onChange,
  accent,
}: {
  tabs: SectionTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  accent: SectionTabAccent;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap border-b border-slate-800 pb-3">
      {tabs.map((t) => {
        const isActive = active === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              isActive
                ? `text-white ${ACCENT_ACTIVE[accent]}`
                : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            <Icon className={`w-4 h-4 ${isActive ? '' : t.color}`} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
