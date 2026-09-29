/**
 * v0.9.85 首启初始化向导共享 UI 原子（五个 Step 组件复用）。
 * 配色约定：ok=emerald / warn=amber / block=rose / running=indigo 旋转 / pending=slate；
 * 深色为默认主题，html.light 下由 index.css 变量重映射自动翻转，无需 dark: 前缀。
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';

export type StepLevel = 'ok' | 'warn' | 'block' | 'pending' | 'running';

export const SetupStatusIcon: React.FC<{ level: StepLevel; className?: string }> = ({ level, className = 'w-4 h-4' }) => {
  if (level === 'ok') return <CheckCircle2 className={`${className} text-emerald-400 shrink-0`} />;
  if (level === 'warn') return <AlertTriangle className={`${className} text-amber-400 shrink-0`} />;
  if (level === 'block') return <XCircle className={`${className} text-rose-400 shrink-0`} />;
  if (level === 'running') return <Loader2 className={`${className} text-indigo-400 shrink-0 animate-spin`} />;
  return <Circle className={`${className} text-slate-600 shrink-0`} />;
};

/** 子任务/检查项状态 → 图标等级 */
export function subtaskLevel(state: string): StepLevel {
  if (state === 'success') return 'ok';
  if (state === 'failed') return 'block';
  if (state === 'skipped') return 'warn';
  if (state === 'running') return 'running';
  return 'pending';
}

/** 描边次级按钮 */
export const outlineBtn =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

/** indigo 主按钮 */
export const primaryBtn =
  'inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
