/**
 * v0.9.85 首启初始化向导主覆盖层（L1）：步骤轨 + 内容区 + 底部操作条。
 * - 状态持有：initialState 由 Host 传入；每步完成/跳过经 onResult → POST /api/setup/step 持久化（断点续做）；
 * - 步骤轨四态（✅ 完成 / ● 进行中 / ○ 未开始 / ⏭ 已跳过），已完成步骤可点击回看（重跑可用）；
 * - 「跳过此步」仅出现在 ②③④（索引 1..3）；「稍后配置」→ onLater（Host 转入 L2 横幅）；
 * - Step⑤ CTA → onExit → POST /api/setup/complete → onCompleted（Host 关闭向导并可跳问数页）。
 * 响应式：≥1024px 左右双栏；<1024px 步骤轨折叠为顶部摘要条。
 */
import React, { useCallback, useRef, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDot, Compass, SkipForward } from 'lucide-react';
import { StepEnvCheck } from './StepEnvCheck';
import { StepModelService } from './StepModelService';
import { StepAutoInit } from './StepAutoInit';
import { StepChecklist } from './StepChecklist';
import { StepFinish } from './StepFinish';
import { outlineBtn, primaryBtn } from './setupUi';
import { setupGet, setupPost } from './setupApi';
import { countDoneSteps, resolveInitialStep, stepTrackStates } from './setupLogic';
import { SETUP_STEPS, type SetupWizardState } from './setupTypes';

export interface SetupWizardProps {
  initialState: SetupWizardState;
  /** 「稍后配置」：仅关闭覆盖层（Host 转入 L2 横幅提醒） */
  onLater: () => void;
  /** 深链（'admin:*'）：Host 关闭向导并跳转系统管理 */
  onNavigate: (link: string) => void;
  /** POST /complete 成功后回调（gotoQuery=true 时跳转问数页） */
  onCompleted: (gotoQuery: boolean) => void;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ initialState, onLater, onNavigate, onCompleted }) => {
  const [state, setState] = useState<SetupWizardState>(initialState);
  const [step, setStep] = useState(() => resolveInitialStep(initialState));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const stepRef = useRef(step);
  stepRef.current = step;

  const refreshState = useCallback(async () => {
    try {
      const next = await setupGet<SetupWizardState>('/api/setup/state');
      setState((prev) => ({ ...prev, ...next }));
    } catch {
      /* 刷新失败静默：界面回退旧数据 */
    }
  }, []);

  const handleResult = useCallback(async (result: Record<string, unknown>) => {
    const idx = stepRef.current;
    setState((prev) => ({ ...prev, stepResults: { ...prev.stepResults, [String(idx)]: result } }));
    try {
      await setupPost('/api/setup/step', { step: idx, result });
    } catch (err) {
      setError(err instanceof Error ? err.message : '步骤结果保存失败');
    }
  }, []);

  const gotoStep = useCallback((next: number) => {
    if (next === stepRef.current) return;
    setReady(false);
    setStep(next);
    setError('');
  }, []);

  const skipStep = useCallback(async () => {
    await handleResult({ skipped: true });
    if (stepRef.current < SETUP_STEPS.length - 1) gotoStep(stepRef.current + 1);
  }, [handleResult, gotoStep]);

  const finish = useCallback(
    async (gotoQuery: boolean) => {
      setBusy(true);
      setError('');
      try {
        await setupPost('/api/setup/complete');
        onCompleted(gotoQuery);
      } catch (err) {
        setError(err instanceof Error ? err.message : '向导完成请求失败');
        setBusy(false);
      }
    },
    [onCompleted],
  );

  /** Step④ 深链：'setup:step2' 留在向导内回第②步，其余交 Host */
  const handleStepNavigate = useCallback(
    (link: string) => {
      if (link === 'setup:step2') {
        gotoStep(1);
        return;
      }
      onNavigate(link);
    },
    [gotoStep, onNavigate],
  );

  const track = stepTrackStates(state, step);
  const doneCount = countDoneSteps(state);
  const canSkip = step >= 1 && step <= 3;

  const renderStep = () => {
    const common = { state, refreshState, onResult: handleResult, onReadyChange: setReady };
    switch (step) {
      case 0:
        return <StepEnvCheck {...common} />;
      case 1:
        return <StepModelService {...common} />;
      case 2:
        return <StepAutoInit {...common} />;
      case 3:
        return <StepChecklist {...common} onNavigate={handleStepNavigate} />;
      default:
        return <StepFinish state={state} busy={busy} onExit={finish} />;
    }
  };

  const trackIcon = (i: number) => {
    const t = track[i];
    if (t === 'done') return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
    if (t === 'skipped') return <SkipForward className="w-4 h-4 text-slate-500 shrink-0" />;
    if (t === 'active') return <CircleDot className="w-4 h-4 text-indigo-400 shrink-0" />;
    return <Circle className="w-4 h-4 text-slate-600 shrink-0" />;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="首启初始化向导"
    >
      <div className="w-full max-w-5xl h-[min(720px,90vh)] flex flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
        {/* 顶栏 */}
        <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Compass className="w-5 h-5 text-indigo-400 shrink-0" />
            <span className="text-base font-bold text-slate-100">首启初始化向导</span>
            <span className="text-xs text-slate-400 tabular-nums">{doneCount}/5</span>
            {state.updatedAt && (
              <span className="text-xs text-slate-500 truncate hidden sm:inline">最近更新 {new Date(state.updatedAt).toLocaleString('zh-CN')}</span>
            )}
          </div>
          <button type="button" className={`${outlineBtn} shrink-0`} onClick={onLater}>
            稍后配置
          </button>
        </header>

        <div className="flex flex-1 min-h-0">
          {/* 左栏：步骤轨（≥1024px） */}
          <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-slate-800 py-3 overflow-y-auto">
            {SETUP_STEPS.map((s, i) => {
              const jumpable = i <= step || state.stepResults[String(i)] != null;
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={!jumpable}
                  onClick={() => gotoStep(i)}
                  className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === step ? 'bg-slate-800/70' : jumpable ? 'hover:bg-slate-800/40' : 'opacity-70'
                  }`}
                >
                  <span className="mt-0.5">{trackIcon(i)}</span>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm ${i === step ? 'font-bold text-slate-100' : 'text-slate-300'}`}>
                      {i + 1}. {s.title}
                    </span>
                    <span className="block text-xs text-slate-500 mt-0.5">{s.desc}</span>
                  </span>
                </button>
              );
            })}
          </aside>

          {/* 右栏：内容区 */}
          <section className="flex-1 flex flex-col min-w-0">
            {/* <1024px：步骤轨折叠为顶部摘要条 */}
            <div className="lg:hidden flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-800 text-xs text-slate-400 shrink-0">
              <span className="truncate">
                当前：{step + 1}/5 {SETUP_STEPS[step].title}
              </span>
              <span className="tabular-nums shrink-0">已完成 {doneCount}/5</span>
            </div>
            <div key={step} className="flex-1 overflow-y-auto px-6 py-5">
              {renderStep()}
            </div>
          </section>
        </div>

        {/* 底部操作条 */}
        <footer className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-800 shrink-0">
          <button type="button" className={outlineBtn} disabled={step === 0 || busy} onClick={() => gotoStep(step - 1)}>
            <ChevronLeft className="w-3.5 h-3.5" />
            上一步
          </button>
          <div className="flex items-center gap-2.5 min-w-0">
            {error && <span className="text-xs text-rose-300 truncate max-w-[16rem]">{error}</span>}
            {canSkip && (
              <button type="button" className={outlineBtn} disabled={busy} onClick={() => void skipStep()}>
                跳过此步
              </button>
            )}
            {step < SETUP_STEPS.length - 1 && (
              <button
                type="button"
                className={primaryBtn}
                disabled={!ready || busy}
                onClick={() => gotoStep(step + 1)}
                title={ready ? '' : '完成当前步骤后可用'}
              >
                下一步
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
};
