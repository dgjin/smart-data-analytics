/**
 * A/B Test Dashboard Component
 * 
 * 为管理员提供 A/B Test 实验数据的可视化仪表板
 * 展示 Rule-Based vs Human Approval 的效果对比
 */

import { useState, useEffect } from 'react';
import {
  Activity,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCcw,
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

// Reusable UI Components
const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-white rounded-lg shadow-md border border-slate-200 ${className}`}>
    {children}
  </div>
);

const CardHeader: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`px-6 py-4 border-b border-slate-200 ${className}`}>
    {children}
  </div>
);

const CardContent: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`p-6 ${className}`}>
    {children}
  </div>
);

const CardTitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <h3 className={`text-lg font-semibold text-slate-900 ${className}`}>
    {children}
  </h3>
);

const Badge: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
    {children}
  </span>
);

const Button: React.FC<{ 
  children: React.ReactNode; 
  onClick?: () => void;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'icon';
  className?: string;
}> = ({ children, onClick, variant = 'default', size = 'md', className = '' }) => {
  const baseStyle = 'rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const variants = {
    default: 'bg-indigo-600 text-white hover:bg-indigo-700',
    outline: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
  };
  const sizes = {
    sm: 'text-xs px-3 py-1.5',
    md: 'text-sm px-4 py-2',
    icon: 'p-1.5 h-8 w-8',
  };

  return (
    <button onClick={onClick} className={`${baseStyle} ${variants[variant]} ${sizes[size]} ${className}`}>
      {children}
    </button>
  );
};

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

  // 准备图表数据（按组对比）
  const chartData = stats ? Object.entries(stats.groups).map(([group, data]) => ({
    name: group === 'rule_based' ? 'Rule-Based (A)' : 'Human Approval + Few-Shot (B)',
    requests: data.totalRequests,
    successRate: data.successRate,
    avgLatency: data.avgLatencyMs,
  })) : [];

  // 计算关键指标提升
  const getImprovement = (groupA: any, groupB: any, field: keyof typeof groupA) => {
    if (!groupA || !groupB || !groupA[field] || !groupB[field]) return 0;
    return ((groupB[field] - groupA[field]) / groupA[field] * 100).toFixed(2);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">A/B Test 实验分析</h2>
          <p className="text-sm text-slate-600 mt-1">
            对比 Rule-Based Strategy vs Human Approval + Few-Shot 策略效果
          </p>
        </div>
        <div className="flex gap-2">
          <select 
            value={days.toString()} 
            onChange={(e) => setDays(parseInt(e.target.value))}
            className="bg-white border border-slate-300 rounded-md px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="1">最近 24 小时</option>
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
            <option value="90">最近 90 天</option>
          </select>
          <Button onClick={handleRefresh} variant="outline" size="icon">
            <RefreshCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Group A Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-blue-500" />
              Group A - Rule-Based
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.groups.rule_based ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold">{stats.groups.rule_based.totalRequests}</span>
                  <span className="text-xs text-slate-500">总请求</span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200">
                    {stats.groups.rule_based.successRate}%
                  </Badge>
                  <span className="text-xs text-slate-500">成功率</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">{formatLatency(stats.groups.rule_based.avgLatencyMs)}</span>
                  <Clock className="h-3 w-3 text-slate-400" />
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">暂无数据</div>
            )}
          </CardContent>
        </Card>

        {/* Group B Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-purple-500" />
              Group B - Human Approval
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.groups.human_approval ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold">{stats.groups.human_approval.totalRequests}</span>
                  <span className="text-xs text-slate-500">总请求</span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200">
                    {stats.groups.human_approval.successRate}%
                  </Badge>
                  <span className="text-xs text-slate-500">成功率</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">{formatLatency(stats.groups.human_approval.avgLatencyMs)}</span>
                  <Clock className="h-3 w-3 text-slate-400" />
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">暂无数据</div>
            )}
          </CardContent>
        </Card>

        {/* Success Rate Comparison */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              成功率对比
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.groups.rule_based && stats?.groups.human_approval ? (
              <div className="space-y-2">
                <div className="text-2xl font-bold">
                  +{getImprovement(stats.groups.rule_based, stats.groups.human_approval, 'successRate')}%
                </div>
                <div className="text-xs text-slate-500">
                  Human Approval 相对提升
                </div>
                <div className="flex gap-1">
                  <Badge className="flex-1 text-center bg-blue-50 text-blue-700 border border-blue-200">
                    {stats.groups.rule_based.successRate}%
                  </Badge>
                  <Badge className="flex-1 text-center bg-purple-50 text-purple-700 border border-purple-200">
                    {stats.groups.human_approval.successRate}%
                  </Badge>
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">等待数据...</div>
            )}
          </CardContent>
        </Card>

        {/* Latency Comparison */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" />
              响应延迟对比
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.groups.rule_based && stats?.groups.human_approval ? (
              <div className="space-y-2">
                <div className="text-2xl font-bold">
                  {getImprovement(stats.groups.human_approval, stats.groups.rule_based, 'avgLatencyMs')}%
                </div>
                <div className="text-xs text-slate-500">
                  Human Approval 相对优化
                </div>
                <div className="text-sm text-slate-600">
                  A: {formatLatency(stats.groups.rule_based.avgLatencyMs)}
                </div>
                <div className="text-sm text-slate-600">
                  B: {formatLatency(stats.groups.human_approval.avgLatencyMs)}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">等待数据...</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Info Note */}
      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Activity className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="space-y-2">
              <h4 className="font-semibold text-blue-900">A/B Test 说明</h4>
              <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                <li><strong>Group A (Rule-Based)</strong>: 基于规则的 Fallback 策略，自动尝试替代 SQL 生成</li>
                <li><strong>Group B (Human Approval)</strong>: 人工审核 + Few-Shot 知识库增强策略</li>
                <li>系统会自动为每次 fallback 决策分配实验组别并记录结果</li>
                <li>通过持续监控两组的数据，可以量化不同策略的效果差异</li>
                <li>Few-Shot 注入机制：被采纳的困难样本会自动写入知识库供后续参考</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Records Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            最近实验记录
            <Button variant="ghost" size="sm" onClick={() => loadRecentRecords(50)}>
              加载更多
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">实验 ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">用户 Query</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">失败 SQL</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">分组</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">使用策略</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">结果</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">延迟</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">时间</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {records.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-8 text-center text-sm text-slate-500">
                      暂无实验记录数据
                    </td>
                  </tr>
                ) : (
                  records.map((record) => (
                    <tr key={record.experimentId}>
                      <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-900 font-mono">
                        {record.experimentId.substring(0, 15)}...
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-900 max-w-xs truncate" title={record.query}>
                        {record.query}
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-900 font-mono max-w-xs truncate" title={record.failedSQL}>
                        {record.failedSQL}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                        <Badge className={record.assignedGroup === 'A' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-purple-50 text-purple-700 border border-purple-200'}>
                          {record.assignedGroup}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">{record.selectedStrategy}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                        {record.success ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-rose-500" />
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-900 font-mono">
                        {formatLatency(record.latencyMs)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-500">
                        {new Date(record.createdAt).toLocaleString('zh-CN')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
