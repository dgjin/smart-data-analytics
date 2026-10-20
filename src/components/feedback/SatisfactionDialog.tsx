/**
 * v0.9.107 全站满意度弹窗（Header 常驻入口）：
 * - 1-5 星 + 最多 3 个预设标签 + 最多 200 字建议；
 * - 打开时回显本人最近一次评价（24h 内重复提交由服务端更新最近一条，可反复修改）；
 * - 与问数星级评价共用 /api/ratings 体系，独立于 query_feedback。
 */
import React, { useEffect, useState } from 'react';
import { Star, X } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  APP_RATING_TAGS,
  MAX_RATING_COMMENT,
  MAX_RATING_TAGS,
  MySatisfaction,
  RATING_LABELS,
} from '../../types/accessFeedback';

export const SatisfactionDialog: React.FC<{ page: string; onClose: () => void }> = ({ page, onClose }) => {
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 回显本人最近一次评价（失败不阻断填写）
  useEffect(() => {
    let alive = true;
    apiFetch('/api/ratings/mine')
      .then((resp) => (resp.ok ? (resp.json() as Promise<{ rating: MySatisfaction | null }>) : null))
      .then((data) => {
        if (!alive || !data?.rating) return;
        setRating(data.rating.rating || 0);
        setTags(Array.isArray(data.rating.tags) ? data.rating.tags.slice(0, MAX_RATING_TAGS) : []);
        setComment(data.rating.comment || '');
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

  const toggleTag = (tag: string) => {
    setTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= MAX_RATING_TAGS) return prev;
      return [...prev, tag];
    });
  };

  const submit = async () => {
    if (!rating) {
      setNotice({ type: 'error', text: '请先选择星级' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const resp = await apiFetch('/api/ratings/app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, rating, tags, comment: comment.trim() }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || '提交失败，请稍后重试');
      }
      setNotice({ type: 'success', text: '已提交，可再次修改（24 小时内重复提交更新最近一条）' });
    } catch (err) {
      setNotice({ type: 'error', text: getErrorMessage(err) || '提交失败，请稍后重试' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-3 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
            <Star className="w-4 h-4 text-amber-400" />
            <span>全站满意度评价</span>
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          你的评价会进入管理端「评价中心」，用于改进问数准确率与使用体验；不强制、可随时修改。
        </p>

        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              disabled={loading}
              aria-label={`${n} 星`}
              title={RATING_LABELS[n]}
              className="p-1 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <Star
                className={`w-6 h-6 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-slate-600 hover:text-amber-300'}`}
              />
            </button>
          ))}
          <span className="ml-1 text-[11px] text-slate-400">{rating ? RATING_LABELS[rating] : '点击选择星级'}</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {APP_RATING_TAGS.map((tag) => {
            const selected = tags.includes(tag);
            const disabled = !selected && tags.length >= MAX_RATING_TAGS;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                disabled={disabled}
                className={`px-2 py-0.5 rounded-md border text-[11px] transition-colors disabled:opacity-40 ${
                  selected
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                    : 'text-slate-400 border-slate-700 hover:text-slate-200'
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={MAX_RATING_COMMENT}
          placeholder={`使用建议或遇到的问题（可选，最多 ${MAX_RATING_COMMENT} 字）`}
          className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/60 resize-none"
        />

        {notice && (
          <p className={`text-[11px] ${notice.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>{notice.text}</p>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-slate-500">
            标签 {tags.length}/{MAX_RATING_TAGS} · 文字 {comment.length}/{MAX_RATING_COMMENT}
          </span>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
            >
              关闭
            </button>
            <button
              onClick={submit}
              disabled={submitting || loading || !rating}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white transition-colors"
            >
              {submitting ? '提交中…' : '提交评价'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
