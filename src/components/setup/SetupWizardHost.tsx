/**
 * v0.9.85 首启初始化向导宿主（App 壳内，仅 ADMIN 渲染）：
 * - 加载 GET /api/setup/state → 向导未完成时 L1 自动弹出（每浏览器会话一次）→ 关闭后转 L2 常驻横幅；
 * - L2 横幅：进度 N/5 + 流水线子任务进度（5s 轮询）+ [继续配置] + [7 天不再提醒]（POST /skip）；
 * - 完成回调：关闭向导 + 刷新数据源清单 + 可选跳转问数页；离线横幅同时显示时自动下移避让。
 * - v0.9.87：外部入口（含体检卡片 [打开初始化向导]）唤起时同步拉取最新状态，保证重开看到最新快照。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { useOnlineStatus } from '../../pwa/useOnlineStatus';
import { SetupWizard } from './SetupWizard';
import { setupGet, setupPost } from './setupApi';
import { countDoneSteps, isPipelineFinished, isWizardActive } from './setupLogic';
import { SETUP_REFRESH_EVENT, SETUP_WIZARD_OPEN_EVENT, type PipelineProgress, type SetupWizardState } from './setupTypes';

const L1_SESSION_KEY = 'setup_wizard_l1_shown';

export const SetupWizardHost: React.FC = () => {
  const { loadDataSources, setActiveTab } = useAnalyticsStore();
  const online = useOnlineStatus();
  const [state, setState] = useState<SetupWizardState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pipe, setPipe] = useState<{ done: number; total: number; finished: boolean } | null>(null);
  const autoShownRef = useRef(false);

  // 初始加载（失败静默：向导不阻断系统使用）
  useEffect(() => {
    let alive = true;
    setupGet<SetupWizardState>('/api/setup/state')
      .then((s) => {
        if (alive) {
          setState(s);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // L1 自动弹出（每浏览器会话一次；关闭后由 L2 横幅承接）
  useEffect(() => {
    if (!loaded || !state || autoShownRef.current || open) return;
    if (!isWizardActive(state)) return;
    autoShownRef.current = true;
    let shown: string;
    try {
      shown = sessionStorage.getItem(L1_SESSION_KEY) || '';
    } catch {
      shown = '';
    }
    if (shown) return;
    try {
      sessionStorage.setItem(L1_SESSION_KEY, '1');
    } catch {
      /* 隐私模式等场景忽略 */
    }
    setOpen(true);
  }, [loaded, state, open]);

  const bannerVisible = !!state && isWizardActive(state) && !open;
  const pipelineTaskId = state?.pipelineTaskId || null;

  /** 拉取最新向导状态（外部入口打开前 / 关闭后均刷新，保证快照不过期） */
  const refreshHostState = useCallback(() => {
    setupGet<SetupWizardState>('/api/setup/state')
      .then(setState)
      .catch(() => {});
  }, []);

  // L3 卡片等外部入口（含 v0.9.87 体检卡片 [打开初始化向导]）：唤起 L1 覆盖层并刷新状态
  useEffect(() => {
    const handler = () => {
      setOpen(true);
      refreshHostState();
    };
    window.addEventListener(SETUP_WIZARD_OPEN_EVENT, handler);
    return () => window.removeEventListener(SETUP_WIZARD_OPEN_EVENT, handler);
  }, [refreshHostState]);

  // L2 横幅流水线进度（5s 轮询；终态停止）
  useEffect(() => {
    if (!bannerVisible || !pipelineTaskId) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const p = await setupGet<PipelineProgress>(`/api/setup/pipeline/${pipelineTaskId}`);
        if (stopped) return;
        const subtasks = p.subtasks || [];
        setPipe({
          done: subtasks.filter((s) => s.state !== 'pending' && s.state !== 'running').length,
          total: subtasks.length,
          finished: isPipelineFinished(p),
        });
        if (isPipelineFinished(p)) return;
      } catch {
        /* 单次失败：下一轮重试 */
      }
      if (!stopped) timer = window.setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bannerVisible, pipelineTaskId]);

  const mute = useCallback(async () => {
    try {
      await setupPost('/api/setup/skip', { days: 7 });
      setState((s) => (s ? { ...s, skippedUntil: new Date(Date.now() + 7 * 86400_000).toISOString() } : s));
    } catch {
      /* 静默失败：横幅保持 */
    }
  }, []);

  /** 向导关闭（稍后配置）：刷新一次状态供横幅显示最新进度 */
  const closeWizard = useCallback(() => {
    setOpen(false);
    refreshHostState();
    window.dispatchEvent(new Event(SETUP_REFRESH_EVENT));
  }, [refreshHostState]);

  const handleCompleted = useCallback(
    (gotoQuery: boolean) => {
      setOpen(false);
      setState((s) => (s ? { ...s, status: 'completed' } : s));
      void loadDataSources();
      if (gotoQuery) setActiveTab('query');
      window.dispatchEvent(new Event(SETUP_REFRESH_EVENT));
    },
    [loadDataSources, setActiveTab],
  );

  const handleNavigate = useCallback(
    (link: string) => {
      setOpen(false);
      if (link.startsWith('admin:')) setActiveTab('admin');
    },
    [setActiveTab],
  );

  return (
    <>
      {bannerVisible && state && (
        <div
          className={`fixed ${online ? 'top-16' : 'top-[5.75rem]'} left-0 right-0 z-40 flex items-center justify-center gap-3 bg-amber-500/95 text-slate-900 text-xs font-semibold py-1.5 shadow-md px-4`}
        >
          <Settings className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            系统初始化进度 {countDoneSteps(state)}/5
            {pipe &&
              (pipe.finished
                ? ' · 自动初始化流水线已完成'
                : ` · 自动初始化流水线执行中（${pipe.done}/${pipe.total} 子任务）`)}
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-slate-900/15 hover:bg-slate-900/25 px-2 py-0.5 transition-colors shrink-0"
          >
            继续配置
          </button>
          <button
            type="button"
            onClick={() => void mute()}
            className="rounded bg-slate-900/15 hover:bg-slate-900/25 px-2 py-0.5 transition-colors shrink-0"
          >
            7 天不再提醒
          </button>
        </div>
      )}

      {open && state && (
        <SetupWizard initialState={state} onLater={closeWizard} onNavigate={handleNavigate} onCompleted={handleCompleted} />
      )}
    </>
  );
};
