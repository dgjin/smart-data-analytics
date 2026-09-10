import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Eye, RefreshCw, Search, X } from 'lucide-react';
import { apiFetch } from '../../api/client';

/** 困难样本类型定义 */
interface AdversarialSample {
  id: number;
  original_query: string;
  original_sql: string;
  error_message: string;
  data_source_id: string;
  user_id: number;
  annotation_status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED';
  expected_sql: string | null;
  resolved_strategy: string | null;
  created_at: string;
  
  // Priority scores (active learning)
  total_score?: number;
  rank?: number;
}

/** 审核工作区数据结构 */
interface ApprovalWorkItem extends AdversarialSample {
  normalizedQuery?: string;
}

/** 状态元数据（枚举 → 徽章样式映射） */
const STATUS_META: Record<AdversarialSample['annotation_status'], { label: string; color: string }> = {
  PENDING: { label: '待审核', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  IN_REVIEW: { label: '审核中', color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
  APPROVED: { label: '已采纳', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  REJECTED: { label: '已拒绝', color: 'bg-rose-500/20 text-rose-400 border-rose-500/30' },
};

/** SQL 高亮渲染器（简版，防 XSS） */
function highlightSQL(sql: string): React.JSX.Element {
  const regex = /\s+|[(),;]/;
  const tokens = sql.split(regex);
  return (
    <code className="font-mono text-sm">
      {tokens.map((token, i) => {
        const upper = token.toUpperCase().trim();
        if (['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'ON', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP BY', 'ORDER BY'].includes(upper)) {
          return <span key={i} className="text-violet-400 font-bold">{token}</span>;
        }
        if (/^'.*'$|^".*"$/.test(token)) {
          return <span key={i} className="text-emerald-400">{token}</span>;
        }
        if (!isNaN(Number(token))) {
          return <span key={i} className="text-amber-400">{token}</span>;
        }
        return <span key={i}>{token}</span>;
      })}
    </code>
  );
}

/** 审核对话框组件 */
const ApprovalModal: React.FC<{
  item: ApprovalWorkItem | null;
  onClose: () => void;
  onApprove: (sql: string) => void;
  onReject: () => void;
}> = ({ item, onClose, onApprove, onReject }) => {
  const [expectedSQL, setExpectedSQL] = useState('');

  useEffect(() => {
    if (item?.expected_sql) setExpectedSQL(item.expected_sql);
    else setExpectedSQL(item?.original_sql || '');
  }, [item]);

  if (!item) return null;

  const handleApprove = () => {
    onApprove(expectedSQL.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h3 className="text-xl font-bold text-slate-100">
            🔧 困难样本审核与标注
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-slate-100">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* 原始查询 */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">📝 原始用户查询</h4>
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
              <p className="text-slate-200 text-base">{item.original_query}</p>
            </div>
          </section>

          {/* 错误 SQL */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
              ❌ 失败 SQL <span className="text-rose-400 text-xs ml-2">{item.error_message}</span>
            </h4>
            <div className="bg-rose-950/30 border border-rose-700/30 rounded-xl p-4">
              {highlightSQL(item.original_sql)}
            </div>
          </section>

          {/* 期望 SQL 编辑器 */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">✅ 修正后 SQL（可编辑）</h4>
            <textarea
              value={expectedSQL}
              onChange={e => setExpectedSQL(e.target.value)}
              className="w-full h-40 bg-slate-800/50 border border-slate-700 rounded-xl p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              placeholder="输入正确的 SQL..."
            />
          </section>

          {/* 操作按钮 */}
          <section className="flex gap-3 justify-end pt-4 border-t border-slate-800">
            <button
              onClick={onReject}
              className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium transition-all"
            >
              ❌ 拒绝（不纳入知识库）
            </button>
            <button
              onClick={handleApprove}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-emerald-600/20"
            >
              ✅ 采纳并注入 Few-Shot（{expectedSQL.length} 字符）
            </button>
          </section>
        </div>
      </div>
    </div>
  );
};

/**
 * Fallback 困难样本审核面板（系统管理 · 仅管理员）：
 * 查看未解决的 Fallback 样本，手动标注正确 SQL，注入 Few-Shot 学习库。
 */
export const FallbackApprovalPanel: React.FC = () => {
  const [items, setItems] = useState<AdversarialSample[]>([]);
  const [filtered, setFiltered] = useState<AdversarialSample[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedItem, setSelectedItem] = useState<ApprovalWorkItem | null>(null);
  const [batchAction, setBatchAction] = useState<'approve' | 'reject' | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());

  // 加载样本列表
  const loadSamples = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/fallback-approval');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载样本失败');
      setItems(data.samples || []);
      setFiltered(data.samples || []);
    } catch (err: any) {
      setError(err.message || '加载样本失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadSamples(), 0);
    return () => clearTimeout(timer);
  }, [loadSamples]);

  // 过滤逻辑
  useEffect(() => {
    let result = [...items];
    if (statusFilter !== 'ALL') {
      result = result.filter(item => item.annotation_status === statusFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        item =>
          item.original_query.toLowerCase().includes(q) ||
          item.original_sql.toLowerCase().includes(q)
      );
    }
    setFiltered(result);
  }, [items, search, statusFilter]);

  // 选择/取消单选
  const toggleCheck = (id: number) => {
    const next = new Set(checkedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCheckedIds(next);
  };

  // 全选/取消全选
  const toggleAll = () => {
    if (checkedIds.size === filtered.length) setCheckedIds(new Set());
    else setCheckedIds(new Set(filtered.map(i => i.id)));
  };

  // 批量审批/拒绝
  const handleBatchAction = async (action: 'approve' | 'reject') => {
    setBatchAction(action);
    const sampleCount = checkedIds.size;
    alert(`即将对 ${sampleCount} 个样本执行 ${action === 'approve' ? '采纳' : '拒绝'} 操作？`);
    
    try {
      const res = await apiFetch('/api/admin/fallback-approval/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(checkedIds), action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '批量操作失败');
      await loadSamples();
      setCheckedIds(new Set());
      alert('批量操作成功！');
    } catch (err: any) {
      alert('批量操作失败：' + err.message);
    }
  };

  // 审核确认
  const handleApproveSubmission = async (expectedSQL: string) => {
    if (!selectedItem) return;
    try {
      const res = await apiFetch('/api/admin/fallback-approval/' + selectedItem.id + '/review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_sql: expectedSQL, status: 'APPROVED' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '审核失败');
      setSelectedItem(null);
      await loadSamples();
      alert('审核通过并已注入 Few-Shot 学习库！');
    } catch (err: any) {
      alert('审核失败：' + err.message);
    }
  };

  const handleRejectSubmission = async () => {
    if (!selectedItem) return;
    try {
      const res = await apiFetch('/api/admin/fallback-approval/' + selectedItem.id + '/review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REJECTED' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '拒绝失败');
      setSelectedItem(null);
      await loadSamples();
      alert('样本已拒绝！');
    } catch (err: any) {
      alert('拒绝失败：' + err.message);
    }
  };

  /** KPI 统计 */
  const stats = useMemo(() => {
    return {
      total: items.length,
      pending: items.filter(i => i.annotation_status === 'PENDING').length,
      approved: items.filter(i => i.annotation_status === 'APPROVED').length,
      rejected: items.filter(i => i.annotation_status === 'REJECTED').length,
    };
  }, [items]);
  
  // 优先级信息
  const avgScore = filtered.length > 0 
    ? Math.round(filtered.reduce((sum, i) => sum + (i.total_score || 0), 0) / filtered.length)
    : 0;

  return (
    <div className="p-6 space-y-6">
      {/* KPI 卡片 */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-sm text-slate-400 mb-1">总样本数</div>
          <div className="text-3xl font-bold text-slate-100">{stats.total}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-sm text-slate-400 mb-1">待审核</div>
          <div className="text-3xl font-bold text-amber-400">{stats.pending}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-sm text-slate-400 mb-1">已采纳</div>
          <div className="text-3xl font-bold text-emerald-400">{stats.approved}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-sm text-slate-400 mb-1">已拒绝</div>
          <div className="text-3xl font-bold text-rose-400">{stats.rejected}</div>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="flex items-center justify-between gap-4 bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <Search size={18} className="text-slate-400" />
          <input
            type="text"
            placeholder="搜索查询或 SQL..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent border-none focus:outline-none text-slate-200 w-80"
          />
        </div>
        
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="ALL">全部状态</option>
            <option value="PENDING">待审核</option>
            <option value="APPROVED">已采纳</option>
            <option value="REJECTED">已拒绝</option>
          </select>

          {checkedIds.size > 0 && (
            <>
              <button
                onClick={() => handleBatchAction('approve')}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-all"
              >
                ✅ 批量采纳 ({checkedIds.size})
              </button>
              <button
                onClick={() => handleBatchAction('reject')}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-all"
              >
                ❌ 批量拒绝 ({checkedIds.size})
              </button>
            </>
          )}
        </div>
      </div>

      {/* 表格 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-800 text-slate-300 text-xs font-mono uppercase tracking-wider">
            <tr>
              <th className="p-4 text-center">排名</th>
              {filtered.length > 0 && (
                <th className="p-4 text-center">
                  <button onClick={toggleAll} className="hover:text-slate-100">
                    {checkedIds.size === filtered.length ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </th>
              )}
              <th className="p-4">原始查询</th>
              <th className="p-4">错误消息</th>
              <th className="p-4">优先级分</th>
              <th className="p-4">使用策略</th>
              <th className="p-4">状态</th>
              <th className="p-4">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-slate-400">
                  <RefreshCw className="animate-spin mx-auto" /> 加载中...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-8 text-center text-slate-400">
                  {error ? `❌ ${error}` : '暂无数据'}
                </td>
              </tr>
            ) : (
              filtered.map(item => (
                <tr key={item.id} className="hover:bg-slate-800/50 transition-colors">
                  <td className="p-4 text-center">
                    <input
                      type="checkbox"
                      checked={checkedIds.has(item.id)}
                      onChange={() => toggleCheck(item.id)}
                      className="accent-indigo-500"
                    />
                  </td>
                  <td className="p-4">
                    <div className="text-sm text-slate-200 truncate max-w-xs" title={item.original_query}>
                      {item.original_query}
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="text-xs text-rose-400 font-mono truncate max-w-xs" title={item.error_message}>
                      {item.error_message}
                    </div>
                  </td>
                  {/* 优先级分 */}
                  <td className="p-4">
                    {item.total_score !== undefined && (
                      <span className={`px-2 py-1 rounded-lg text-xs font-bold border ${
                        item.total_score >= 80 
                          ? 'bg-violet-500/20 text-violet-400 border-violet-500/30'
                          : 'bg-slate-500/20 text-slate-400 border-slate-500/30'
                      }`}>
                        {item.total_score}/100
                      </span>
                    )}
                  </td>
                  <td className="p-4">
                    <span className="text-xs font-mono text-slate-400">{item.resolved_strategy || '-'}</span>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-lg text-xs font-medium border ${STATUS_META[item.annotation_status].color}`}>
                      {STATUS_META[item.annotation_status].label}
                    </span>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => setSelectedItem({ ...item, normalizedQuery: item.original_query })}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-all flex items-center gap-2"
                    >
                      <Eye size={14} /> 审核
                    </button>
                  </td>
                  <td className="p-4">{item.rank || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 审核对话框 */}
      {selectedItem && (
        <ApprovalModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onApprove={handleApproveSubmission}
          onReject={handleRejectSubmission}
        />
      )}
    </div>
  );
};

export default FallbackApprovalPanel;
