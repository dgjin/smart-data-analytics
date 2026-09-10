/**
 * A/B Test Dashboard Component
 *
 * 为管理员提供 A/B Test 实验数据的可视化仪表板
 * 展示 Rule-Based vs Human Approval 的效果对比
 *
 * 样式约定：与决策数据看板一致——纯 slate 深色类 + 已重映射强调色
 * （indigo/cyan/violet/emerald/rose/amber -400/-300 系），明暗主题经
 * html.light CSS 变量重映射自动翻转，无需 dark: 前缀。
 */

import { useState, useEffect } from 'react';
import {
  Activity,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Database,
  Users,
} from 'lucide-react';

/** A/B Test 统计数据类型 */
interface ABTestStats {
  days: number;
  groups: {
    rule_based?: {
      totalRequests: number;
      successCount: number;
      successRate: number;
      avgLatencyMs: number;
      minLatencyMs: number;
      maxLatencyMs: number;
    };
    human_approval?: {
      totalRequests: number;
      successCount: number;
      successRate: number;
      avgLatencyMs: number;
      minLatencyMs: number;
      maxLatencyMs: number;
    };
  };
}

/** 实验记录类型 */
interface ExperimentRecord {
  experimentId: string;
  query: string;
  failedSQL: string;
  assignedGroup: 'A' | 'B';
  selectedStrategy: string;
  success: boolean;
  latencyMs: number;
  createdAt: string;
}

/** 查询时间范围（天）；后端 clamp 至 1-90 */
const DAY_OPTIONS = [
  { value: 1, label: '近 24 小时' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
];

export function ABTestDashboard() {
  const [stats, setStats] = useState<ABTestStats | null>(null);
  const [records, setRecords] = useState<ExperimentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);

  // 加载统计数据
  const loadStats = async () => {
    try {
      const response = await fetch(`/api/admin/ab-test/stats?days=${days}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await response.json();
      if (data.success) {
        setStats(data.data);

        // 如果选择了新的天数范围，重新加载记录
        if (days !== 7) {
          loadRecentRecords(10);
        }
      }
    } catch (err) {
      console.error('[ABTest] Load stats failed:', err);
    } finally {
      setLoading(false);
    }
  };

  // 加载最近的实验记录
  const loadRecentRecords = async (limit: number = 10) => {
    try {
      const response = await fetch(`/api/admin/ab-test/records?limit=${limit}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await response.json();
      if (data.success) {
        setRecords(data.data);
      }
    } catch (err) {
      console.error('[ABTest] Load records failed:', err);
    }
  };

  useEffect(() => {
    loadStats();
  }, [days]);

  const handleRefresh = () => {
    setLoading(true);
    loadStats();
  };

  // 格式化毫秒为秒
  const formatLatency = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

  // 计算关键指标提升
  const getImprovement = (groupA: any, groupB: any, field: keyof typeof groupA) => {
    if (!groupA || !groupB || !groupA[field] || !groupB[field]) return 0;
    return ((groupB[field] - groupA[field]) / groupA[field] * 100).toFixed(2);
  };

  const groupA = stats?.groups.rule_based;
  const groupB = stats?.groups.human_approval;

  return (
    <div className="space-y-4">
      {/* 标题条：子面板标识（与其他管理面板同风格，自控制条中独立） */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex items-center space-x-2 shadow-xl">
        <Activity className="w-4 h-4 text-indigo-400 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-200">Fallback A/B 实验分析</div>
          <div className="text-[11px] text-slate-500 truncate">
            对比 Rule-Based Strategy vs Human Approval + Few-Shot 策略效果
          </div>
        </div>
      </div>

      {/* 控制条：时间范围 + 刷新 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-2">
          <div className="flex items-center space-x-1.5">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d.value}
                onClick={() => setDays(d.value)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                  days === d.value
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/30'
                    : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* KPI 汇总卡片：Group A / Group B / 成功率对比 / 延迟对比 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Group A - Rule-Based */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-cyan-400 text-[11px] font-semibold uppercase tracking-wider">
            <Database className="w-3.5 h-3.5" />
            <span>Group A · Rule-Based</span>
          </div>
          {groupA ? (
            <>
              <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">
                {groupA.totalRequests.toLocaleString('zh-CN')}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">总请求数</div>
              <div className="mt-2 flex items-center justify-between">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                  成功率 {groupA.successRate}%
                </span>
                <span className="text-[11px] text-slate-400 tabular-nums">
                  均耗 {formatLatency(groupA.avgLatencyMs)}
                </span>
              </div>
            </>
          ) : (
            <div className="mt-3 text-xs text-slate-500">暂无数据</div>
          )}
        </div>

        {/* Group B - Human Approval */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-violet-400 text-[11px] font-semibold uppercase tracking-wider">
            <Users className="w-3.5 h-3.5" />
            <span>Group B · Human Approval</span>
          </div>
          {groupB ? (
            <>
              <div className="mt-2 text-xl font-extrabold text-slate-100 tabular-nums">
                {groupB.totalRequests.toLocaleString('zh-CN')}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">总请求数</div>
              <div className="mt-2 flex items-center justify-between">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                  成功率 {groupB.successRate}%
                </span>
                <span className="text-[11px] text-slate-400 tabular-nums">
                  均耗 {formatLatency(groupB.avgLatencyMs)}
                </span>
              </div>
            </>
          ) : (
            <div className="mt-3 text-xs text-slate-500">暂无数据</div>
          )}
        </div>

        {/* 成功率对比 */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-emerald-400 text-[11px] font-semibold uppercase tracking-wider">
            <TrendingUp className="w-3.5 h-3.5" />
            <span>成功率对比</span>
          </div>
          {groupA && groupB ? (
            <>
              <div className="mt-2 text-xl font-extrabold text-emerald-400 tabular-nums">
                +{getImprovement(groupA, groupB, 'successRate')}%
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">Human Approval 相对提升</div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="inline-flex flex-1 justify-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                  A {groupA.successRate}%
                </span>
                <span className="inline-flex flex-1 justify-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-violet-500/10 text-violet-300 border-violet-500/30">
                  B {groupB.successRate}%
                </span>
              </div>
            </>
          ) : (
            <div className="mt-3 text-xs text-slate-500">等待数据…</div>
          )}
        </div>

        {/* 响应延迟对比 */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="flex items-center space-x-1.5 text-amber-400 text-[11px] font-semibold uppercase tracking-wider">
            <Clock className="w-3.5 h-3.5" />
            <span>响应延迟对比</span>
          </div>
          {groupA && groupB ? (
            <>
              <div className="mt-2 text-xl font-extrabold text-rose-400 tabular-nums">
                {getImprovement(groupB, groupA, 'avgLatencyMs')}%
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">相对优化（负值表示变慢）</div>
              <div className="mt-2 space-y-0.5 text-[11px] tabular-nums">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Group A</span>
                  <span className="text-slate-300 font-mono">{formatLatency(groupA.avgLatencyMs)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Group B</span>
                  <span className="text-slate-300 font-mono">{formatLatency(groupB.avgLatencyMs)}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="mt-3 text-xs text-slate-500">等待数据…</div>
          )}
        </div>
      </div>

      {/* 实验说明卡：对齐决策看板提示横幅（indigo-950/40 浅色下自动翻转为浅靛底） */}
      <div className="bg-indigo-950/40 border border-indigo-500/30 rounded-2xl p-4 shadow-lg flex items-start gap-3">
        <Activity className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
        <div className="space-y-1.5 min-w-0">
          <h4 className="text-xs font-bold text-indigo-300">A/B Test 实验说明</h4>
          <ul className="text-xs text-indigo-200 space-y-1 list-disc list-inside">
            <li><strong className="text-indigo-300">Group A (Rule-Based)</strong>：基于规则的 Fallback 策略，自动尝试替代 SQL 生成</li>
            <li><strong className="text-indigo-300">Group B (Human Approval)</strong>：人工审核 + Few-Shot 知识库增强策略</li>
            <li>系统会自动为每次 fallback 决策分配实验组别并记录结果</li>
            <li>通过持续监控两组的数据，可以量化不同策略的效果差异</li>
            <li>Few-Shot 注入机制：被采纳的困难样本会自动写入知识库供后续参考</li>
          </ul>
        </div>
      </div>

      {/* 最近实验记录表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-xs font-bold text-slate-300">
            <Activity className="w-4 h-4 text-indigo-400" />
            <span>最近实验记录（共 {records.length} 条）</span>
          </div>
          <button
            onClick={() => loadRecentRecords(50)}
            className="px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200 text-xs font-medium transition-colors"
          >
            加载更多
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
                <th className="px-5 py-3 font-medium">实验 ID</th>
                <th className="px-3 py-3 font-medium">用户 Query</th>
                <th className="px-3 py-3 font-medium">失败 SQL</th>
                <th className="px-3 py-3 font-medium">分组</th>
                <th className="px-3 py-3 font-medium">使用策略</th>
                <th className="px-3 py-3 font-medium text-center">结果</th>
                <th className="px-3 py-3 font-medium text-right">延迟</th>
                <th className="px-5 py-3 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr
                  key={record.experimentId}
                  className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors"
                >
                  <td className="px-5 py-3 whitespace-nowrap font-mono text-slate-400">
                    {record.experimentId.substring(0, 15)}…
                  </td>
                  <td className="px-3 py-3 max-w-xs truncate text-slate-200" title={record.query}>
                    {record.query}
                  </td>
                  <td className="px-3 py-3 max-w-xs truncate font-mono text-slate-400" title={record.failedSQL}>
                    {record.failedSQL}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                        record.assignedGroup === 'A'
                          ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                          : 'bg-violet-500/10 text-violet-300 border-violet-500/30'
                      }`}
                    >
                      {record.assignedGroup}
                    </span>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-slate-300">{record.selectedStrategy}</td>
                  <td className="px-3 py-3 text-center">
                    {record.success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 mx-auto" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-400 mx-auto" />
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-mono text-slate-400">
                    {formatLatency(record.latencyMs)}
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap text-slate-400">
                    {new Date(record.createdAt).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-slate-500">
                    暂无实验记录数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
