/**
 * 点踩纠正弹层（统一记忆体一期）：低摩擦采集"错在哪"，可选补充说明与期望 SQL。
 * 只做展示与本地状态，提交动作由父组件回调（ChatMessageItem → QueryChat）。
 */
import React, { useState } from 'react';
import { X } from 'lucide-react';

export type FeedbackErrorType = 'TABLE_CHOICE' | 'COLUMN' | 'CALIBER' | 'UNDERSTANDING' | 'OTHER';

export interface FeedbackCorrection {
  errorType: FeedbackErrorType;
  note?: string;
  expectedSql?: string;
}

const ERROR_OPTIONS: { id: FeedbackErrorType; label: string }[] = [
  { id: 'TABLE_CHOICE', label: '选表错误' },
  { id: 'COLUMN', label: '字段错误' },
  { id: 'CALIBER', label: '口径/聚合错误' },
  { id: 'UNDERSTANDING', label: '理解偏差' },
  { id: 'OTHER', label: '其他' },
];

export const FeedbackCorrectionPopover: React.FC<{
  /** 不填原因，直接点踩 */
  onSkip: () => void;
  onSubmit: (correction: FeedbackCorrection) => void;
}> = ({ onSkip, onSubmit }) => {
  const [errorType, setErrorType] = useState<FeedbackErrorType>('TABLE_CHOICE');
  const [note, setNote] = useState('');
  const [expectedSql, setExpectedSql] = useState('');
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className="w-72 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-3 text-left">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-slate-200">哪里不对？（帮助系统不再犯同类错误）</span>
        <button onClick={onSkip} className="text-slate-500 hover:text-slate-300" aria-label="关闭">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {ERROR_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setErrorType(opt.id)}
            className={`px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              errorType === opt.id
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                : 'text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={400}
        placeholder="补充说明（可选）：例如应使用「订单表」而不是「退款表」"
        className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-rose-500/60 resize-none"
      />
      {!advanced ? (
        <button onClick={() => setAdvanced(true)} className="mt-1 text-[10px] text-cyan-400 hover:text-cyan-300">
          + 填写期望 SQL（可选）
        </button>
      ) : (
        <textarea
          value={expectedSql}
          onChange={(e) => setExpectedSql(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="期望的正确 SQL（可选，管理员审核时参考）"
          className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-[10px] font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500/60 resize-none"
        />
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button onClick={onSkip} className="text-[10px] text-slate-400 hover:text-slate-200">
          跳过，直接反馈
        </button>
        <button
          onClick={() =>
            onSubmit({
              errorType,
              note: note.trim() || undefined,
              expectedSql: expectedSql.trim() || undefined,
            })
          }
          className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-semibold"
        >
          提交反馈
        </button>
      </div>
      <p className="mt-1.5 text-[9px] text-slate-500 leading-snug">
        提交后进入「纠正候选」，管理员确认后生效；同一问题待审核期间的重复反馈会自动合并。
      </p>
    </div>
  );
};
