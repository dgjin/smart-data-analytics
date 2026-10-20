/**
 * v0.9.107 问数星级评价弹层：1-5 星 + 最多 3 个预设标签 + 最多 200 字说明。
 * 只做展示与本地校验，提交动作由父组件回调（ChatMessageItem → QueryChat → POST /api/ratings/query）。
 * 与赞/踩 + 点踩纠错链路相互独立：不参与 few-shot 与统一记忆体。
 */
import React, { useState } from 'react';
import { Star, X } from 'lucide-react';
import {
  MAX_RATING_COMMENT,
  MAX_RATING_TAGS,
  QUERY_RATING_TAGS,
  RATING_LABELS,
} from '../../types/accessFeedback';
import { getErrorMessage } from '../../utils/errorUtils';

export interface QueryRatingValue {
  rating: number;
  tags: string[];
  comment: string;
}

/** 只读星级展示（已评价时回显） */
export const StarRow: React.FC<{ value: number; className?: string }> = ({ value, className = '' }) => (
  <span className={`inline-flex items-center ${className}`} aria-label={`${value} 星`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <Star
        key={n}
        className={`w-3 h-3 ${n <= value ? 'text-amber-400 fill-amber-400' : 'text-slate-600'}`}
      />
    ))}
  </span>
);

export const QueryRatingPopover: React.FC<{
  /** 已有评分（再次打开时回显） */
  initial?: QueryRatingValue | null;
  onClose: () => void;
  onSubmit: (value: QueryRatingValue) => Promise<void>;
}> = ({ initial, onClose, onSubmit }) => {
  const [rating, setRating] = useState(initial?.rating || 0);
  const [tags, setTags] = useState<string[]>(initial?.tags || []);
  const [comment, setComment] = useState(initial?.comment || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const toggleTag = (tag: string) => {
    setTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= MAX_RATING_TAGS) return prev;
      return [...prev, tag];
    });
  };

  const submit = async () => {
    if (!rating) {
      setError('请先选择星级');
      return;
    }
    if (comment.length > MAX_RATING_COMMENT) {
      setError(`评价内容不能超过 ${MAX_RATING_COMMENT} 字`);
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({ rating, tags, comment: comment.trim() });
    } catch (err) {
      setError(getErrorMessage(err) || '评价提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-72 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-3 text-left">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-slate-200">给本次回答打分</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300" aria-label="关闭">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1 mb-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            aria-label={`${n} 星`}
            title={RATING_LABELS[n]}
            className="p-0.5 rounded hover:bg-slate-800 transition-colors"
          >
            <Star
              className={`w-5 h-5 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-slate-600 hover:text-amber-300'}`}
            />
          </button>
        ))}
        <span className="ml-1 text-[10px] text-slate-400">{rating ? RATING_LABELS[rating] : '点击选择'}</span>
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        {QUERY_RATING_TAGS.map((tag) => {
          const selected = tags.includes(tag);
          const disabled = !selected && tags.length >= MAX_RATING_TAGS;
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              disabled={disabled}
              className={`px-1.5 py-0.5 rounded border text-[10px] transition-colors disabled:opacity-40 ${
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
        rows={2}
        maxLength={MAX_RATING_COMMENT}
        placeholder={`补充说明（可选，最多 ${MAX_RATING_COMMENT} 字）`}
        className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/60 resize-none"
      />

      {error && <p className="mt-1 text-[10px] text-rose-400">{error}</p>}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-slate-500">
          已选标签 {tags.length}/{MAX_RATING_TAGS}
        </span>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-[10px] text-slate-400 hover:text-slate-200">
            取消
          </button>
          <button
            onClick={submit}
            disabled={submitting || !rating}
            className="px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[10px] font-semibold text-white transition-colors"
          >
            {submitting ? '提交中…' : '提交评价'}
          </button>
        </div>
      </div>
    </div>
  );
};
