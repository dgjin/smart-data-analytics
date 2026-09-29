/**
 * 向导 Step① 环境自检：进入即自动执行（数据库/Redis/对话模型/Embedding/演示数据五项）。
 * 数据库/Redis/演示数据取 /state 的 readiness 探针与数据源统计；对话/向量模型经 /probe 真实调用；
 * ⚠️/❌ 不阻断「下一步」，但记入 Step⑤ 就绪判定与 Step④ 待办清单。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SetupStatusIcon, outlineBtn, type StepLevel } from './setupUi';
import { setupPost } from './setupApi';
import type { ProbeResult, SetupStepProps } from './setupTypes';

interface Step1Snapshot {
  llm?: ProbeResult;
  embedding?: ProbeResult;
}

interface CheckRow {
  key: string;
  title: string;
  level: StepLevel;
  note: string;
  extra?: string;
  suggest?: string;
}

export const StepEnvCheck: React.FC<SetupStepProps> = ({ state, refreshState, onResult, onReadyChange }) => {
  const snap = state.stepResults['0'] as Step1Snapshot | undefined;
  const [llm, setLlm] = useState<ProbeResult | null>(snap?.llm ?? null);
  const [emb, setEmb] = useState<ProbeResult | null>(snap?.embedding ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const runCheck = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [l, e] = await Promise.all([
        setupPost<ProbeResult>('/api/setup/probe', { kind: 'llm' }),
        setupPost<ProbeResult>('/api/setup/probe', { kind: 'embedding' }),
      ]);
      setLlm(l);
      setEmb(e);
      await onResult({ llm: l, embedding: e, at: new Date().toISOString() });
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : '环境探测请求失败');
    } finally {
      // ⚠️/❌ 不阻断继续
      onReadyChange(true);
      setBusy(false);
    }
  }, [refreshState, onResult, onReadyChange]);

  // 进入即执行：已有快照时回显（不重跑），无快照自动探测一次
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (snap) {
      onReadyChange(true);
      return;
    }
    void runCheck();
  }, [snap, runCheck, onReadyChange]);

  const checks = state.env?.health?.checks || {};
  const db = checks['mysql'];
  const redis = checks['redis'];
  const envLl = state.env?.llm;
  const embModel = state.env?.embedding?.model || 'bge-m3';
  const demoLoaded = state.env?.datasources?.demoLoaded === true;
  const probing = busy && (!llm || !emb);

  const rows: CheckRow[] = [
    {
      key: 'mysql',
      title: '数据库 MySQL',
      level: db ? (db.ok ? 'ok' : 'block') : 'pending',
      note: db ? (db.ok ? '正常' : db.error || '不可用（系统不可用，请检查 .env 的 MYSQL_* 配置）') : '检测中…',
      extra: db?.ok ? `${db.ms}ms` : undefined,
    },
    {
      key: 'redis',
      title: '状态存储 Redis',
      level: redis ? (redis.ok ? 'ok' : 'block') : 'ok',
      note: redis ? (redis.ok ? '正常' : redis.error || '已配置但不可达（多实例部署必需）') : '未启用（单实例模式）',
      extra: redis?.ok ? `${redis.ms}ms` : undefined,
    },
    {
      key: 'llm',
      title: llm?.label || envLl?.label || '对话模型',
      level: llm ? (llm.ok ? 'ok' : 'block') : probing ? 'running' : 'pending',
      note: llm ? (llm.ok ? `连通 · 返回「${llm.sample || 'PONG'}」` : llm.error || '连通失败（配置 .env 后重启服务）') : probing ? '检测中…' : '未检测',
      extra: llm?.ok ? `${((llm.latencyMs || 0) / 1000).toFixed(1)}s` : undefined,
    },
    {
      key: 'embedding',
      title: `Embedding 模型 ${embModel}`,
      level: emb ? (emb.ok ? 'ok' : 'warn') : probing ? 'running' : 'pending',
      note: emb ? (emb.ok ? '可用' : emb.error || '未检测到可用模型') : probing ? '检测中…' : '未检测',
      extra: emb?.ok ? `维度 ${emb.dims} · ${emb.latencyMs}ms` : undefined,
      suggest: emb && !emb.ok ? `建议：ollama pull ${embModel}（否则知识检索将退化为词法匹配）` : undefined,
    },
    {
      key: 'demo',
      title: '内置演示数据',
      level: demoLoaded ? 'ok' : 'pending',
      note: demoLoaded ? '已加载' : '未加载（可在第③步接入自有数据源）',
    },
  ];

  return (
    <div className="space-y-3.5">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 divide-y divide-slate-800/70">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start gap-3 px-4 py-3">
            <SetupStatusIcon level={r.level} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-100 truncate">{r.title}</span>
                {r.extra && <span className="text-xs text-slate-400 shrink-0 tabular-nums">{r.extra}</span>}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">{r.note}</div>
              {r.suggest && <div className="text-xs text-amber-300 mt-1">{r.suggest}</div>}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="text-xs text-rose-300">{error}</div>}

      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" className={outlineBtn} onClick={() => void runCheck()} disabled={busy}>
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          重新检测
        </button>
        <span className="text-xs text-slate-500">⚠️/❌ 项不阻断继续，可稍后在系统管理面板处理</span>
      </div>
    </div>
  );
};
