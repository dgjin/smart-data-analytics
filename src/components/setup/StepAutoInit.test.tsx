/**
 * 向导 Step③ 演示数据一键加载测试（jsdom，v0.9.86 Phase 2）：
 * - 未加载：展示「一键加载」，点击 → POST /api/setup/demo-data → 轮询进度 → 成功后提示就绪并刷新状态；
 * - 409 接管：已有在途加载任务 → 直接挂载其进度轮询；
 * - 已加载：展示「已加载」徽标与「重新加载」按钮。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepAutoInit } from './StepAutoInit';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import type { SetupWizardState } from './setupTypes';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

function jsonRes(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

function envOf(demoLoaded: boolean) {
  return {
    llm: { engine: 'ollama', model: 'qwen', label: 'Ollama qwen' },
    embedding: { model: 'bge-m3' },
    datasources: { total: demoLoaded ? 1 : 0, connected: demoLoaded ? 1 : 0, demoLoaded },
    health: { ok: true, status: 'healthy', checks: {}, timestamp: '2026-09-29T10:00:00Z' },
  };
}

function makeState(over: Partial<SetupWizardState> = {}): SetupWizardState {
  return {
    status: 'in_progress',
    currentStep: 2,
    stepResults: {},
    pipelineTaskId: null,
    skippedUntil: null,
    startedBy: 'admin',
    completedAt: null,
    updatedAt: '2026-09-29T10:00:00Z',
    env: envOf(false),
    ...over,
  };
}

function renderStep(state: SetupWizardState, refreshState = vi.fn().mockResolvedValue(undefined)) {
  return render(
    <StepAutoInit state={state} refreshState={refreshState} onResult={vi.fn()} onReadyChange={vi.fn()} />,
  );
}

/** 通用 mock：rest 优先分派（返回 null 落入默认），默认兜底 /api/datasources（挂载与加载完成后都会补拉清单） */
function mockApi(rest: (url: string) => Response | null) {
  mockedApiFetch.mockImplementation(async (url: string) => {
    const r = rest(String(url));
    if (r) return r;
    if (String(url).includes('/api/datasources')) return jsonRes({ dataSources: [] });
    return jsonRes({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAnalyticsStore.setState({ dataSources: [], activeDataSourceId: '', activeTableId: null });
});

afterEach(() => {
  cleanup();
});

describe('StepAutoInit：演示数据一键加载（v0.9.86）', () => {
  it('未加载：展示「一键加载」；点击 → POST /api/setup/demo-data → 轮询成功提示就绪', async () => {
    mockApi((url) => {
      if (url.includes('/api/setup/demo-data')) return jsonRes({ taskId: 'demo-1' });
      if (url.includes('/api/setup/pipeline/')) {
        return jsonRes({
          taskId: 'demo-1',
          status: 'SUCCESS',
          subtasks: [],
          progress: '完成',
          result: { tables: 3, rows: 926 },
        });
      }
      return null;
    });

    const refreshState = vi.fn().mockResolvedValue(undefined);
    renderStep(makeState(), refreshState);

    fireEvent.click(await screen.findByText('一键加载'));

    await waitFor(() => {
      const call = mockedApiFetch.mock.calls.find(
        ([url, opts]) => String(url).includes('/api/setup/demo-data') && (opts as RequestInit)?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => expect(screen.getByText(/演示数据集已就绪并注册为数据源/)).toBeTruthy());
    expect(refreshState).toHaveBeenCalled();
  });

  it('409：已有在途加载任务 → 接管其进度继续轮询', async () => {
    mockApi((url) => {
      if (url.includes('/api/setup/demo-data')) return jsonRes({ error: '已有加载任务执行中', taskId: 'demo-9' }, false, 409);
      if (url.includes('/api/setup/pipeline/demo-9')) {
        return jsonRes({ taskId: 'demo-9', status: 'RUNNING', subtasks: [], progress: '正在创建演示表 2/3' });
      }
      return null;
    });

    renderStep(makeState());
    fireEvent.click(await screen.findByText('一键加载'));

    await waitFor(() => expect(screen.getByText('正在创建演示表 2/3')).toBeTruthy());
  });

  it('已加载：展示「已加载」徽标与「重新加载」按钮', async () => {
    mockApi(() => null);
    renderStep(makeState({ env: envOf(true) }));

    await waitFor(() => expect(screen.getByText('已加载')).toBeTruthy());
    expect(screen.getByText('重新加载')).toBeTruthy();
    expect(screen.queryByText('一键加载')).toBeNull();
  });
});
