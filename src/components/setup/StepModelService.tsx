/**
 * 向导 Step② 模型服务：现状卡（只读，自 /state 的 env）+ [测试对话]/[测试向量] 真实探测
 * + .env 修复指引（可复制片段）+ Embedding 降级琥珀警示。
 * 「下一步」条件：对话探测通过 或 勾选「暂不配置」；结果写入步骤快照供断点续做回显。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, MessageSquare, AlertTriangle, XCircle } from 'lucide-react';
import { outlineBtn } from './setupUi';
import { setupPost } from './setupApi';
import type { ProbeResult, SetupStepProps } from './setupTypes';

interface Step2Snapshot {
  llm?: ProbeResult;
  embedding?: ProbeResult;
  skip?: boolean;
}

/** .env 配置片段（按引擎模板；变量名对齐 .env.example） */
const ENV_SNIPPET = `# ===== 对话模型（任选其一） =====
# 通义千问（百炼 OpenAI 兼容协议）
QWEN_API_KEY=你的密钥
QWEN_MODEL=qwen3.8-max

# DeepSeek 官方 API
# DEEPSEEK_API_KEY=你的密钥
# DEEPSEEK_MODEL=deepseek-flash

# Gemini API
# GEMINI_API_KEY=你的密钥

# 本地 Ollama（无需密钥，默认引擎）
# LLM_MODEL=qwen3.8:27b-mlx
# OLLAMA_URL=http://localhost:11434

# ===== 向量模型（知识检索，Ollama） =====
EMBED_MODEL=qwen3-embedding:8b`;

export const StepModelService: React.FC<SetupStepProps> = ({ state, onResult, onReadyChange }) => {
  const snap = state.stepResults['1'] as Step2Snapshot | undefined;
  const [llm, setLlm] = useState<ProbeResult | undefined>(snap?.llm);
  const [emb, setEmb] = useState<ProbeResult | undefined>(snap?.embedding);
  const [skipLlm, setSkipLlm] = useState<boolean>(snap?.skip === true);
  const [testing, setTesting] = useState<'' | 'llm' | 'embedding'>('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const persist = useCallback(
    (next: Step2Snapshot) => {
      void onResult({
        llm: next.llm ?? undefined,
        embedding: next.embedding ?? undefined,
        skip: next.skip === true,
        at: new Date().toISOString(),
      });
    },
    [onResult],
  );

  useEffect(() => {
    onReadyChange(skipLlm || llm?.ok === true);
  }, [skipLlm, llm, onReadyChange]);

  const test = async (kind: 'llm' | 'embedding') => {
    setTesting(kind);
    setError('');
    try {
      const r = await setupPost<ProbeResult>('/api/setup/probe', { kind });
      if (kind === 'llm') {
        setLlm(r);
        persist({ llm: r, embedding: emb, skip: skipLlm });
      } else {
        setEmb(r);
        persist({ llm, embedding: r, skip: skipLlm });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '探测请求失败');
    } finally {
      setTesting('');
    }
  };

  const toggleSkip = (v: boolean) => {
    setSkipLlm(v);
    persist({ llm, embedding: emb, skip: v });
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(ENV_SNIPPET);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败，请手动选择文本复制');
    }
  };

  const llmResult = () => {
    if (testing === 'llm') return <span className="text-xs text-slate-400">探测中…</span>;
    if (!llm) return <span className="text-xs text-slate-500">尚未测试</span>;
    return llm.ok ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
        <CheckCircle2 className="w-3.5 h-3.5" />
        连通 · 返回「{llm.sample || 'PONG'}」 · {((llm.latencyMs || 0) / 1000).toFixed(1)}s
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs text-rose-300 min-w-0">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{llm.error || '探测失败'}</span>
      </span>
    );
  };

  const embResult = () => {
    if (testing === 'embedding') return <span className="text-xs text-slate-400">探测中…</span>;
    if (!emb) return <span className="text-xs text-slate-500">尚未测试</span>;
    return emb.ok ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
        <CheckCircle2 className="w-3.5 h-3.5" />
        可用 · 维度 {emb.dims} · {emb.latencyMs}ms
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-300 min-w-0">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{emb.error || '不可用（知识检索将退化为词法匹配）'}</span>
      </span>
    );
  };

  return (
    <div className="space-y-3.5">
      {/* 现状卡（只读） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
          <div className="text-xs text-slate-400">对话引擎</div>
          <div className="text-sm font-semibold text-slate-100 mt-0.5 truncate">{state.env?.llm?.label || '未检测到'}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
          <div className="text-xs text-slate-400">向量模型</div>
          <div className="text-sm font-semibold text-slate-100 mt-0.5 truncate">{state.env?.embedding?.model || '未配置'}</div>
        </div>
      </div>

      {/* 探测交互 */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 divide-y divide-slate-800/70">
        <div className="flex items-center gap-3 px-4 py-3">
          <button type="button" className={outlineBtn} onClick={() => void test('llm')} disabled={testing !== ''}>
            {testing === 'llm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
            测试对话
          </button>
          <div className="flex-1 min-w-0">{llmResult()}</div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <button type="button" className={outlineBtn} onClick={() => void test('embedding')} disabled={testing !== ''}>
            {testing === 'embedding' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
            测试向量
          </button>
          <div className="flex-1 min-w-0">{embResult()}</div>
        </div>
      </div>

      {/* Embedding 降级警示（常驻） */}
      {emb && !emb.ok && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 px-4 py-3 text-xs text-amber-200 leading-relaxed">
          ⚠️ Embedding 模型不可用：知识向量检索将退化为词法匹配，问数准确率下降。可稍后在「系统设置」补齐并重跑向导第③步。
        </div>
      )}

      {/* 暂不配置（显式勾选可继续） */}
      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
        <input type="checkbox" className="accent-indigo-500" checked={skipLlm} onChange={(e) => toggleSkip(e.target.checked)} />
        暂不配置对话模型（允许继续向导，配置完成前问数功能不可用）
      </label>

      {/* 配置引导（.env 片段可复制） */}
      <details className="rounded-xl border border-slate-800 bg-slate-950/40">
        <summary className="px-4 py-3 text-sm font-semibold text-slate-200 cursor-pointer select-none">如何配置模型服务（.env 片段）</summary>
        <div className="px-4 pb-4 space-y-2.5">
          <pre className="text-[11px] leading-relaxed text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto whitespace-pre">{ENV_SNIPPET}</pre>
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" className={outlineBtn} onClick={() => void copySnippet()}>
              {copied ? '已复制 ✓' : '复制片段'}
            </button>
            <span className="text-xs text-slate-500">修改 .env 后需重启服务生效；Ollama 场景先执行 ollama pull &lt;模型&gt;</span>
          </div>
        </div>
      </details>

      {error && <div className="text-xs text-rose-300">{error}</div>}
    </div>
  );
};
