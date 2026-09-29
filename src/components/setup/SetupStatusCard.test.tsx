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
import { SETUP_WIZARD_OPEN_EVENT, type SetupChecklistItem, type SetupWizardState } from './setupTypes';

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

/** 按 URL 分派 mock：/state 与 /checklist（v0.9.86 体检待处理项按需拉取） */
function mockRoutes(state: SetupWizardState, checklist: SetupChecklistItem[] = []) {
  mockedApiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/setup/checklist')) return jsonRes(checklist);
    return jsonRes(state);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('SetupStatusCard：L3 入口卡片', () => {
  it('向导未完成：显示进度 N/5，[继续配置] 广播唤起事件', async () => {
    mockRoutes(makeState({ stepResults: { '0': {}, '1': {}, '2': {} } }));
    const onOpen = vi.fn();
    window.addEventListener(SETUP_WIZARD_OPEN_EVENT, onOpen);

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText(/首启初始化向导 · 进度 3\/5/)).toBeTruthy());

    fireEvent.click(screen.getByText('继续配置'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SETUP_WIZARD_OPEN_EVENT, onOpen);
  });

  it('向导已完成：转为系统体检（就绪判定 + 重新检测再拉取）', async () => {
    mockRoutes(
      makeState({
        status: 'completed',
        stepResults: { '1': { llm: { ok: true } } },
        summary: { datasources: 1, tables: 10, chunks: 120, examples: 8 },
      }),
    );

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText('系统体检')).toBeTruthy());
    // 四项就绪判定
    expect(screen.getByText('对话模型')).toBeTruthy();
    expect(screen.getByText('数据源')).toBeTruthy();
    expect(screen.getByText('知识向量化')).toBeTruthy();
    expect(screen.getByText('样例库')).toBeTruthy();
    expect(screen.getByText('已接入 1 个')).toBeTruthy();
    // 无待处理项（checklist 为空）→ 不渲染琥珀区块
    await waitFor(() =>
      expect(mockedApiFetch.mock.calls.some(([url]) => String(url).includes('/api/setup/checklist'))).toBe(true),
    );
    expect(screen.queryByText(/待处理项/)).toBeNull();

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

  it('系统体检：待处理项（todo / warn）在卡片列出，done 项不显示（v0.9.86）', async () => {
    mockRoutes(
      makeState({
        status: 'completed',
        stepResults: { '1': { llm: { ok: true } } },
        summary: { datasources: 1, tables: 10, chunks: 120, examples: 8 },
      }),
      [
        { key: 'rules', title: '铁律配置', detail: '尚未配置业务铁律', status: 'todo' },
        { key: 'thresholds', title: '预警阈值', detail: '仍在使用默认阈值', status: 'warn' },
        { key: 'examples', title: '样例库', detail: '已种子 8 条', status: 'done' },
      ],
    );

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText('待处理项 2')).toBeTruthy());
    expect(screen.getByText('铁律配置')).toBeTruthy();
    expect(screen.getByText('预警阈值')).toBeTruthy();
    // done 项（含 detail）不进入待处理区块（「样例库」为体检网格固定标签，改用 detail 判定）
    expect(screen.queryByText(/已种子 8 条/)).toBeNull();
  });

  it('系统体检：清单全为 done 时不渲染待处理区块', async () => {
    mockRoutes(makeState({ status: 'completed', stepResults: { '1': { llm: { ok: true } } } }), [
      { key: 'rules', title: '铁律配置', detail: '已配置', status: 'done' },
    ]);

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText('系统体检')).toBeTruthy());
    await waitFor(() =>
      expect(mockedApiFetch.mock.calls.some(([url]) => String(url).includes('/api/setup/checklist'))).toBe(true),
    );
    expect(screen.queryByText(/待处理项/)).toBeNull();
  });

  it('系统体检：提供「打开初始化向导」人工入口，点击广播唤起事件（v0.9.87）', async () => {
    mockRoutes(makeState({ status: 'completed', stepResults: { '1': { llm: { ok: true } } } }));
    const onOpen = vi.fn();
    window.addEventListener(SETUP_WIZARD_OPEN_EVENT, onOpen);

    render(<SetupStatusCard />);
    await waitFor(() => expect(screen.getByText('系统体检')).toBeTruthy());
    expect(screen.getByText('打开初始化向导')).toBeTruthy();

    fireEvent.click(screen.getByText('打开初始化向导'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SETUP_WIZARD_OPEN_EVENT, onOpen);
  });
});
