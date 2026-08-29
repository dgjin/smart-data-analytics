import { useCallback, useEffect, useState } from 'react';
import { BellRing, Check, RefreshCw, Radar, ShieldCheck, Plus, Minus } from 'lucide-react';
import { apiFetch } from '../../api/client';

/** 对齐 server/driftDetector.ts DriftEventRow */
interface DriftEvent {
  id: string;
  data_source_id: string;
  table_name: string;
  column_name: string;
  added: string[];
  removed: string[];
  status: 'OPEN' | 'ACKED';
  detected_at: string;
}

/**
 * P3-3 知识库漂移提醒（系统管理 · 仅管理员）：
 * 低基数枚举维度列取值快照比对，实库新增/消失取值时提醒「知识文档可能过时」。
 * 支持手动触发扫描、事件确认（知道了）。
 */
export const DriftAlertPanel: React.FC = () => {
  const [events, setEvents] = useState<DriftEvent[]>([]);
  const [watched, setWatched] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/ops/drift');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '漂移事件获取失败');
      setEvents(data.events || []);
      setWatched(Number(data.watched || 0));
    } catch (err: any) {
      setError(err.message || '漂移事件获取失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // 延迟到 effect 外执行，避免 effect 体内同步 setState（react-hooks/set-state-in-effect）
    const timer = setTimeout(() => void loadEvents(), 0);
    return () => clearTimeout(timer);
  }, [loadEvents]);

  const runScan = async () => {
    setIsScanning(true);
    setScanMsg(null);
    setError(null);
    try {
      const res = await apiFetch('/api/ops/drift/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '扫描失败');
      const summaries = (data.summaries || []) as Array<{ watched: number; discovered: number; newEvents: number; error?: string }>;
      const newEvents = summaries.reduce((acc, s) => acc + (s.newEvents || 0), 0);
      const discovered = summaries.reduce((acc, s) => acc + (s.discovered || 0), 0);
      setScanMsg(
        newEvents > 0
          ? `扫描完成：新增 ${newEvents} 条漂移事件${discovered > 0 ? `，自动发现 ${discovered} 个观察列` : ''}`
          : `扫描完成：未检测到取值变化${discovered > 0 ? `（自动发现 ${discovered} 个观察列并建基线）` : ''}`
      );
      await loadEvents();
    } catch (err: any) {
      setError(err.message || '扫描失败');
    } finally {
      setIsScanning(false);
    }
  };

  const ackEvent = async (id: string) => {
    try {
      const res = await apiFetch(`/api/ops/drift/${encodeURIComponent(id)}/ack`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '确认失败');
      setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, status: 'ACKED' } : e)));
    } catch (err: any) {
      setError(err.message || '确认失败');
    }
  };

  const openEvents = events.filter((e) => e.status === 'OPEN');
  const ackedEvents = events.filter((e) => e.status === 'ACKED');

  return (
    <div className="space-y-3">
      {/* 标题条：说明 + 操作 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center space-x-2 min-w-0">
          <Radar className="w-4 h-4 text-indigo-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-200">知识库漂移检测</div>
            <div className="text-[11px] text-slate-500 truncate">
              低基数维度列（业务分类等）取值快照比对，发现实库枚举值新增/消失时提醒知识文档可能过时 · 每日自动扫描
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2 shrink-0">
          <button
            onClick={() => void runScan()}
            disabled={isScanning}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
            <span>{isScanning ? '扫描中…' : '立即扫描'}</span>
          </button>
          <button
            onClick={() => void loadEvents()}
            disabled={isLoading}
            className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl border bg-rose-950/60 border-rose-800/60 text-rose-300 text-xs flex items-center justify-between space-x-2">
          <span>{error}</span>
          <button
            onClick={() => void loadEvents()}
            className="px-2.5 py-1 rounded-lg border border-rose-800/60 hover:bg-rose-900/40 text-[11px] font-medium shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {scanMsg && !error && (
        <div className="p-3 rounded-xl border bg-slate-900 border-slate-700 text-slate-300 text-xs">{scanMsg}</div>
      )}

      {/* 无 OPEN 事件：灰绿安心条 */}
      {openEvents.length === 0 && !isLoading && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex items-center space-x-2 shadow-xl">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-xs text-slate-400">
            未检测到枚举值漂移{watched > 0 ? `（观察中 ${watched} 列）` : '（尚未建立观察列，首次扫描将按 Schema 自动发现低基数维度列）'}
          </span>
        </div>
      )}

      {/* OPEN 事件：琥珀色提醒卡片 */}
      {openEvents.map((e) => (
        <div key={e.id} className="bg-amber-950/40 border border-amber-800/50 rounded-2xl p-4 shadow-xl space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center space-x-2 min-w-0">
              <BellRing className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-sm font-bold text-amber-200 font-mono">
                  {e.table_name}.{e.column_name}
                </span>
                <span className="ml-2 text-[11px] text-amber-500/80">取值发生变化，知识文档可能过时</span>
              </div>
            </div>
            <button
              onClick={() => void ackEvent(e.id)}
              className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-amber-800/60 text-amber-300 hover:bg-amber-900/40 text-[11px] font-medium shrink-0 transition-colors"
            >
              <Check className="w-3 h-3" />
              <span>知道了</span>
            </button>
          </div>
          {e.added.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="flex items-center space-x-0.5 text-[11px] text-emerald-400 font-semibold shrink-0">
                <Plus className="w-3 h-3" />
                <span>新增取值</span>
              </span>
              {e.added.map((v) => (
                <span key={`a-${v}`} className="px-2 py-0.5 rounded-lg bg-emerald-950/60 border border-emerald-800/50 text-emerald-300 text-[11px] font-mono">
                  {v}
                </span>
              ))}
            </div>
          )}
          {e.removed.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="flex items-center space-x-0.5 text-[11px] text-rose-400 font-semibold shrink-0">
                <Minus className="w-3 h-3" />
                <span>消失取值</span>
              </span>
              {e.removed.map((v) => (
                <span key={`r-${v}`} className="px-2 py-0.5 rounded-lg bg-rose-950/60 border border-rose-800/50 text-rose-300 text-[11px] font-mono line-through">
                  {v}
                </span>
              ))}
            </div>
          )}
          <div className="text-[11px] text-amber-600/70">检测于 {e.detected_at} · 数据源 {e.data_source_id}</div>
        </div>
      ))}

      {/* 已确认事件（折叠展示，置灰） */}
      {ackedEvents.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
            已确认（{ackedEvents.length}）
          </div>
          <div className="space-y-1.5">
            {ackedEvents.slice(0, 10).map((e) => (
              <div key={e.id} className="flex items-center justify-between text-[11px] text-slate-500">
                <span className="font-mono truncate">
                  {e.table_name}.{e.column_name}
                  {e.added.length > 0 && <span className="text-slate-600"> +{e.added.length}</span>}
                  {e.removed.length > 0 && <span className="text-slate-600"> -{e.removed.length}</span>}
                </span>
                <span className="shrink-0 ml-2">{e.detected_at}</span>
              </div>
            ))}
            {ackedEvents.length > 10 && (
              <div className="text-[11px] text-slate-600">… 其余 {ackedEvents.length - 10} 条略</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DriftAlertPanel;
