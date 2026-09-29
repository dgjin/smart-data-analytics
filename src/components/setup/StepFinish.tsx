/**
 * 向导 Step⑤ 完成引导：就绪判定表（summarizeReadiness）+ 初始化成果总结卡 + 双 CTA。
 * CTA 由 SetupWizard 转交：POST /api/setup/complete → 关闭向导（可跳转问数页）。
 */
import React from 'react';
import { Loader2, MessageSquare, LayoutDashboard } from 'lucide-react';
import { SetupStatusIcon, primaryBtn, outlineBtn, type StepLevel } from './setupUi';
import { summarizeReadiness } from './setupLogic';
import type { SetupWizardState } from './setupTypes';

export interface StepFinishProps {
  state: SetupWizardState;
  /** 完成请求（POST /complete）进行中 */
  busy: boolean;
  /** gotoQuery=true 时关闭向导并跳转问数页 */
  onExit: (gotoQuery: boolean) => void;
}

export const StepFinish: React.FC<StepFinishProps> = ({ state, busy, onExit }) => {
  const rows = summarizeReadiness(state);
  const blocking = rows.filter((r) => r.level === 'block');
  const summary = state.summary || {};
  const nums = [
    { key: '数据源', value: summary.datasources },
    { key: '数据表', value: summary.tables },
    { key: '向量切片', value: summary.chunks },
    { key: '样例', value: summary.examples },
  ];

  return (
    <div className="space-y-3.5">
      {blocking.length > 0 && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200 leading-relaxed">
          ⚠️ 仍有阻断项未达标（{blocking.map((b) => b.label).join('、')}）：完成向导后相关功能暂不可用，可随时回到本向导或系统管理面板继续处理。
        </div>
      )}

      {/* 就绪判定表 */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 divide-y divide-slate-800/70">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start gap-3 px-4 py-3">
            <SetupStatusIcon level={r.level as StepLevel} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-100">{r.label}</div>
              <div
                className={`text-xs mt-0.5 ${
                  r.level === 'block' ? 'text-rose-300' : r.level === 'warn' ? 'text-amber-300' : 'text-slate-400'
                }`}
              >
                {r.note}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 初始化成果总结卡 */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-4">
        <div className="text-sm font-semibold text-slate-100">本次初始化成果</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-3">
          {nums.map((n) => (
            <div key={n.key} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-center">
              <div className="text-lg font-bold text-indigo-300 tabular-nums">{Number(n.value) || 0}</div>
              <div className="text-xs text-slate-400 mt-0.5">{n.key}</div>
            </div>
          ))}
        </div>
        {state.summary ? (
          <div className="text-xs text-slate-500 mt-2.5">
            统计口径：已接入数据源 / Schema 表数 / 知识向量切片 / few-shot 样例。可随时在系统管理面板查看「系统体检」。
          </div>
        ) : (
          <div className="text-xs text-slate-500 mt-2.5">成果数字将在向导状态刷新后展示。</div>
        )}
      </div>

      {/* CTA */}
      <div className="flex items-center gap-2.5 flex-wrap pt-0.5">
        <button
          type="button"
          className={`${primaryBtn} !px-5 !py-2 !text-sm`}
          disabled={busy}
          onClick={() => onExit(true)}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
          试问第一个问题
        </button>
        <button
          type="button"
          className={`${outlineBtn} !px-5 !py-2 !text-sm`}
          disabled={busy}
          onClick={() => onExit(false)}
        >
          <LayoutDashboard className="w-4 h-4" />
          进入系统
        </button>
      </div>
    </div>
  );
};
