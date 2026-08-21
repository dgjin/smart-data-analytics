/**
 * 系统管理 · Token 用量查询组件测试：汇总 KPI、按用户过滤、时间范围切换、空态/失败态。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmUsagePanel } from './LlmUsagePanel';
import { apiFetch } from '../../api/client';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

function payload(over: Record<string, unknown> = {}) {
  return {
    days: 7,
    usage: [
      {
        engine: 'ollama',
        model: 'qwen2.5:7b',
        calls: 8,
        okCalls: 7,
        promptTokens: 900,
        completionTokens: 300,
        totalTokens: 1200,
        avgDurationMs: 2400,
      },
    ],
    byUser: [
      {
        userId: 2,
        username: 'zhangsan',
        calls: 6,
        okCalls: 6,
        promptTokens: 800,
        completionTokens: 200,
        totalTokens: 1000,
        avgDurationMs: 2200,
        lastUsedAt: '2026-08-17T10:00:00Z',
      },
      {
        userId: 3,
        username: 'lisi',
        calls: 2,
        okCalls: 1,
        promptTokens: 100,
        completionTokens: 100,
        totalTokens: 200,
        avgDurationMs: 3000,
        lastUsedAt: '2026-08-16T09:00:00Z',
      },
    ],
    ...over,
  };
}

function mockOk(over: Record<string, unknown> = {}) {
  mockedApiFetch.mockResolvedValue({ ok: true, json: async () => payload(over) } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOk();
});

afterEach(cleanup);

describe('LlmUsagePanel', () => {
  it('加载后渲染 KPI 汇总与用户/模型表格', async () => {
    render(<LlmUsagePanel />);

    expect(await screen.findByText('zhangsan')).toBeTruthy();
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/system/llm-usage?days=7');
    expect(screen.getByText('lisi')).toBeTruthy();
    expect(screen.getByText('qwen2.5:7b')).toBeTruthy();
    // KPI：总 Token 1000+200=1200，调用 8 次，输入 900，活跃用户 2（部分数值与表格重叠，用 getAllByText 断存在）
    expect(screen.getAllByText('1,200').length).toBeGreaterThan(0);
    expect(screen.getAllByText('8').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/900/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  it('切换时间范围后按新 days 重新请求', async () => {
    render(<LlmUsagePanel />);
    await screen.findByText('zhangsan');

    fireEvent.click(screen.getByText('近 30 天'));
    await waitFor(() => expect(mockedApiFetch).toHaveBeenLastCalledWith('/api/system/llm-usage?days=30'));
  });

  it('按用户名搜索过滤消耗记录', async () => {
    render(<LlmUsagePanel />);
    await screen.findByText('zhangsan');

    fireEvent.change(screen.getByPlaceholderText('搜索用户名…'), { target: { value: 'zhang' } });
    expect(screen.getByText('zhangsan')).toBeTruthy();
    expect(screen.queryByText('lisi')).toBeNull();
  });

  it('无记录时展示空态文案', async () => {
    mockOk({ byUser: [], usage: [] });
    render(<LlmUsagePanel />);
    expect(await screen.findByText('近 7 天暂无 LLM 调用记录')).toBeTruthy();
  });

  it('请求失败展示错误与重试入口', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('网络异常'));
    render(<LlmUsagePanel />);
    expect(await screen.findByText('网络异常')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    await screen.findByText('zhangsan');
  });
});
