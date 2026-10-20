/**
 * v0.9.107 访问统计面板（管理端）：
 * - 三张指标卡：累计访问 / 今日访问 / 当前在线（60s 自动刷新，可手动刷新）；
 * - 近 7/30 天模块热度横向条形排行（次数 + 占比）；
 * - 底部口径说明：会话去重、在线 5 分钟窗口、不采集 IP/UA/停留时长。
 * 数据来自 GET /api/admin/access/stats（仅 ADMIN，返回聚合计数）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, CalendarDays, Eye, RefreshCw, Users } from 'lucide-react';
import { apiFetch } from '../../../api/client';
import { getErrorMessage } from '../../../utils/errorUtils';

interface ModuleStat {
  module: string;
  hits: number;
  share: number;
}

interface AccessStatsResponse {
  totalVisits: number;
  todayVisits: number;
  online: number;
  days: number;
  updatedAt: string;
  modules: ModuleStat[];
}

/** 模块 key → 中文名（与前端 AppTab 对齐） */
const MODULE_LABELS: Record<string, string> = {
  query: '智能问数',
  reports: '可视化报表',
  'query-reports': '问数报告',
  dashboard: '决策看板',
  flexquery: '灵活查询',
  datasources: '数据源管理',
  admin: '系统管理',
};

const REFRESH_MS = 60_000;

const fmt = (value: number): string => value.toLocaleString('zh-CN');

export const AccessStatsPanel: React.FC = () => {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<AccessStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const resp = await apiFetch(`/api/admin/access/stats?days=${days}`);
      const body = (await resp.json().catch(() => null)) as (AccessStatsResponse & { error?: string }) | null;
      if (!resp.ok || !body) throw new Error(body?.error || `统计获取失败（HTTP ${resp.status}）`);
      setData(body);
    } catch (err) {
      setError(getErrorMessage(err) || '访问统计获取失败');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const cards = [
    { label: '累计访问', value: data?.totalVisits ?? 0, hint: '历史每日新增会话数之和', icon: Eye, color: 'text-indigo-400' },
    { label: '今日访问', value: data?.todayVisits ?? 0, hint: '当日新增会话数', icon: CalendarDays, color: 'text-cyan-400' },
    { label: '当前在线', value: data?.online ?? 0, hint: '最近 5 分钟有心跳的会话', icon: Activity, color: 'text-emerald-400' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
            <Users className="w-4 h-4 text-sky-400" />
            <span>访问统计</span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            仅统计聚合计数，不记录个人访问明细、IP 或浏览器信息{data ? ` · 更新于 ${new Date(data.updatedAt).toLocaleTimeString('zh-CN')}` : ''}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  days === d ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                近 {d} 天
              </button>
            ))}
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-500/40 text-[11px] text-rose-300">{error}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="p-4 rounded-xl bg-slate-900 border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-400">{card.label}</span>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div className="mt-2 text-2xl font-bold text-slate-100 tabular-nums">{fmt(card.value)}</div>
              <p className="mt-1 text-[10px] text-slate-500">{card.hint}</p>
            </div>
          );
        })}
      </div>

      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-slate-200">模块热度排行（近 {days} 天）</span>
          <span className="text-[10px] text-slate-500">模块切换次数，同一模块 60 秒内不重复上报</span>
        </div>
        {data && data.modules.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-slate-500">所选时间范围内暂无模块访问记录</p>
        ) : (
          <div className="space-y-2">
            {(data?.modules || []).map((item) => (
              <div key={item.module} className="flex items-center space-x-3">
                <span className="w-20 shrink-0 text-[11px] text-slate-300">{MODULE_LABELS[item.module] || item.module}</span>
                <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-400"
                    style={{ width: `${Math.max(item.share, 1)}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-[11px] text-slate-400 tabular-nums">
                  {fmt(item.hits)} 次 · {item.share}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-slate-500 leading-relaxed">
        口径说明：累计访问 = 历史每日新增会话数之和（同一浏览器会话只计 1 次）；今日访问 = 当日新增会话数；当前在线 = 最近 5
        分钟有心跳的会话（匿名与登录均计入）；模块热度只统计页面级模块切换，不采集 IP、User-Agent 与停留时长。
      </p>
    </div>
  );
};
