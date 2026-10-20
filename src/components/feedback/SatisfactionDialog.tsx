/**
 * v0.9.107 全站满意度弹窗（v0.9.109 简化为纯星级 + 入口移至侧边栏）：
 * - 只保留 1-5 星，点星即提交并自动关闭；
 * - 打开时回显本人最近一次评价（24h 内重复提交由服务端更新最近一条，可反复修改）；
 * - 与问数星级评价共用 /api/ratings 体系，独立于 query_feedback。
 */
import React, { useEffect, useState } from 'react';
import { Star, X } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import { notifyRatingUpdated } from '../../utils/ratingEvents';
import { MySatisfaction, RATING_LABELS } from '../../types/accessFeedback';

export const SatisfactionDialog: React.FC<{ page: string; onClose: () => void }> = ({ page, onClose }) => {
  const [rating, setRating] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // 回显本人最近一次评价（失败不阻断填写）
  useEffect(() => {
    let alive = true;
    apiFetch('/api/ratings/mine')
      .then((resp) => (resp.ok ? (resp.json() as Promise<{ rating: MySatisfaction | null }>) : null))
      .then((data) => {
        if (!alive || !data?.rating) return;
        setRating(data.rating.rating || 0);
      })
      .catch(() => {
        /* 回显失败忽略 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (score: number) => {
    setRating(score);
    setSubmitting(true);
    setError('');
    try {
      const resp = await apiFetch('/api/ratings/app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, rating: score }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || '提交失败，请稍后重试');
      }
      // 点星即评：成功即关闭弹窗，并通知侧边栏综合星级立即刷新
      notifyRatingUpdated();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err) || '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-3 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
            <Star className="w-4 h-4 text-amber-400" />
            <span>给系统打个星级</span>
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          点击星星即可完成评价，评价会进入管理端「评价中心」，帮助你持续改进使用体验；可随时修改。
        </p>

        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => void submit(n)}
              disabled={loading || submitting}
              aria-label={`${n} 星（点击即提交）`}
              title={`${RATING_LABELS[n]}（点击即提交）`}
              className="p-1 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <Star
                className={`w-6 h-6 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-slate-600 hover:text-amber-300'}`}
              />
            </button>
          ))}
          <span className="ml-1 text-[11px] text-slate-400">
            {submitting ? '提交中…' : rating ? RATING_LABELS[rating] : '点击选择星级'}
          </span>
        </div>

        {error && <p className="text-[11px] text-rose-400">{error}</p>}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-slate-500">24 小时内重复提交会更新最近一条</span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
