/**
 * v0.9.85 系统管理 · L3 常驻入口卡片（设计 §5.2）：
 * - 向导未完成：「首启初始化向导」卡片（进度 N/5 + 说明 + [继续配置]）
 *   —— 经 window 事件 SETUP_WIZARD_OPEN_EVENT 唤起 SetupWizardHost 托管的 L1 覆盖层（跨组件解耦）；
 * - 向导已完成：「系统体检」卡片（最近检查时间 + 就绪判定三态 + [重新检测]，不重复执行初始化流水线）；
 * - v0.9.87 人工入口：[打开初始化向导] —— 完成后仍可随时重开向导（回看快照 / 重跑任意步骤），
 *   与未完成态 [继续配置] 共用 SETUP_WIZARD_OPEN_EVENT；
 * - 向导层完成/关闭会广播 SETUP_REFRESH_EVENT，卡片据此刷新（当前页内完成也能即时同步）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Compass, RefreshCw } from 'lucide-react';
import { setupGet } from './setupApi';
import { SetupStatusIcon, outlineBtn, primaryBtn, type StepLevel } from './setupUi';
import { countDoneSteps, pendingChecklistItems, summarizeReadiness } from './setupLogic';
import { SETUP_REFRESH_EVENT, SETUP_WIZARD_OPEN_EVENT, type SetupChecklistItem, type SetupWizardState } from './setupTypes';

export const SetupStatusCard: React.FC = () => {
  const [state, setState] = useState<SetupWizardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  /** 体检待处理项（v0.9.86）：checklist 中 todo/warn 持续跟踪（设计 §四 Step④ 注：未处理项在体检卡片列出） */
  const [pending, setPending] = useState<SetupChecklistItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await setupGet<SetupWizardState>('/api/setup/state');
      setState(s);
      setCheckedAt(new Date().toLocaleString('zh-CN'));
      if (s.status === 'completed') {
        try {
          const items = await setupGet<SetupChecklistItem[]>('/api/setup/checklist');
          setPending(pendingChecklistItems(items));
        } catch {
          setPending([]);
        }
      } else {
        setPending([]);
      }
    } catch {
      setError('向导状态读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 向导层完成/关闭 → 刷新卡片
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(SETUP_REFRESH_EVENT, handler);
    return () => window.removeEventListener(SETUP_REFRESH_EVENT, handler);
  }, [load]);

  if (loading && !state) {
    return <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-xs text-slate-400">向导状态加载中…</div>;
  }
  if ((error && !state) || !state) return null;

  // 未完成：初始化向导入口
  if (state.status !== 'completed') {
    return (
      <div className="rounded-2xl border border-indigo-500/30 bg-indigo-950/30 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <Compass className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-100">首启初始化向导 · 进度 {countDoneSteps(state)}/5</div>
              <div className="text-xs text-slate-400 mt-1 leading-relaxed">
                完成向导可闭环数据源接入、知识向量化与样例种子，显著提升问数准确率；支持断点续做，不阻断系统其他功能。
              </div>
              {state.updatedAt && (
                <div className="text-xs text-slate-500 mt-1">最近更新 {new Date(state.updatedAt).toLocaleString('zh-CN')}</div>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`${primaryBtn} shrink-0`}
            onClick={() => window.dispatchEvent(new CustomEvent(SETUP_WIZARD_OPEN_EVENT))}
          >
            继续配置
          </button>
        </div>
      </div>
    );
  }

  // 已完成：系统体检
  const rows = summarizeReadiness(state);
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Activity className="w-5 h-5 text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-100">系统体检</div>
            <div className="text-xs text-slate-500 mt-0.5">
              最近检查 {checkedAt || '—'}（进入本页自动检测；不重复执行初始化流水线）
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className={`${primaryBtn} shrink-0`}
            title="随时重开向导：回看各步结果快照，或重跑环境自检 / 模型探测 / 数据准备"
            onClick={() => window.dispatchEvent(new CustomEvent(SETUP_WIZARD_OPEN_EVENT))}
          >
            <Compass className="w-3.5 h-3.5" />
            打开初始化向导
          </button>
          <button type="button" className={`${outlineBtn} shrink-0`} onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            重新检测
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start gap-2.5 rounded-xl border border-slate-800 bg-slate-950/50 px-3.5 py-2.5">
            <SetupStatusIcon level={r.level as StepLevel} className="w-3.5 h-3.5 mt-0.5" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-200">{r.label}</div>
              <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{r.note}</div>
            </div>
          </div>
        ))}
      </div>
      {pending.length > 0 && (
        <div className="mt-3.5 rounded-xl border border-amber-500/30 bg-amber-950/20 px-3.5 py-3">
          <div className="text-xs font-semibold text-amber-200">待处理项 {pending.length}</div>
          <ul className="mt-1.5 space-y-1">
            {pending.map((it) => (
              <li key={it.key} className="text-[11px] leading-relaxed">
                <span className="text-slate-200">{it.title}</span>
                <span className="text-slate-400">：{it.detail}</span>
              </li>
            ))}
          </ul>
          <div className="text-[11px] text-slate-500 mt-1.5">可在向导第④步或系统管理对应面板处理（不影响其他功能使用）</div>
        </div>
      )}
    </div>
  );
};
