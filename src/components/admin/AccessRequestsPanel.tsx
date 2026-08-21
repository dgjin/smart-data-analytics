import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, CheckCircle2, XCircle, AlertCircle, Inbox } from 'lucide-react';
import { apiFetch } from '../../api/client';

/**
 * P2-11 权限申请审批面板（ADMIN）：数据源访问权的申请处理。
 * 通过后自动将申请人并入该数据源 acl_json.userIds，即时生效。
 */

interface AccessRequest {
  id: number;
  userId: number;
  username: string;
  department: string;
  dataSourceId: string;
  dataSourceName: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  approver: string;
  decideNote: string;
  decidedAt: string | null;
  createdAt: string | null;
}

const STATUS_META: Record<AccessRequest['status'], { label: string; cls: string }> = {
  PENDING: { label: '待审批', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  APPROVED: { label: '已通过', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  REJECTED: { label: '已驳回', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
};

export const AccessRequestsPanel: React.FC = () => {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadRequests = useCallback(async () => {
    try {
      const res = await apiFetch('/api/access-requests');
      const data = await res.json();
      if (data.success) {
        setRequests(data.requests || []);
      } else {
        showNotice('error', data.error || '审批列表获取失败');
      }
    } catch (err: any) {
      showNotice('error', err.message || '审批列表获取失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadRequests(), 0);
    return () => clearTimeout(timer);
  }, [loadRequests]);

  const decide = async (r: AccessRequest, action: 'approve' | 'reject') => {
    if (actingId) return;
    let note = '';
    if (action === 'reject') {
      const input = window.prompt(`驳回 ${r.username} 对「${r.dataSourceName || r.dataSourceId}」的申请，可填写驳回原因（可选）:`);
      if (input === null) return; // 用户取消
      note = input.slice(0, 300);
    }
    setActingId(r.id);
    try {
      const res = await apiFetch(`/api/access-requests/${r.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败');
      showNotice('success', action === 'approve' ? `已通过 ${r.username} 的申请，访问权限即时生效` : `已驳回 ${r.username} 的申请`);
      loadRequests();
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setActingId(null);
    }
  };

  const visible = showAll ? requests : requests.filter((r) => r.status === 'PENDING');
  const pendingCount = requests.filter((r) => r.status === 'PENDING').length;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
        <div className="flex items-center space-x-2 text-xs font-bold text-slate-300">
          <ShieldCheck className="w-4 h-4 text-amber-400" />
          <span>
            数据源权限申请（待审批 {pendingCount} / 共 {requests.length}）
          </span>
        </div>
        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-1.5 text-[11px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-indigo-500"
            />
            <span>显示已处理</span>
          </label>
          <button
            onClick={() => {
              setIsLoading(true);
              loadRequests();
            }}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`mx-5 mt-3 p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800 bg-slate-950/50">
              <th className="px-5 py-3 font-medium">申请人</th>
              <th className="px-5 py-3 font-medium">部门</th>
              <th className="px-5 py-3 font-medium">数据源</th>
              <th className="px-5 py-3 font-medium">申请理由</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">申请时间</th>
              <th className="px-5 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const meta = STATUS_META[r.status];
              return (
                <tr key={r.id} className="border-b border-slate-800/60 text-slate-300 hover:bg-slate-800/30 transition-colors">
                  <td className="px-5 py-3 font-mono text-slate-200">{r.username}</td>
                  <td className="px-5 py-3">{r.department || <span className="text-slate-500">未设置</span>}</td>
                  <td className="px-5 py-3">{r.dataSourceName || r.dataSourceId}</td>
                  <td className="px-5 py-3 max-w-[260px]">
                    <span className="block truncate" title={r.reason}>{r.reason}</span>
                    {r.decideNote && (
                      <span className="block mt-0.5 text-[10px] text-slate-500" title={r.decideNote}>
                        审批备注：{r.decideNote}（{r.approver}）
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-400">
                    {r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN') : '-'}
                  </td>
                  <td className="px-5 py-3">
                    {r.status === 'PENDING' ? (
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => decide(r, 'approve')}
                          disabled={actingId === r.id}
                          className="px-2.5 py-1 rounded-lg border border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40 text-[11px] font-medium transition-colors disabled:opacity-40"
                        >
                          通过
                        </button>
                        <button
                          onClick={() => decide(r, 'reject')}
                          disabled={actingId === r.id}
                          className="px-2.5 py-1 rounded-lg border border-rose-800/60 text-rose-300 hover:bg-rose-950/40 text-[11px] font-medium transition-colors disabled:opacity-40"
                        >
                          驳回
                        </button>
                      </div>
                    ) : (
                      <div className="text-right text-[10px] text-slate-500">
                        {r.decidedAt ? new Date(r.decidedAt).toLocaleString('zh-CN') : ''}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!isLoading && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                  <div className="flex flex-col items-center space-y-2">
                    <Inbox className="w-6 h-6 text-slate-600" />
                    <span>{showAll ? '暂无权限申请记录' : '暂无待审批的权限申请'}</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
