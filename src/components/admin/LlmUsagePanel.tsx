import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  Coins,
  RefreshCw,
  Search,
  Users,
  Zap,
} from 'lucide-react';
import { apiFetch } from '../../api/client';

/** 按用户聚合的 LLM 用量（对齐 server/llmUsage.ts LlmUsageByUser） */
interface LlmUsageByUser {
  userId: number | null;
  username: string;
  calls: number;
  okCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  lastUsedAt: string;
}

/** 按引擎/模型聚合的 LLM 用量（对齐 server/llmUsage.ts LlmUsageSummary） */
interface LlmUsageSummary {
  engine: string;
  model: string;
  calls: number;
  okCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
}

/** 查询时间范围（天）；后端 clamp 至 1-90 */
const DAY_OPTIONS = [7, 14, 30, 90];

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * Token 用量查询（系统管理 · 仅管理员）：
 * 按时间范围查询每个用户的 LLM Token 消耗，并附按引擎/模型的调用汇总。
 */
export const LlmUsagePanel: React.FC = () => {
  const [days, setDays] = useState(7);
  const [byUser, setByUser] = useState<LlmUsageByUser[]>([]);
  const [usage, setUsage] = useState<LlmUsageSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const loadUsage = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/system/llm-usage?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '用量查询失败');
      setByUser(data.byUser || []);
      setUsage(data.usage || []);
    } catch (err: any) {
      setError(err.message || '用量查询失败');
    } finally {
      setIsLoading(false);
    }
  }, [days]);

  useEffect(() => {
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => void loadUsage(), 0);
    return () => clearTimeout(timer);
  }, [loadUsage]);

  // 全量汇总（不受搜索过滤影响）：KPI 与占比条的基数
  const totals = useMemo(
    () =>
      byUser.reduce(
        (acc, u) => {
          acc.calls += u.calls;
          acc.okCalls += u.okCalls;
          acc.promptTokens += u.promptTokens;
          acc.completionTokens += u.completionTokens;
          acc.totalTokens += u.totalTokens;
          return acc;
        },
        { calls: 0, okCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      ),
    [byUser]
  );

  const filteredUsers = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return byUser;
    return byUser.filter((u) => u.username.toLowerCase().includes(kw));
  }, [byUser, search]);

  const okRate = totals.calls > 0 ? Math.round((totals.okCalls / totals.calls) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* 控制条：时间范围 + 用户搜索 + 刷新 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-1.5">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                days === d
                  ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/30'
                  : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
              }`}
            >
              近 {d} 天
            </button>
          ))}
        </div>
        <div className="flex items-center space-x-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索用户名…"
              className="w-48 bg-slate-950 border border-slate-700 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button
            onClick={() => void loadUsage()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* KPI 汇总卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-amber-400 text-[11px] font-semibold uppercase tracking-wider">
            <Coins className="w-3.5 h-3.5" />
            <span>Token 总消耗</span>
          </div>
          <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">
            {totals.totalTokens.toLocaleString('zh-CN')}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">近 {days} 天累计</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-indigo-400 text-[11px] font-semibold uppercase tracking-wider">
            <Zap className="w-3.5 h-3.5" />
            <span>调用次数</span>
          </div>
          <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">
            {totals.calls.toLocaleString('zh-CN')}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">成功率 {okRate}%</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-emerald-400 text-[11px] font-semibold uppercase tracking-wider">
            <ArrowDownUp className="w-3.5 h-3.5" />
            <span>输入 / 输出 Token</span>
          </div>
          <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">
            {totals.promptTokens.toLocaleString('zh-CN')}
            <span className="text-slate-500 font-bold mx-1">/</span>
            {totals.completionTokens.toLocaleString('zh-CN')}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">提示词 / 生成内容</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-sky-400 text-[11px] font-semibold uppercase tracking-wider">
            <Users className="w-3.5 h-3.5" />
            <span>活跃用户</span>
          </div>
          <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">{byUser.length}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">有消耗记录的用户数</div>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 rounded-xl border bg-rose-950/60 border-rose-800/60 text-rose-300 text-xs flex items-center justify-between space-x-2">
          <span>{error}</span>
          <button
            onClick={() => void loadUsage()}
            className="px-2.5 py-1 rounded-lg border border-rose-800/60 hover:bg-rose-900/40 text-[11px] font-medium shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {/* 按用户 Token 消耗表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center space-x-2 px-5 py-3 border-b border-slate-800 text-xs font-bold text-slate-300">
          <Coins className="w-4 h-4 text-amber-400" />
          <span>Token 消耗（按用户{search.trim() ? ' · 已过滤' : ''}，共 {filteredUsers.length} 人）</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-5 py-3 font-medium">用户名</th>
                <th className="px-3 py-3 font-medium text-right">调用次数</th>
                <th className="px-3 py-3 font-medium text-right">输入 Token</th>
                <th className="px-3 py-3 font-medium text-right">输出 Token</th>
                <th className="px-3 py-3 font-medium">总 Token（占比）</th>
                <th className="px-3 py-3 font-medium text-right">平均耗时</th>
                <th className="px-5 py-3 font-medium">最近使用</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => {
                const share =
                  totals.totalTokens > 0 ? Math.min(100, (u.totalTokens / totals.totalTokens) * 100) : 0;
                return (
                  <tr
                    key={`${u.userId ?? 'sys'}-${u.username}`}
                    className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="px-5 py-3 font-mono text-slate-200">
                      {u.username}
                      {u.userId === null && (
                        <span className="ml-2 text-[10px] text-slate-400 bg-slate-500/15 px-1.5 py-0.5 rounded">
                          系统/后台
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {u.calls.toLocaleString('zh-CN')}
                      <span className="ml-1 text-[10px] text-emerald-400/80">
                        {u.calls > 0 ? Math.round((u.okCalls / u.calls) * 100) : 0}%
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                      {u.promptTokens.toLocaleString('zh-CN')}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                      {u.completionTokens.toLocaleString('zh-CN')}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center space-x-2">
                        <span className="tabular-nums text-slate-100 font-semibold">
                          {u.totalTokens.toLocaleString('zh-CN')}
                        </span>
                        <div className="flex-1 min-w-[64px] h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-amber-500 to-amber-300 rounded-full"
                            style={{ width: `${share}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-500 tabular-nums w-9 text-right">
                          {share.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                      {formatDuration(u.avgDurationMs)}
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {new Date(u.lastUsedAt).toLocaleString('zh-CN')}
                    </td>
                  </tr>
                );
              })}
              {!isLoading && filteredUsers.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-slate-500">
                    {byUser.length === 0
                      ? `近 ${days} 天暂无 LLM 调用记录`
                      : '没有匹配该用户名的消耗记录'}
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-slate-500">
                    加载中…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 按引擎/模型调用汇总 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center space-x-2 px-5 py-3 border-b border-slate-800 text-xs font-bold text-slate-300">
          <Zap className="w-4 h-4 text-indigo-400" />
          <span>调用汇总（按引擎/模型，多引擎成本对比）</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-5 py-3 font-medium">引擎</th>
                <th className="px-3 py-3 font-medium">模型</th>
                <th className="px-3 py-3 font-medium text-right">调用次数</th>
                <th className="px-3 py-3 font-medium text-right">输入 Token</th>
                <th className="px-3 py-3 font-medium text-right">输出 Token</th>
                <th className="px-3 py-3 font-medium text-right">总 Token</th>
                <th className="px-5 py-3 font-medium text-right">平均耗时</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((m) => (
                <tr
                  key={`${m.engine}-${m.model}`}
                  className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <td className="px-5 py-3">
                    <span className="px-2 py-0.5 rounded-full border text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border-indigo-500/30">
                      {m.engine}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-slate-200">{m.model}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{m.calls.toLocaleString('zh-CN')}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                    {m.promptTokens.toLocaleString('zh-CN')}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                    {m.completionTokens.toLocaleString('zh-CN')}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-100 font-semibold">
                    {m.totalTokens.toLocaleString('zh-CN')}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-400">
                    {formatDuration(m.avgDurationMs)}
                  </td>
                </tr>
              ))}
              {!isLoading && usage.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-slate-500">
                    近 {days} 天暂无调用记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
