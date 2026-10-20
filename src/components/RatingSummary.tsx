/**
 * v0.9.108 侧边栏评价统计（v0.9.109 评价入口由 Header 移至侧边栏）：
 * - 展示问数 + 全站的综合星级（加权均分）与总评价条数，并保留两项细分均分；
 * - 点击「评价」打开全站星级评价（仅 1-5 星）；
 * - 60s 轮询 + 评价提交后 app:rating-updated 事件即时刷新；只含聚合数字。
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

const EMPTY_STATS: PublicRatingStats = { query: { avg: 0, count: 0 }, app: { avg: 0, count: 0 } };
const REFRESH_MS = 60_000;

const formatAvg = (pair: StatPair): string => (pair.count > 0 ? pair.avg.toFixed(1) : '暂无');

export const RatingSummary: React.FC<{ onRate: () => void; className?: string }> = ({ onRate, className = '' }) => {
  const [stats, setStats] = useState<PublicRatingStats>(EMPTY_STATS);

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
      /* 评分统计获取失败静默，保留上一次数据 */
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

  const total = stats.query.count + stats.app.count;
  const overall =
    total > 0 ? (stats.query.avg * stats.query.count + stats.app.avg * stats.app.count) / total : 0;
  const filled = Math.round(overall);

  return (
    <div
      className={`rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-950/20 via-slate-900 to-slate-900 p-2.5 space-y-1.5 ${className}`}
      title="综合星级 = 问数星级评价与全站满意度的加权平均；仅展示聚合数字，不含评价内容"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-200">
          <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
          综合星级
        </span>
        <button
          onClick={onRate}
          className="px-1.5 py-0.5 rounded border border-amber-500/40 text-[10px] text-amber-300 hover:bg-amber-500/10 transition-colors"
        >
          评价
        </button>
      </div>

      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={`w-3 h-3 ${n <= filled ? 'text-amber-400 fill-amber-400' : 'text-slate-700'}`}
          />
        ))}
        <span className="ml-1 text-sm font-bold text-amber-300 tabular-nums">
          {total > 0 ? overall.toFixed(1) : '—'}
        </span>
        <span className="text-[10px] text-slate-500">（{total} 条）</span>
      </div>

      <p className="text-[10px] text-slate-500 tabular-nums">
        问数 {formatAvg(stats.query)}
        {stats.query.count > 0 ? `（${stats.query.count}）` : ''} · 全站 {formatAvg(stats.app)}
        {stats.app.count > 0 ? `（${stats.app.count}）` : ''}
      </p>
    </div>
  );
};
