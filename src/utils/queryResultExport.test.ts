/**
 * v0.9.82 问数结果导出前端工具测试：载荷组装（中文表头/明细投影与截断/KPI 格式化）、
 * Content-Disposition 文件名解析、导出动作成功/失败分支（mock apiFetch 与图表截图）。
* @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  captureElementPng: vi.fn(),
  findCaptureBackground: vi.fn(() => '#0f172a'),
}));
vi.mock('../api/client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('./domSnapshot', () => ({
  captureElementPng: mocks.captureElementPng,
  findCaptureBackground: mocks.findCaptureBackground,
}));

import { QueryResultData } from '../types/analytics';
import {
  buildQueryExportPayload,
  exportQueryResult,
  formatKpiNote,
  formatKpiValue,
  resolveServerFilename,
} from './queryResultExport';

function result(partial: Partial<QueryResultData> = {}): QueryResultData {
  return {
    columns: ['month', 'amt'],
    rows: [
      { month: '1月', amt: 1234.5 },
      { month: '2月', amt: null },
    ],
    totalCount: 2,
    executionTimeMs: 12,
    columnNames: { month: '月份', amt: '金额(万元)' },
    generatedSQL: 'SELECT 1',
    aiExplanation: 'AI 解读文本',
    keyInsights: ['洞察一'],
    ...partial,
  };
}

describe('formatKpiValue / formatKpiNote', () => {
  it('整数千分位、非整数两位小数、字符串原样、空值空串', () => {
    expect(formatKpiValue(1234567)).toBe('1,234,567');
    expect(formatKpiValue(1234.5)).toBe('1,234.50');
    expect(formatKpiValue('12.3万元')).toBe('12.3万元');
    expect(formatKpiValue(null)).toBe('');
    expect(formatKpiValue(undefined)).toBe('');
  });

  it('环比正数带加号、负数/零原样；subtext 以 · 拼接', () => {
    expect(formatKpiNote({ change: 3 })).toBe('环比 +3%');
    expect(formatKpiNote({ change: -2 })).toBe('环比 -2%');
    expect(formatKpiNote({ change: 0 })).toBe('环比 0%');
    expect(formatKpiNote({ change: 5, subtext: '较上月' })).toBe('环比 +5% · 较上月');
    expect(formatKpiNote({})).toBe('');
  });
});

describe('buildQueryExportPayload', () => {
  it('中文表头映射与行投影：null → 空串，对象 JSON 序列化', () => {
    const payload = buildQueryExportPayload({
      title: '本月拜访量',
      dataSourceName: '客户源',
      dataSourceId: 'ds_1',
      provenance: 'live',
      result: result({ rows: [{ month: '1月', amt: { v: 1 } }, { month: '2月', amt: null }] }),
    });
    expect(payload.title).toBe('本月拜访量');
    expect(payload.dataSourceName).toBe('客户源');
    expect(payload.dataSourceId).toBe('ds_1');
    expect(payload.dataProvenance).toBe('live');
    expect(payload.columns).toEqual(['月份', '金额(万元)']);
    expect(payload.rows).toEqual([
      ['1月', '{"v":1}'],
      ['2月', ''],
    ]);
    expect(payload.totalCount).toBe(2);
  });

  it('明细预截断：行 100 / 列 12（与服务端阈值一致）', () => {
    const columns = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 130 }, (_, r) => Object.fromEntries(columns.map((c, ci) => [c, `${r}-${ci}`])));
    const payload = buildQueryExportPayload({
      title: 't',
      dataSourceName: '',
      dataSourceId: '',
      result: result({ columns, rows, totalCount: 130, columnNames: undefined }),
    });
    expect((payload.columns as string[]).length).toBe(12);
    expect((payload.rows as string[][]).length).toBe(100);
    // 无 columnNames 时兜底用原始列名
    expect((payload.columns as string[])[0]).toBe('c0');
  });

  it('KPI 格式化与图表图片透传；无图片时不含 chartImageBase64 字段', () => {
    const base = {
      title: 't',
      dataSourceName: '',
      dataSourceId: '',
      result: result({
        kpiMetrics: [
          { label: '拜访数', value: 1234, change: 3.2, subtext: '环比口径' },
          { label: '客单价', value: '12.5万' },
        ],
      }),
    };
    const withChart = buildQueryExportPayload({ ...base, chartImageBase64: 'data:image/png;base64,AAAA' });
    expect(withChart.chartImageBase64).toBe('data:image/png;base64,AAAA');
    expect(withChart.kpiMetrics).toEqual([
      { label: '拜访数', value: '1,234', note: '环比 +3.2% · 环比口径' },
      { label: '客单价', value: '12.5万', note: '' },
    ]);
    const withoutChart = buildQueryExportPayload(base);
    expect('chartImageBase64' in withoutChart).toBe(false);
  });
});

describe('resolveServerFilename', () => {
  it('解析 filename*=UTF-8 编码与引号兜底形式', () => {
    expect(resolveServerFilename("attachment; filename*=UTF-8''%E9%97%AE%E6%95%B0%E7%BB%93%E6%9E%9C.pdf")).toBe('问数结果.pdf');
    expect(resolveServerFilename('attachment; filename="report.docx"')).toBe('report.docx');
    expect(resolveServerFilename(null)).toBe('');
  });
});

describe('exportQueryResult', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.captureElementPng.mockReset();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  const okResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'Content-Disposition' ? "attachment; filename*=UTF-8''%E9%97%AE%E6%95%B0%E7%BB%93%E6%9E%9C.pdf" : null) },
    blob: async () => new Blob([new Uint8Array(2048)], { type: 'application/pdf' }),
    json: async () => ({}),
  });

  it('有图表节点：截图入载荷 → 请求成功 → 下载并返回成功提示（服务端文件名生效）', async () => {
    mocks.apiFetch.mockResolvedValue(okResponse());
    mocks.captureElementPng.mockResolvedValue('data:image/png;base64,SHOT');
    const root = document.createElement('div');
    const chartNode = document.createElement('div');
    chartNode.setAttribute('data-query-chart-root', '');
    root.appendChild(chartNode);

    const outcome = await exportQueryResult({
      format: 'pdf',
      title: '本月拜访量',
      dataSourceName: '客户源',
      dataSourceId: 'ds_1',
      provenance: 'live',
      result: result(),
      rootEl: root,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('PDF 已导出');
    expect(mocks.captureElementPng).toHaveBeenCalledWith(root.firstElementChild, '#0f172a');
    const [path, init] = mocks.apiFetch.mock.calls[0];
    expect(path).toBe('/api/export/query-doc');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.format).toBe('pdf');
    expect(body.chartImageBase64).toBe('data:image/png;base64,SHOT');
    expect(body.columns).toEqual(['月份', '金额(万元)']);
    // 下载锚点已清理
    expect(document.querySelectorAll('a').length).toBe(0);
  });

  it('无图表节点：不截图且载荷不含 chartImageBase64', async () => {
    mocks.apiFetch.mockResolvedValue(okResponse());
    const outcome = await exportQueryResult({
      format: 'md',
      title: 't',
      dataSourceName: '',
      dataSourceId: '',
      result: result(),
      rootEl: document.createElement('div'),
    });
    expect(outcome.ok).toBe(true);
    expect(mocks.captureElementPng).not.toHaveBeenCalled();
    const body = JSON.parse((mocks.apiFetch.mock.calls[0][1] as RequestInit).body as string);
    expect('chartImageBase64' in body).toBe(false);
  });

  it('服务端 4xx：返回服务端错误文案且不触发下载', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ error: '导出参数无效（缺少提问原文）' }),
    });
    const outcome = await exportQueryResult({
      format: 'word',
      title: 't',
      dataSourceName: '',
      dataSourceId: '',
      result: result(),
      rootEl: null,
    });
    expect(outcome).toEqual({ ok: false, message: '导出参数无效（缺少提问原文）' });
    expect((URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }).createObjectURL).not.toHaveBeenCalled();
  });

  it('网络异常：兜底错误提示不抛出', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('Failed to fetch'));
    const outcome = await exportQueryResult({
      format: 'md',
      title: 't',
      dataSourceName: '',
      dataSourceId: '',
      result: result(),
      rootEl: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Failed to fetch');
  });
});
