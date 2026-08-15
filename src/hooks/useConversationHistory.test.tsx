/**
 * P2-10 前端 hook 测试：对话历史管理（拉取/搜索/删除/导出/错误降级/切源自适应）。
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConversationHistory, ConversationItem } from './useConversationHistory';
import { ChatMessage } from '../types/analytics';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  buildConversationMarkdown: vi.fn(() => 'exported-md'),
  downloadMarkdownFile: vi.fn(),
}));
vi.mock('../api/client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('../utils/conversationExport', () => ({
  buildConversationMarkdown: mocks.buildConversationMarkdown,
  downloadMarkdownFile: mocks.downloadMarkdownFile,
}));

function item(over: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: 1,
    question: '本月拜访多少客户？',
    sql: 'SELECT 1',
    answerSummary: '共 12 家',
    status: 'SUCCESS',
    provenance: 'real',
    createdAt: '2026-08-01T10:00:00Z',
    ...over,
  };
}

const messages: ChatMessage[] = [{ id: 'm1', role: 'user', content: '问', timestamp: '2026-08-01T00:00:00Z' }];

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    activeDataSourceId: 'ds_1',
    visibleMessages: messages,
    dataSources: [{ id: 'ds_1', name: '客户拜访管理' }],
    showToast: vi.fn(),
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe('useConversationHistory', () => {
  it('打开面板自动拉取（带 dataSourceId、无 q）并填充列表', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ conversations: [item({ id: 1 }), item({ id: 2, question: 'q2' })] }),
    });
    const showToast = vi.fn();
    const { result } = renderHook(() => useConversationHistory(makeDeps({ showToast })));

    act(() => result.current.toggleHistoryPanel());
    expect(result.current.historyOpen).toBe(true);
    await waitFor(() => expect(result.current.historyLoading).toBe(false));

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/conversations?dataSourceId=ds_1');
    expect(result.current.historyItems).toHaveLength(2);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('关键词搜索以 q 参数透传', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [] }) });
    const { result } = renderHook(() => useConversationHistory(makeDeps()));

    await act(async () => result.current.loadHistory('拜访'));
    const url = mocks.apiFetch.mock.calls[0][0] as string;
    expect(decodeURIComponent(url)).toContain('dataSourceId=ds_1');
    expect(decodeURIComponent(url)).toContain('q=拜访');
  });

  it('网络异常时清空列表并提示加载失败', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [item()] }) });
    const showToast = vi.fn();
    const { result } = renderHook(() => useConversationHistory(makeDeps({ showToast })));
    await act(async () => result.current.loadHistory(''));

    mocks.apiFetch.mockRejectedValueOnce(new Error('net'));
    await act(async () => result.current.loadHistory(''));

    expect(result.current.historyItems).toEqual([]);
    expect(showToast).toHaveBeenCalledWith('对话历史加载失败');
    expect(result.current.historyLoading).toBe(false);
  });

  it('响应非 ok 或字段缺失时安全置空', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'x' }) });
    const { result } = renderHook(() => useConversationHistory(makeDeps()));
    await act(async () => result.current.loadHistory(''));
    expect(result.current.historyItems).toEqual([]);
  });

  it('删除成功移除对应条目，失败透传服务端错误文案', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ conversations: [item({ id: 1 }), item({ id: 2 })] }),
    });
    const showToast = vi.fn();
    const { result } = renderHook(() => useConversationHistory(makeDeps({ showToast })));
    await act(async () => result.current.loadHistory(''));

    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await act(async () => result.current.handleDeleteConversation(1));
    expect(result.current.historyItems.map((it) => it.id)).toEqual([2]);
    expect(showToast).toHaveBeenCalledWith('已删除该条对话记录');

    mocks.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: '权限不足' }) });
    await act(async () => result.current.handleDeleteConversation(2));
    expect(showToast).toHaveBeenCalledWith('权限不足');
  });

  it('导出：空消息提示，有消息则按当前数据源名称下载', async () => {
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useConversationHistory(makeDeps({ visibleMessages: [], showToast })),
    );
    act(() => result.current.handleExportConversation());
    expect(showToast).toHaveBeenCalledWith('当前数据源暂无可导出的对话');
    expect(mocks.downloadMarkdownFile).not.toHaveBeenCalled();

    const { result: r2 } = renderHook(() =>
      useConversationHistory(makeDeps({ visibleMessages: messages, showToast })),
    );
    act(() => r2.current.handleExportConversation());
    expect(mocks.buildConversationMarkdown).toHaveBeenCalledWith(messages, '客户拜访管理');
    expect(mocks.downloadMarkdownFile).toHaveBeenCalledWith('exported-md', '客户拜访管理');
    expect(showToast).toHaveBeenCalledWith('已开始导出对话 Markdown');
  });

  it('面板打开期间切换数据源自动重拉', async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ conversations: [] }) });
    const { result, rerender } = renderHook(({ dsId }) => useConversationHistory(makeDeps({ activeDataSourceId: dsId })), {
      initialProps: { dsId: 'ds_1' },
    });

    act(() => result.current.toggleHistoryPanel());
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));

    rerender({ dsId: 'ds_2' });
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    expect(mocks.apiFetch.mock.calls[1][0]).toContain('dataSourceId=ds_2');
  });
});
