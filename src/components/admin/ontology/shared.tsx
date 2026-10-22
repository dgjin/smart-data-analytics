/**
 * 业务本体面板共享类型与工具（v0.9.114 拆分自 OntologyPanel.tsx）
 */
import { apiFetch } from '../../../api/client';
import type { TableSchema } from '../../../types/analytics';
import type { OntologyAssetType } from '../../../types/ontology';

/** 统一 API 调用：非 2xx 抛带服务端 error 的异常 */
export async function callApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string })?.error;
    throw new Error(msg || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

export interface SectionProps {
  dataSourceId: string;
  tables: TableSchema[];
  showNotice: (type: 'success' | 'error', text: string) => void;
  onChanged: () => void;
  openVersions: (assetType: OntologyAssetType, id: number, title: string) => void;
}

export interface VersionTarget {
  assetType: OntologyAssetType;
  id: number;
  title: string;
}

export const ACTION_LABELS: Record<string, string> = {
  CREATE: '创建',
  UPDATE: '更新',
  DELETE: '删除',
  RESTORE: '回滚',
};

/** 版本快照 → 一行可读摘要（替代原始 JSON 截断；完整快照仍在 title 中可查看） */
export function summarizeSnapshot(assetType: OntologyAssetType, snapshot: Record<string, unknown>): string {
  const s = snapshot || {};
  const status = typeof s.status === 'string' ? s.status : '';
  const text = (v: unknown, max = 40) => (typeof v === 'string' && v ? v.slice(0, max) : '');

  if (assetType === 'entity') {
    return [
      text(s.name),
      text(s.entityType),
      Array.isArray(s.aliases) && s.aliases.length > 0 ? `别名 ${s.aliases.join('、')}` : '',
      status ? `状态 ${status}` : '',
      text(s.description),
    ].filter(Boolean).join(' · ');
  }

  if (assetType === 'relation') {
    const fromCols = Array.isArray(s.fromColumns) ? s.fromColumns.join(',') : '';
    const toCols = Array.isArray(s.toColumns) ? s.toColumns.join(',') : '';
    return [
      `${text(s.fromTable) || '?'}(${fromCols}) → ${text(s.toTable) || '?'}(${toCols})`,
      text(s.cardinality) ? `基数 ${s.cardinality}` : '',
      text(s.purpose),
      status ? `状态 ${status}` : '',
    ].filter(Boolean).join(' · ');
  }

  return [
    text(s.name),
    Array.isArray(s.levels) ? s.levels.join(' > ') : '',
    status ? `状态 ${status}` : '',
  ].filter(Boolean).join(' · ');
}
