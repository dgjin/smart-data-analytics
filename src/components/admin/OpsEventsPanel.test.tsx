/**
 * 系统管理 · 运维事件面板测试：列表与摘要渲染、过滤重载、受理动作、空态与失败态。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpsEventsPanel } from './OpsEventsPanel';
import { apiFetch } from '../../api/client';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

function eventPayload(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    severity: 'CRITICAL',
    source: 'audit',
    category: 'query_failure',
    entity_type: 'user',
    entity_id: 'zhangsan',
    message: '问数接口失败：LLM 超时',
    trace_id: 'trace-abc',
    status: 'NEW',
    dedup_count: 3,
    handled_by: '',
    handled_at: null,
    created_at: '2026-09-30T10:00:00.000Z',
    last_seen_at: '2026-09-30T10:05:00.000Z',
    ...over,
  };
}

function listPayload(over: Record<string, unknown> = {}) {
  return {
    success: true,
    events: [
      eventPayload(),
      eventPayload({
        id: 2,
        severity: 'WARN',
        source: 'task',
        category: 'task_failure',
        entity_type: 'task',
        entity_id: 'report-9',
        message: '后台任务失败：报告生成超时',
        trace_id: '',
        status: 'RESOLVED',
        dedup_count: 1,
        handled_by: 'admin',
        handled_at: '2026-09-30T10:08:00.000Z',
      }),
    ],
    nextCursor: null,
    ...over,
  };
}

function summaryPayload(over: Record<string, unknown> = {}) {
  return {
    success: true,
    byStatus: [
      { status: 'NEW', cnt: 1 },
      { status: 'ACK', cnt: 0 },
      { status: 'RESOLVED', cnt: 2 },
    ],
    last24h: [
      { category: 'query_failure', severity: 'CRITICAL', cnt: 1 },
      { category: 'task_failure', severity: 'WARN', cnt: 1 },
    ],
    ...over,
  };
}

/** 按 URL 分流：摘要 / 动作（ack·resolve）/ 列表 */
function mockRoutes(list = listPayload(), summary = summaryPayload()) {
  mockedApiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/ops/events/summary')) return { ok: true, json: async () => summary } as any;
    if (u.includes('/ack') || u.includes('/resolve')) {
      return { ok: true, json: async () => ({ success: true, id: 1, status: 'ACK' }) } as any;
    }
    return { ok: true, json: async () => list } as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRoutes();
});

afterEach(cleanup);

describe('OpsEventsPanel', () => {
  it('加载后渲染摘要 KPI 与事件列表', async () => {
    render(<OpsEventsPanel />);

    expect(await screen.findByText('问数接口失败：LLM 超时')).toBeTruthy();
    // 摘要 KPI：NEW=1 / RESOLVED=2 / 近 24h 新增 2（部分数值与列表重叠，用 getAllByText 断存在）
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
    // 状态徽章与来源标签（KPI 标签「待处理」与徽章并存；来源下拉的 option 与行内标签同名）
    expect(screen.getAllByText('待处理').length).toBeGreaterThan(1);
    expect(screen.getAllByText('问数失败').length).toBeGreaterThan(1);
    expect(screen.getByText('×3 合并')).toBeTruthy();
    expect(screen.getByText('后台任务失败：报告生成超时')).toBeTruthy();
  });

  it('切换严重级过滤后按 severity 重新请求', async () => {
    render(<OpsEventsPanel />);
    await screen.findByText('问数接口失败：LLM 超时');

    fireEvent.change(screen.getByTitle('按严重级过滤'), { target: { value: 'ERROR' } });
    await waitFor(() =>
      expect(
        mockedApiFetch.mock.calls.some(([u]) => String(u).includes('severity=ERROR'))
      ).toBe(true)
    );
  });

  it('点击受理调用 ack 端点并刷新列表', async () => {
    render(<OpsEventsPanel />);
    await screen.findByText('问数接口失败：LLM 超时');

    fireEvent.click(screen.getByText('受理'));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/ops/events/1/ack',
        expect.objectContaining({ method: 'POST' })
      )
    );
    // 动作后回刷：出现成功提示
    expect(await screen.findByText('事件 #1 已受理')).toBeTruthy();
  });

  it('无事件时展示空态引导', async () => {
    mockRoutes(
      listPayload({ events: [] }),
      summaryPayload({ byStatus: [], last24h: [] })
    );
    render(<OpsEventsPanel />);

    expect(await screen.findByText('暂无运维事件，系统运行健康')).toBeTruthy();
  });

  it('请求失败展示错误与重试入口', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('网络异常'));
    render(<OpsEventsPanel />);

    expect(await screen.findByText('网络异常')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    expect(await screen.findByText('问数接口失败：LLM 超时')).toBeTruthy();
  });
});
