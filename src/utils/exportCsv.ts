import { apiFetch } from '../api/client';

/**
 * P2-12 DLP 统一导出通道：前端 CSV 导出一律走服务端 /api/export/csv。
 * - 服务端自动嵌入水印（导出人/部门/时间），全程审计
 * - 行数超阈值（默认 5000）且非 ADMIN → 202 进入下载审批流
 */
export interface ServerCsvExportResult {
  ok: boolean;
  /** 审批中（202）时为 true */
  approvalRequired?: boolean;
  message: string;
}

export async function downloadServerCsv(opts: {
  title: string;
  /** 数据列 key（与 rows 对象的键对应） */
  columns: string[];
  /** 列展示名映射（导出表头使用） */
  columnLabels?: Record<string, string>;
  rows: Record<string, unknown>[];
  dataSourceId?: string;
}): Promise<ServerCsvExportResult> {
  const { title, columns, columnLabels, rows, dataSourceId } = opts;
  if (rows.length === 0) return { ok: false, message: '无可导出数据' };
  try {
    const res = await apiFetch('/api/export/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title || 'export',
        columns: columns.map((c) => columnLabels?.[c] || c),
        rows: rows.map((r) => columns.map((c) => r[c] ?? '')),
        dataSourceId,
      }),
    });
    if (res.status === 202) {
      const data = await res.json();
      return { ok: false, approvalRequired: true, message: data.error || '已提交下载审批' };
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: data.error || `导出失败（${res.status}）` };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'export'}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { ok: true, message: `已导出 CSV（${rows.length} 行，含溯源水印）` };
  } catch (err: any) {
    return { ok: false, message: err?.message || '导出失败' };
  }
}
