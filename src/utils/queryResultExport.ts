/**
 * v0.9.82 问数结果导出：把单条问数结果（KPI/洞察/图表/明细）导出为 PDF / Word / Markdown 文档。
 *
 * 链路：前端截图图表（domSnapshot）→ buildQueryExportPayload 组装载荷 →
 * POST /api/export/query-doc（服务端归一化截断 + 注入导出人水印 + 审计）→ blob 下载。
 * 文档定位「分析摘要」：明细前 100 行 / 前 12 列；完整数据请走「导出 CSV」通道（带下载审批保护）。
 *
 * v0.9.92 下载兜底：浏览器对同一页面会话内连续的非用户手势自动下载（a.click() 触发）会静默
 * 拦截（首个文件正常、后续无感知丢失，UI 仍提示成功）→ 成功结果额外返回 downloadUrl/filename，
 * 由调用方渲染「保存文件」按钮手动兜底（用户点击属真实手势，下载必放行）。
 */
import { apiFetch } from '../api/client';
import { QueryResultData } from '../types/analytics';
import { getErrorMessage } from './errorUtils';
import { captureElementPng, findCaptureBackground } from './domSnapshot';

export type QueryExportFormat = 'pdf' | 'word' | 'md';

/** 导出按钮元数据（顺序即界面展示顺序；ext 用于服务端文件名缺失时的兜底命名） */
export const QUERY_EXPORT_FORMATS: ReadonlyArray<{ format: QueryExportFormat; label: string; ext: string }> = [
  { format: 'pdf', label: 'PDF', ext: '.pdf' },
  { format: 'word', label: 'Word', ext: '.docx' },
  { format: 'md', label: 'MD', ext: '.md' },
];

/** 与服务端 server/query/queryExport.ts 一致的截断阈值（前端预截断，减小请求体） */
const MAX_EXPORT_ROWS = 100;
const MAX_EXPORT_COLUMNS = 12;

export interface QueryExportOutcome {
  ok: boolean;
  message: string;
  /** 成功时返回的 blob 下载地址（不自动释放）：浏览器拦截连续自动下载时供 UI「保存文件」手动兜底 */
  downloadUrl?: string;
  /** 成功时的最终文件名（服务端 Content-Disposition 优先，缺失时用本地兜底命名） */
  filename?: string;
}

/** KPI 数值格式化：对齐 KPIStats 展示规则（整数千分位 / 非整数两位小数 / 字符串原样） */
export function formatKpiValue(value: string | number | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value === null || value === undefined ? '' : String(value);
}

/** KPI 说明列：环比变化 + 副文本（对齐卡片内 change 徽标与 subtext 行的信息） */
export function formatKpiNote(metric: { change?: number; subtext?: string }): string {
  const parts: string[] = [];
  if (typeof metric.change === 'number' && Number.isFinite(metric.change)) {
    parts.push(metric.change > 0 ? `环比 +${metric.change}%` : `环比 ${metric.change}%`);
  }
  if (metric.subtext) parts.push(metric.subtext);
  return parts.join(' · ');
}

export interface QueryExportPayloadInput {
  /** 提问原文（导出文档标题） */
  title: string;
  dataSourceName: string;
  dataSourceId: string;
  /** 数据来源（消息徽标语义：live=真实数据 / simulated=演示数据） */
  provenance?: 'live' | 'simulated';
  result: QueryResultData;
  chartImageBase64?: string;
}

/** 组装服务端载荷（纯函数便于单测）：中文表头映射、KPI 格式化、明细投影与预截断 */
export function buildQueryExportPayload(input: QueryExportPayloadInput): Record<string, unknown> {
  const { title, dataSourceName, dataSourceId, provenance, result, chartImageBase64 } = input;
  const columns = Array.isArray(result.columns) ? result.columns.slice(0, MAX_EXPORT_COLUMNS) : [];
  const rows = columns.length
    ? (result.rows || []).slice(0, MAX_EXPORT_ROWS).map((row) =>
        columns.map((col) => {
          const v = row[col];
          if (v === null || v === undefined) return '';
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        }),
      )
    : [];
  return {
    title,
    dataSourceName,
    dataSourceId,
    dataProvenance: provenance,
    sql: result.generatedSQL || '',
    aiExplanation: result.aiExplanation || '',
    kpiMetrics: (result.kpiMetrics || []).slice(0, 8).map((m) => ({
      label: m.label,
      value: formatKpiValue(m.value),
      note: formatKpiNote(m),
    })),
    keyInsights: (result.keyInsights || []).slice(0, 8),
    chartTitle: result.chartConfig?.title || '',
    ...(chartImageBase64 ? { chartImageBase64 } : {}),
    columns: columns.map((col) => result.columnNames?.[col] || col),
    rows,
    totalCount: result.totalCount,
  };
}

/** 从 Content-Disposition 解析服务端文件名（filename*=UTF-8'' 优先，含兜底引号形式） */
export function resolveServerFilename(header: string | null): string {
  if (!header) return '';
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* 非法编码走下方兜底 */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

/** 兜底文件名（服务端头缺失时）：与 buildQueryExportFilename 规则一致 */
function fallbackFilename(title: string, format: QueryExportFormat): string {
  const safe = (title || '问数结果').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const ext = QUERY_EXPORT_FORMATS.find((f) => f.format === format)?.ext || `.${format}`;
  return `${safe}_问数结果_${new Date().toISOString().slice(0, 10)}${ext}`;
}

/** 文件大小展示（KB/MB） */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface ExportQueryResultOptions extends Omit<QueryExportPayloadInput, 'chartImageBase64'> {
  format: QueryExportFormat;
  /** 消息根元素：限定查找图表节点 [data-query-chart-root]，避免命中其他历史消息的图表 */
  rootEl: HTMLElement | null;
}

/** 导出动作：截图（有图表时）→ 请求服务端 → 浏览器下载；返回 {ok,message} 供界面提示 */
export async function exportQueryResult(opts: ExportQueryResultOptions): Promise<QueryExportOutcome> {
  const { format, rootEl, ...payloadInput } = opts;
  try {
    let chartImageBase64: string | undefined;
    const chartRoot = rootEl?.querySelector<HTMLElement>('[data-query-chart-root]');
    if (chartRoot) {
      const png = await captureElementPng(chartRoot, findCaptureBackground(chartRoot));
      if (png) chartImageBase64 = png;
    }
    const res = await apiFetch('/api/export/query-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, ...buildQueryExportPayload({ ...payloadInput, chartImageBase64 }) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: data.error || `导出失败（${res.status}）` };
    }
    const blob = await res.blob();
    const filename = resolveServerFilename(res.headers.get('Content-Disposition')) || fallbackFilename(opts.title, format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 不在此处 revoke（v0.9.92）：保留 blob URL 供 UI「保存文件」手动兜底，
    // 由调用方在下次导出或组件卸载时释放，避免内存泄漏
    const label = QUERY_EXPORT_FORMATS.find((f) => f.format === format)?.label || format.toUpperCase();
    return { ok: true, message: `${label} 已导出（${formatBytes(blob.size)}，含溯源水印）`, downloadUrl: url, filename };
  } catch (err) {
    return { ok: false, message: getErrorMessage(err) || '导出失败' };
  }
}
