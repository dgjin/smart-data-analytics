/**
 * 首启初始化向导组件测试（jsdom）：
 * - SetupWizard：断点续做定位、Step① 自动探测后就绪、跳过此步持久化并前进；
 * - SetupWizardHost：L1 自动弹出 → 稍后配置转 L2 横幅 → 7 天不再提醒（POST /skip）。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupWizard } from './SetupWizard';
import { SetupWizardHost } from './SetupWizardHost';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { SETUP_WIZARD_OPEN_EVENT, type SetupWizardState } from './setupTypes';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

function jsonRes(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

function makeState(over: Partial<SetupWizardState> = {}): SetupWizardState {
  return {
    status: 'in_progress',
    currentStep: 0,
    stepResults: {},
    pipelineTaskId: null,
    skippedUntil: null,
    startedBy: 'admin',
    completedAt: null,
    updatedAt: '2026-09-29T10:00:00Z',
    ...over,
  };
}

/** 通用路由 mock：probe / step / state / datasources / checklist / skip */
function mockRoutes(state: SetupWizardState) {
  mockedApiFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/setup/probe')) {
      const kind = (JSON.parse(String(opts?.body || '{}')) as { kind?: string }).kind;
      return kind === 'llm'
        ? jsonRes({ ok: true, engine: 'ollama', model: 'qwen', label: 'Ollama qwen', latencyMs: 1200, sample: 'PONG' })
        : jsonRes({ ok: true, model: 'bge-m3', dims: 1024, latencyMs: 42 });
    }
    if (u.includes('/api/setup/step')) return jsonRes({ ok: true });
    if (u.includes('/api/setup/state')) return jsonRes(state);
    if (u.includes('/api/setup/pipeline/')) {
      return jsonRes({ taskId: 't1', status: 'SUCCESS', subtasks: [] });
    }
    if (u.includes('/api/setup/skip')) return jsonRes({ ok: true });
    if (u.includes('/api/setup/checklist')) return jsonRes([]);
    if (u.includes('/api/datasources')) return jsonRes({ dataSources: [] });
    return jsonRes({});
  });
}

function renderWizard(state: SetupWizardState) {
  return render(
    <SetupWizard initialState={state} onLater={vi.fn()} onNavigate={vi.fn()} onCompleted={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  useAnalyticsStore.setState({ dataSources: [], activeDataSourceId: '', activeTableId: null });
});

afterEach(() => {
  cleanup();
});

describe('SetupWizard：断点续做与导航', () => {
  it('已存快照的步骤回显：定位到第一个未完成步骤（③ 自动初始化）', async () => {
    mockRoutes(
      makeState({
        stepResults: {
          '0': { llm: { ok: true }, embedding: { ok: true } },
          '1': { llm: { ok: true, latencyMs: 100, sample: 'PONG' } },
        },
      }),
    );
    renderWizard(
      makeState({
        stepResults: {
          '0': { llm: { ok: true }, embedding: { ok: true } },
          '1': { llm: { ok: true, latencyMs: 100, sample: 'PONG' } },
        },
      }),
    );

    await waitFor(() => expect(screen.getByText('开始执行')).toBeTruthy());
    // ③ 可跳过；步骤轨与顶栏计数正常
    expect(screen.getByText('跳过此步')).toBeTruthy();
    expect(screen.getByText('2/5')).toBeTruthy();
  });

  it('Step① 进入即自动探测：完成后「下一步」可用且不提供跳过；前进后 ② 出现跳过', async () => {
    const state = makeState({ stepResults: {} });
    mockRoutes(state);
    renderWizard(state);

    // ① 不出现「跳过此步」
    expect(screen.queryByText('跳过此步')).toBeNull();

    // 探测完成（llm/embedding 结果渲染）→ 下一步可用
    await waitFor(() => expect(screen.getByText(/连通 · 返回/)).toBeTruthy());
    const nextBtn = screen.getByText('下一步').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(nextBtn.disabled).toBe(false));

    // 前进到 Step②
    fireEvent.click(nextBtn);
    await waitFor(() => expect(screen.getByText('测试对话')).toBeTruthy());
    expect(screen.getByText('跳过此步')).toBeTruthy();
  });

  it('跳过此步：保存 {step, result.skipped} 并前进到下一步', async () => {
    const state = makeState({ stepResults: { '0': { llm: { ok: true }, embedding: { ok: true } } } });
    mockRoutes(state);
    renderWizard(state);

    await waitFor(() => expect(screen.getByText('测试对话')).toBeTruthy());
    fireEvent.click(screen.getByText('跳过此步'));

    await waitFor(() => {
      const call = mockedApiFetch.mock.calls.find(([url]) => String(url).includes('/api/setup/step'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call?.[1] as RequestInit).body)) as { step: number; result: { skipped?: boolean } };
      expect(body.step).toBe(1);
      expect(body.result.skipped).toBe(true);
    });
    // 前进到 Step③
    await waitFor(() => expect(screen.getByText('开始执行')).toBeTruthy());
  });
});

describe('SetupWizardHost：L1 自动弹出与 L2 横幅', () => {
  it('自动弹出向导 → 稍后配置转横幅（含进度）→ 7 天不再提醒后横幅消失', async () => {
    const state = makeState({
      stepResults: {
        '0': { llm: { ok: true }, embedding: { ok: true } },
        '1': { llm: { ok: true } },
        '2': { dataSourceId: 'ds1' },
      },
    });
    mockRoutes(state);
    render(<SetupWizardHost />);

    // L1 自动弹出（定位到 Step④ 待办确认，清单已加载完毕）
    await waitFor(() => expect(screen.getByText('首启初始化向导')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('待办事项均已处理完毕。')).toBeTruthy());

    // 稍后配置 → 关闭覆盖层，出现 L2 横幅（进度 3/5）
    fireEvent.click(screen.getByText('稍后配置'));
    await waitFor(() => expect(screen.getByText(/系统初始化进度 3\/5/)).toBeTruthy());
    expect(screen.queryByText('首启初始化向导')).toBeNull();

    // 7 天不再提醒 → POST /skip 且横幅消失
    fireEvent.click(screen.getByText('7 天不再提醒'));
    await waitFor(() => {
      const call = mockedApiFetch.mock.calls.find(
        ([url, opts]) => String(url).includes('/api/setup/skip') && (opts as RequestInit)?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByText(/系统初始化进度/)).toBeNull());
  });

  it('向导已完成时不弹出、不显示横幅', async () => {
    mockRoutes(makeState({ status: 'completed' }));
    render(<SetupWizardHost />);
    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled());
    expect(screen.queryByText('首启初始化向导')).toBeNull();
    expect(screen.queryByText(/系统初始化进度/)).toBeNull();
  });

  it('收到 L3 卡片唤起事件 → 打开向导覆盖层而不自动弹出标记', async () => {
    // 预置会话标记：抑制自动弹出，仅验证事件唤起
    sessionStorage.setItem('setup_wizard_l1_shown', '1');
    mockRoutes(makeState({ stepResults: { '0': {} } }));
    render(<SetupWizardHost />);
    await waitFor(() => expect(screen.getByText(/系统初始化进度 1\/5/)).toBeTruthy());
    expect(screen.queryByText('首启初始化向导')).toBeNull();

    window.dispatchEvent(new CustomEvent(SETUP_WIZARD_OPEN_EVENT));
    await waitFor(() => expect(screen.getByText('首启初始化向导')).toBeTruthy());
  });
});
