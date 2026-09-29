/**
 * 向导 Step③ 自动初始化（核心步骤）：选择/接入数据源 → 六子任务流水线。
 * - 已有数据源直接选择；无数据源展开接入表单（复用 POST /api/datasources，保存即自动分析）；
 * - [开始执行] → POST /api/setup/pipeline → 2s 轮询进度；409 接管在途任务（防重服务端返回 taskId）；
 * - 失败子任务行内 [重试] 仅重跑该子任务；全部子任务成功/跳过 → 「下一步」可用；
 * - 重开向导自动挂载 state.pipelineTaskId 续拉进度（断点续做），快照存在即回显完成态。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { SetupApiError, setupGet, setupPost } from './setupApi';
import { SetupStatusIcon, primaryBtn, outlineBtn, subtaskLevel } from './setupUi';
import { formatCounters, isPipelineFinished } from './setupLogic';
import type { PipelineProgress, SetupStepProps } from './setupTypes';

interface Step3Snapshot {
  dataSourceId?: string;
  taskId?: string;
  status?: string;
  skipped?: boolean;
}

interface FormState {
  type: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
}

const EMPTY_FORM: FormState = { type: 'mysql', host: '127.0.0.1', port: '3306', username: '', password: '', database: '' };

export const StepAutoInit: React.FC<SetupStepProps> = ({ state, refreshState, onResult, onReadyChange }) => {
  const { dataSources, loadDataSources } = useAnalyticsStore();
  const snap = state.stepResults['2'] as Step3Snapshot | undefined;

  const [selectedDsId, setSelectedDsId] = useState<string>(snap?.dataSourceId || '');
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  /** 快照写入口（完成态幂等；重试/重跑时复位） */
  const savedRef = useRef(!!snap?.dataSourceId);

  // 接入表单
  const [fs, setFs] = useState<FormState>(EMPTY_FORM);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const runDsRef = useRef(snap?.dataSourceId || '');

  // 数据源清单（store 为空时补拉一次）
  useEffect(() => {
    if (dataSources.length === 0) void loadDataSources();
  }, [dataSources.length, loadDataSources]);

  useEffect(() => {
    if (!selectedDsId && dataSources[0]) setSelectedDsId(dataSources[0].id);
  }, [dataSources, selectedDsId]);

  // 断点续做：快照存在且最近任务 id 在途 → 挂载续拉进度；否则回显完成态
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (snap?.dataSourceId && state.pipelineTaskId) {
      runDsRef.current = snap.dataSourceId;
      setPhase('running');
      setTaskId(state.pipelineTaskId);
      onReadyChange(false);
    } else if (snap?.dataSourceId) {
      setPhase('done');
      onReadyChange(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 流水线轮询（2s；终态停止；单次失败下轮重试）
  useEffect(() => {
    if (!taskId) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const p = await setupGet<PipelineProgress>(`/api/setup/pipeline/${taskId}`);
        if (stopped) return;
        setProgress(p);
        if (isPipelineFinished(p)) {
          const subtasks = p.subtasks || [];
          const allSettled = subtasks.length > 0 && subtasks.every((s) => s.state === 'success' || s.state === 'skipped');
          setPhase('done');
          onReadyChange(allSettled);
          if (allSettled && !savedRef.current) {
            savedRef.current = true;
            void onResult({ dataSourceId: runDsRef.current, taskId, status: p.status, at: new Date().toISOString() });
            void refreshState();
          }
          return;
        }
      } catch {
        /* 轮询单次失败：保持循环 */
      }
      if (!stopped) timer = window.setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [taskId, onResult, onReadyChange, refreshState]);

  const startPipeline = useCallback(
    async (dsId: string, subtask?: string) => {
      if (!dsId) return;
      setError('');
      setNotice('');
      onReadyChange(false);
      try {
        const r = await setupPost<{ taskId: string }>('/api/setup/pipeline', {
          dataSourceId: dsId,
          ...(subtask ? { subtask } : {}),
        });
        runDsRef.current = dsId;
        savedRef.current = false;
        setProgress(null);
        setPhase('running');
        setTaskId(r.taskId);
      } catch (err) {
        // 409：已有在途任务 → 接管其进度
        if (err instanceof SetupApiError && err.status === 409 && err.data.taskId) {
          setNotice('已有流水线任务执行中，已接管其进度');
          runDsRef.current = dsId;
          setProgress(null);
          setPhase('running');
          setTaskId(String(err.data.taskId));
          return;
        }
        setError(err instanceof Error ? err.message : '流水线启动失败');
      }
    },
    [onReadyChange],
  );

  const canSubmit = fs.host.trim() !== '' && fs.username.trim() !== '' && fs.database.trim() !== '';

  const testConnection = async () => {
    setTesting(true);
    setTestMsg('');
    try {
      const r = await setupPost<{ success: boolean; message?: string; latencyMs?: number; tableCount?: number }>(
        '/api/datasources/test-connection',
        {
          type: fs.type,
          config: { host: fs.host.trim(), port: Number(fs.port) || 3306, database: fs.database.trim(), username: fs.username.trim(), password: fs.password },
        },
      );
      setTestMsg(r.success ? `连接成功！延迟 ${r.latencyMs}ms，检测到 ${r.tableCount} 张数据表` : `连接失败：${r.message || '无法建立连接'}`);
    } catch (err) {
      setTestMsg(err instanceof Error ? err.message : '测试连接失败');
    } finally {
      setTesting(false);
    }
  };

  const saveDataSource = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError('');
    try {
      const r = await setupPost<{ success?: boolean; id?: string; error?: string }>('/api/datasources', {
        name: fs.database.trim(),
        type: fs.type,
        config: {
          host: fs.host.trim(),
          port: Number(fs.port) || 3306,
          database: fs.database.trim(),
          username: fs.username.trim(),
          password: fs.password,
        },
      });
      await loadDataSources();
      if (r.id) {
        setSelectedDsId(r.id);
        void startPipeline(r.id);
      } else {
        setError('数据源已保存但未返回标识，请手动选择后执行');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据源接入失败');
    } finally {
      setSaving(false);
    }
  };

  const setF = (key: keyof FormState, value: string) => setFs((s) => ({ ...s, [key]: value }));

  const inputCls =
    'w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500';

  return (
    <div className="space-y-3.5">
      {phase === 'idle' && (
        <>
          {/* 已有数据源选择 */}
          {dataSources.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2">已检测到 {dataSources.length} 个可用数据源</div>
              <div className="space-y-2">
                {dataSources.map((ds) => (
                  <label
                    key={ds.id}
                    className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                      selectedDsId === ds.id ? 'border-indigo-500/70 bg-indigo-950/40' : 'border-slate-800 bg-slate-950/50 hover:bg-slate-900'
                    }`}
                  >
                    <input
                      type="radio"
                      name="setup-ds"
                      className="accent-indigo-500"
                      checked={selectedDsId === ds.id}
                      onChange={() => setSelectedDsId(ds.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-100 truncate">{ds.name}</div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {ds.type.toUpperCase()} · {ds.status === 'connected' ? '已连接' : ds.status} · {ds.tables?.length || 0} 表
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 接入新数据源（无数据源默认展开） */}
          <details open={dataSources.length === 0} className="rounded-xl border border-slate-800 bg-slate-950/40">
            <summary className="px-4 py-3 text-sm font-semibold text-slate-200 cursor-pointer select-none">接入我的数据源</summary>
            <div className="px-4 pb-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <select className={inputCls} value={fs.type} onChange={(e) => setF('type', e.target.value)}>
                  <option value="mysql">MySQL</option>
                  <option value="postgresql">PostgreSQL</option>
                  <option value="greenplum">Greenplum</option>
                </select>
                <input className={inputCls} placeholder="主机" value={fs.host} onChange={(e) => setF('host', e.target.value)} />
                <input className={inputCls} placeholder="端口" value={fs.port} onChange={(e) => setF('port', e.target.value)} />
                <input className={inputCls} placeholder="数据库名" value={fs.database} onChange={(e) => setF('database', e.target.value)} />
                <input className={inputCls} placeholder="账号" value={fs.username} onChange={(e) => setF('username', e.target.value)} />
                <input
                  className={inputCls}
                  placeholder="密码"
                  type="password"
                  value={fs.password}
                  onChange={(e) => setF('password', e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" className={outlineBtn} onClick={() => void testConnection()} disabled={testing || !canSubmit}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <button type="button" className={primaryBtn} onClick={() => void saveDataSource()} disabled={saving || !canSubmit}>
                  {saving ? '接入并分析中…' : '保存并继续'}
                </button>
              </div>
              {testMsg && <div className="text-xs text-slate-300">{testMsg}</div>}
              {saving && (
                <div className="text-xs text-slate-400">正在接入并自动分析（Schema / 能力配置 / 知识骨架），通常需要数秒至数十秒…</div>
              )}
            </div>
          </details>

          {/* 演示数据（Phase 2） */}
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-700 px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-300">加载演示数据集</div>
              <div className="text-xs text-slate-500 mt-0.5">在应用库中创建演示表并自动注册数据源</div>
            </div>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">Phase 2</span>
          </div>

          {snap?.dataSourceId && !snap?.skipped && (
            <div className="text-xs text-slate-500">上次已执行过初始化流水线，重复执行将按确定性 ID 覆盖（增量刷新）</div>
          )}

          <div className="flex items-center gap-3 flex-wrap pt-0.5">
            <button type="button" className={primaryBtn} disabled={!selectedDsId} onClick={() => void startPipeline(selectedDsId)}>
              <Play className="w-3.5 h-3.5" />
              开始执行
            </button>
            <span className="text-xs text-slate-500">
              {selectedDsId ? '将执行 6 个子任务：Schema 采集 → 能力配置 → 知识骨架 → 向量入库 → 样例种子' : '请先选择或接入数据源'}
            </span>
          </div>
        </>
      )}

      {phase !== 'idle' && (
        <div className="space-y-2.5">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 divide-y divide-slate-800/70">
            {(progress?.subtasks || []).map((st) => (
              <div key={st.key} className="flex items-start gap-3 px-4 py-3">
                <SetupStatusIcon level={subtaskLevel(st.state)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-100">{st.label}</span>
                    <span className="text-xs text-slate-400 shrink-0 tabular-nums">
                      {formatCounters(st.counters)}
                      {st.ms ? `${st.counters && Object.keys(st.counters).length > 0 ? ' · ' : ''}${(st.ms / 1000).toFixed(1)}s` : ''}
                    </span>
                  </div>
                  {st.state === 'failed' && (
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-rose-300">{st.error || '子任务失败'}</span>
                      <button
                        type="button"
                        className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
                        onClick={() => void startPipeline(runDsRef.current || selectedDsId, st.key)}
                      >
                        重试该子任务
                      </button>
                    </div>
                  )}
                  {st.state === 'skipped' && <div className="mt-1 text-xs text-amber-300">{st.error || '已跳过（Embedding 不可用）'}</div>}
                </div>
              </div>
            ))}
            {(!progress || (progress.subtasks || []).length === 0) && (
              <div className="flex items-center gap-3 px-4 py-3 text-xs text-slate-400">
                <SetupStatusIcon level="running" />
                流水线启动中…
              </div>
            )}
          </div>

          {progress?.status === 'FAILED' && (
            <div className="text-xs text-rose-300">任务失败：{progress.error || '未知错误'}</div>
          )}
          {phase === 'done' && (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-2 text-xs text-emerald-300">
                <SetupStatusIcon level="ok" className="w-3.5 h-3.5" />
                {(progress?.subtasks || []).every((s) => s.state === 'success' || s.state === 'skipped')
                  ? '初始化流水线已完成'
                  : '流水线已结束，存在失败子任务，可重试后继续'}
              </span>
              <button type="button" className={outlineBtn} onClick={() => setPhase('idle')}>
                重新执行（增量刷新）
              </button>
            </div>
          )}
          {phase === 'running' && <div className="text-xs text-slate-500">进度每 2 秒自动刷新；可关闭向导稍后回来，任务将在服务端继续执行</div>}
        </div>
      )}

      {notice && <div className="text-xs text-amber-300">{notice}</div>}
      {error && <div className="text-xs text-rose-300">{error}</div>}
    </div>
  );
};
