/**
 * v0.9.107 问数星级评价弹层（v0.9.109 简化为纯星级）：
 * - 只保留 1-5 星，点星即提交并关闭弹层；
 * - 与赞/踩 + 点踩纠错链路相互独立：不参与 few-shot 与统一记忆体。
 */
import React, { useState } from 'react';
import { Star, X } from 'lucide-react';
import { RATING_LABELS } from '../../types/accessFeedback';
import { getErrorMessage } from '../../utils/errorUtils';

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
  initialRating?: number;
  onClose: () => void;
  onSubmit: (rating: number) => Promise<void>;
}> = ({ initialRating, onClose, onSubmit }) => {
  const [rating, setRating] = useState(initialRating || 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (score: number) => {
    setRating(score);
    setError('');
    setSubmitting(true);
    try {
      await onSubmit(score);
    } catch (err) {
      setError(getErrorMessage(err) || '评价提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-60 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-3 text-left">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-slate-200">给本次回答打分 · 点星即提交</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300" aria-label="关闭">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => void submit(n)}
            disabled={submitting}
            aria-label={`${n} 星（点击即提交）`}
            title={`${RATING_LABELS[n]}（点击即提交）`}
            className="p-0.5 rounded hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <Star
              className={`w-5 h-5 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-slate-600 hover:text-amber-300'}`}
            />
          </button>
        ))}
        <span className="ml-1 text-[10px] text-slate-400">
          {submitting ? '提交中…' : rating ? RATING_LABELS[rating] : '点击选择'}
        </span>
      </div>

      {error && <p className="mt-1.5 text-[10px] text-rose-400">{error}</p>}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-slate-500">评价后仍可随时修改</span>
        <button onClick={onClose} className="text-[10px] text-slate-400 hover:text-slate-200">
          取消
        </button>
      </div>
    </div>
  );
};
