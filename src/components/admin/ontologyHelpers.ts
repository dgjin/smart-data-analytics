/**
 * 业务本体面板共享纯函数与 hook（v0.9.114 P1-2 拆分自 ontologyUi.tsx）：
 * 与组件分文件存放，保证 ontologyUi.tsx 只导出组件、Fast Refresh HMR 边界正确。
 */
import { useEffect } from 'react';
import type { TableSchema } from '../../types/analytics';

/** 面板内四种识别色（与各 Tab 主色一致，类名静态书写供 Tailwind 扫描） */
export type OntologyAccent = 'cyan' | 'amber' | 'emerald' | 'violet';

/** 逗号/顿号/分号/换行分隔 → 去空数组（表列名、别名、层级共用） */
export function listFromText(text: string): string[] {
  return String(text || '')
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按 Schema 取列名（表名大小写不敏感；表不存在返回空数组） */
export function columnsOf(tables: TableSchema[], tableName: string): string[] {
  const key = tableName.trim().toLowerCase();
  const t = tables.find((x) => x.name.toLowerCase() === key);
  return Array.isArray(t?.columns) ? t.columns.map((c) => c.name) : [];
}

/** 表名是否存在于当前数据源 Schema */
export function tableInSchema(tables: TableSchema[], tableName: string): boolean {
  const key = tableName.trim().toLowerCase();
  return tables.some((t) => t.name.toLowerCase() === key);
}

/** Esc 关闭弹层（enabled=false 时不绑定，弹层关闭后自动解绑） */
export function useEscapeKey(enabled: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onEscape]);
}
