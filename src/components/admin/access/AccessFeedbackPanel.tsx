/**
 * v0.9.107 访问与评价（管理端容器）：顶部 Tab 切换「访问统计」与「评价中心」。
 * 访问统计 = 对外计数器 + 模块热度排行；评价中心 = 问数星级评价 + 全站满意度看板与明细。
 */
import React, { useState } from 'react';
import { BarChart3, Star } from 'lucide-react';
import { SectionTabItem, SectionTabs } from '../SectionTabs';
import { AccessStatsPanel } from './AccessStatsPanel';
import { RatingCenterPanel } from './RatingCenterPanel';

type AccessFeedbackTab = 'access' | 'ratings';

const TABS: SectionTabItem<AccessFeedbackTab>[] = [
  { id: 'access', label: '访问统计', icon: BarChart3, color: 'text-sky-400' },
  { id: 'ratings', label: '评价中心', icon: Star, color: 'text-amber-400' },
];

export const AccessFeedbackPanel: React.FC = () => {
  const [tab, setTab] = useState<AccessFeedbackTab>('access');

  return (
    <div className="space-y-5">
      <SectionTabs<AccessFeedbackTab> tabs={TABS} active={tab} onChange={setTab} accent="emerald" />
      {tab === 'access' ? <AccessStatsPanel /> : <RatingCenterPanel />}
    </div>
  );
};
