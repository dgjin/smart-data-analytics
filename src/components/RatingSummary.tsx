/**
 * v0.9.108 侧边栏星级评价统计：问数评分 / 全站评分（均分 + 评价条数）。
 * - 数据来自 GET /api/ratings/public-stats，只含聚合数字，不含任何评价内容或用户信息；
 * - 每 60s 轮询，评价提交成功后通过 app:rating-updated 事件立即刷新；
 * - 拉取失败静默隐藏，不阻塞侧边栏其他内容。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { apiFetch } from '../api/client';
import { RATING_UPDATED_EVENT } from '../utils/ratingEvents';

interface StatPair {
  avg: number;
  count: number;
}

interface PublicRatingStats {
  query: StatPair;
  app: StatPair;
}

const REFRESH_MS = 60_000;

const formatAvg = (pair: StatPair): string => (pair.count > 0 ? pair.avg.toFixed(1) : '暂无');

export const RatingSummary: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [stats, setStats] = useState<PublicRatingStats | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/ratings/public-stats');
      if (!resp.ok) return;
      const data = (await resp.json()) as Partial<PublicRatingStats>;
      setStats({
        query: { avg: Number(data.query?.avg) || 0, count: Number(data.query?.count) || 0 },
        app: { avg: Number(data.app?.avg) || 0, count: Number(data.app?.count) || 0 },
      });
    } catch {
      /* 评分统计获取失败静默 */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onUpdated = () => void load();
    window.addEventListener(RATING_UPDATED_EVENT, onUpdated);
    return () => {
      clearInterval(timer);
      window.removeEventListener(RATING_UPDATED_EVENT, onUpdated);
    };
  }, [load]);

  if (!stats) return null;

  const total = stats.query.count + stats.app.count;

  return (
    <div
      className={`flex items-center justify-center flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-slate-500 ${className}`}
      title="评分统计：问数星级评价与全站满意度的平均分（1-5 星）与评价条数；仅聚合数字，所有登录用户可见"
    >
      <span className="inline-flex items-center space-x-1">
        <Star className="w-3 h-3 text-amber-400/80 fill-amber-400/40" />
        {total === 0 ? (
          <span className="text-slate-500">
            星级评价 <span className="text-slate-600">暂无评价，欢迎打分</span>
          </span>
        ) : (
          <>
            <span>问数</span>
            <span className="font-semibold text-slate-300 tabular-nums">{formatAvg(stats.query)}</span>
            {stats.query.count > 0 && <span className="text-slate-600">({stats.query.count})</span>}
            <span className="text-slate-700">·</span>
            <span>全站</span>
            <span className="font-semibold text-slate-300 tabular-nums">{formatAvg(stats.app)}</span>
            {stats.app.count > 0 && <span className="text-slate-600">({stats.app.count})</span>}
          </>
        )}
      </span>
    </div>
  );
};
