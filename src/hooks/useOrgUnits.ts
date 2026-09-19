/**
 * v0.9.66 组织架构树节点拉取（仅 ADMIN 可访问 /api/admin/org-units）。
 * 供组织架构面板与三处选择器复用；加载失败静默返回空数组，不影响主流程。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import type { OrgUnit } from '../types/analytics';

export function useOrgUnits(enabled = true): {
  units: OrgUnit[];
  loading: boolean;
  refresh: () => Promise<OrgUnit[]>;
} {
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<OrgUnit[]> => {
    try {
      const res = await apiFetch('/api/admin/org-units');
      if (!res.ok) return [];
      const data = await res.json();
      const list = data?.success && Array.isArray(data.units) ? (data.units as OrgUnit[]) : [];
      setUnits(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(async () => {
      setLoading(true);
      await refresh();
      if (!cancelled) setLoading(false);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, refresh]);

  return { units, loading, refresh };
}
