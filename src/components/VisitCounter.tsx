/**
 * v0.9.107 访问计数器（对外展示）：累计访问 · 今日访问 · 当前在线。
 * - 数据来自公开聚合接口 /api/access/public-stats，不涉及任何用户或问题信息；
 * - 每 60s 自动刷新，请求失败静默隐藏（计数器不影响页面主流程）；
 * - 登录页与侧边栏底部复用，compact 用于空间受限的侧边栏展开态。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, CalendarDays, Eye } from 'lucide-react';

interface PublicStats {
  totalVisits: number;
  todayVisits: number;
  online: number;
}

const REFRESH_MS = 60_000;

const formatCount = (value: number): string => (value >= 10_000 ? `${(value / 10_000).toFixed(1)}万` : value.toLocaleString('zh-CN'));

export const VisitCounter: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [stats, setStats] = useState<PublicStats | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetch('/api/access/public-stats');
      if (!resp.ok) return;
      const data = (await resp.json()) as Partial<PublicStats>;
      setStats({
        totalVisits: Number(data.totalVisits) || 0,
        todayVisits: Number(data.todayVisits) || 0,
        online: Number(data.online) || 0,
      });
    } catch {
      /* 计数器获取失败静默 */
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!stats) return null;

  return (
    <div
      className={`flex items-center justify-center flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-slate-500 ${className}`}
      title="统计口径：同一浏览器会话只计 1 次访问；当前在线为最近 5 分钟有心跳的会话；不采集 IP、浏览器信息或访问明细"
    >
      <span className="inline-flex items-center space-x-1">
        <Eye className="w-3 h-3 text-indigo-400/80" />
        <span>累计访问</span>
        <span className="font-semibold text-slate-300 tabular-nums">{formatCount(stats.totalVisits)}</span>
      </span>
      <span className="text-slate-700">·</span>
      <span className="inline-flex items-center space-x-1">
        <CalendarDays className="w-3 h-3 text-cyan-400/80" />
        <span>今日</span>
        <span className="font-semibold text-slate-300 tabular-nums">{formatCount(stats.todayVisits)}</span>
      </span>
      <span className="text-slate-700">·</span>
      <span className="inline-flex items-center space-x-1">
        <Activity className="w-3 h-3 text-emerald-400/80" />
        <span>在线</span>
        <span className="font-semibold text-slate-300 tabular-nums">{stats.online}</span>
      </span>
    </div>
  );
};
