/**
 * v0.4.8 数据版本监测 hook：轮询数据源 data-version 端点，
 * 检测到底层数据变化（首轮建基线不触发）时回调，供看板/报表自主更新。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';
import { DataVersionWatcher } from '../utils/dataVersionWatcher';

export const DATA_VERSION_POLL_MS = 60_000;

export function useDataVersion(
  dataSourceId: string | undefined,
  onDataChanged: (version: string) => void,
  intervalMs: number = DATA_VERSION_POLL_MS,
): { lastVersion: string | null; lastCheckedAt: string | null } {
  const [lastVersion, setLastVersion] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const watcherRef = useRef<DataVersionWatcher>(new DataVersionWatcher());
  // 回调用 ref 承接，避免消费方闭包导致轮询重启
  const callbackRef = useRef(onDataChanged);
  callbackRef.current = onDataChanged;

  useEffect(() => {
    watcherRef.current.reset();
    if (!dataSourceId) {
      setLastVersion(null);
      setLastCheckedAt(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/datasources/${encodeURIComponent(dataSourceId)}/data-version`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const version = typeof data.version === 'string' ? data.version : null;
        if (version) {
          setLastVersion(version);
          setLastCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        }
        if (watcherRef.current.feed(version)) callbackRef.current(version);
      } catch {
        // 探测失败静默跳过本轮，不影响下一轮
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dataSourceId, intervalMs]);

  return { lastVersion, lastCheckedAt };
}
