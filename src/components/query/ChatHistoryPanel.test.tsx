/**
 * P2-10 前端组件测试：对话历史面板（加载/空态/条目徽标/搜索回车/重问/删除/关闭）。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { ConversationItem } from '../../hooks/useConversationHistory';

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

function renderPanel(over: Record<string, unknown> = {}) {
  const props = {
    items: [item()],
    loading: false,
    keyword: '',
    onKeywordChange: vi.fn(),
    onSearch: vi.fn(),
    onClose: vi.fn(),
    onReuse: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  render(<ChatHistoryPanel {...(props as any)} />);
  return props;
}

afterEach(cleanup);

describe('ChatHistoryPanel', () => {
  it('加载中显示加载态', () => {
    renderPanel({ loading: true, items: [] });
    expect(screen.getByText('加载中…')).toBeTruthy();
  });

  it('无条目显示空态文案', () => {
    renderPanel({ items: [] });
    expect(screen.getByText(/该数据源暂无对话历史/)).toBeTruthy();
  });

  it('渲染条目：问题、结论、状态徽标与演示徽标', () => {
    renderPanel({
      items: [item(), item({ id: 2, status: 'FALLBACK', provenance: 'simulated', question: 'q2', answerSummary: '' })],
    });
    expect(screen.getByText('本月拜访多少客户？')).toBeTruthy();
    expect(screen.getByText('共 12 家')).toBeTruthy();
    expect(screen.getByText('成功')).toBeTruthy();
    expect(screen.getByText('降级')).toBeTruthy();
    expect(screen.getByText('演示')).toBeTruthy();
  });

  it('输入关键词回车触发检索，变更回调透传', () => {
    const props = renderPanel();
    const input = screen.getByPlaceholderText('搜索问题 / 结论，回车检索');
    fireEvent.change(input, { target: { value: '拜访' } });
    expect(props.onKeywordChange).toHaveBeenCalledWith('拜访');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onSearch).toHaveBeenCalledWith('');
  });

  it('重问/删除/关闭按钮分别触发对应回调', () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTitle('回填输入框重新提问'));
    expect(props.onReuse).toHaveBeenCalledWith('本月拜访多少客户？');
    fireEvent.click(screen.getByTitle('删除该条对话记录'));
    expect(props.onDelete).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByText('关闭'));
    expect(props.onClose).toHaveBeenCalled();
  });
});
