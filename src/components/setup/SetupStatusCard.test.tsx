/**
 * 系统管理 L3 入口卡片测试（jsdom）：
 * - 未完成：显示进度与 [继续配置]，点击广播 SETUP_WIZARD_OPEN_EVENT；
 * - 已完成：转为「系统体检」，显示就绪判定四态，[重新检测] 重新拉取状态。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupStatusCard } from './SetupStatusCard';
import { apiFetch } from '../../api/client';
import { SETUP_WIZARD_OPEN_EVENT, type SetupWizardState } from './setupTypes';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('SetupStatusCard：L3 入口卡片', () => {
  it('向导未完成：显示进度 N/5，[继续配置] 广播唤起事件', async () => {
    mockedApiFetch.mockResolvedValue(
      jsonRes(makeState({ stepResults: { '0': {}, '1': {}, '2': {} } })),
    );
    const onOpen = vi.fn();
    window.addEventListener(SETUP_WIZARD_OPEN_EVENT, onOpen);

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText(/首启初始化向导 · 进度 3\/5/)).toBeTruthy());

    fireEvent.click(screen.getByText('继续配置'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SETUP_WIZARD_OPEN_EVENT, onOpen);
  });

  it('向导已完成：转为系统体检（就绪判定 + 重新检测再拉取）', async () => {
    mockedApiFetch.mockResolvedValue(
      jsonRes(
        makeState({
          status: 'completed',
          stepResults: { '1': { llm: { ok: true } } },
          summary: { datasources: 1, tables: 10, chunks: 120, examples: 8 },
        }),
      ),
    );

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText('系统体检')).toBeTruthy());
    // 四项就绪判定
    expect(screen.getByText('对话模型')).toBeTruthy();
    expect(screen.getByText('数据源')).toBeTruthy();
    expect(screen.getByText('知识向量化')).toBeTruthy();
    expect(screen.getByText('样例库')).toBeTruthy();
    expect(screen.getByText('已接入 1 个')).toBeTruthy();

    // 重新检测 → 再次请求 /state
    const callsBefore = mockedApiFetch.mock.calls.length;
    fireEvent.click(screen.getByText('重新检测'));
    await waitFor(() => expect(mockedApiFetch.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('状态读取失败：静默不渲染卡片', async () => {
    mockedApiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const { container } = render(<SetupStatusCard />);
    await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
