/**
 * 外部知识库接入管理卡片（仅管理员）。
 * 配置企业级外部 RAG / 知识服务检索接口：问数时与本地知识库一并检索注入，
 * 作为智能问数自主学习的又一来源。接口配置权限由管理员统一维护；
 * 支持连通性测试、启用开关、按数据源限定生效范围。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Globe, Plus, Trash2, RefreshCw, X, Lightbulb, Pencil, Zap } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { DataSource } from '../../types/analytics';

interface ExternalKbSourceItem {
  id: string;
  name: string;
  endpoint: string;
  authType: string;
  enabled: boolean;
  timeoutMs: number;
  dataSourceId: string;
  hasKey: boolean;
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ExtTestResult {
  ok: boolean;
  latencyMs: number;
  chunks: number;
  error?: string;
}

const emptyForm = {
  name: '',
  endpoint: '',
  authType: 'none',
  apiKey: '',
  timeoutMs: 5000,
  dataSourceId: '*',
  enabled: true,
};

export const ExternalKnowledgeCard: React.FC<{ dataSources: DataSource[] }> = ({ dataSources }) => {
  const [sources, setSources] = useState<ExternalKbSourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ExternalKbSourceItem | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExtTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/knowledge-external');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载外部知识源失败');
      setSources(data.sources || []);
    } catch (err: any) {
      setError(err.message || '加载外部知识源失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
    setForm({ ...emptyForm });
    setTestResult(null);
  };

  const openAdd = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setTestResult(null);
    setShowForm(true);
  };

  const openEdit = (s: ExternalKbSourceItem) => {
    setEditing(s);
    setForm({
      name: s.name,
      endpoint: s.endpoint,
      authType: s.authType,
      apiKey: '',
      timeoutMs: s.timeoutMs,
      dataSourceId: s.dataSourceId,
      enabled: s.enabled,
    });
    setTestResult(null);
    setShowForm(true);
  };

  const validateForm = (): string | null => {
    if (!form.name.trim()) return '名称必填';
    if (!/^https?:\/\/.+/i.test(form.endpoint.trim())) return '接口地址必须以 http(s):// 开头';
    if (form.authType === 'bearer' && !editing && !form.apiKey.trim()) return 'Bearer 认证需填写 API Key';
    if (form.authType === 'bearer' && editing && !form.apiKey.trim() && !editing.hasKey) return 'Bearer 认证需填写 API Key';
    const t = Number(form.timeoutMs);
    if (!Number.isFinite(t) || t < 500 || t > 30000) return '超时须在 500~30000ms 之间';
    return null;
  };

  const handleTest = async () => {
    const invalid = validateForm();
    if (invalid) {
      setError(invalid);
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await apiFetch('/api/knowledge-external/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          endpoint: form.endpoint.trim(),
          authType: form.authType,
          apiKey: form.apiKey || undefined,
          timeoutMs: Number(form.timeoutMs),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '测试失败');
      setTestResult(data);
    } catch (err: any) {
      setError(err.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const invalid = validateForm();
    if (invalid || saving) {
      if (invalid) setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(editing ? `/api/knowledge-external/${encodeURIComponent(editing.id)}` : '/api/knowledge-external', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          endpoint: form.endpoint.trim(),
          authType: form.authType,
          apiKey: form.apiKey || undefined,
          timeoutMs: Number(form.timeoutMs),
          dataSourceId: form.dataSourceId,
          enabled: form.enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      setNotice(`外部知识源「${form.name.trim()}」已${editing ? '更新' : '接入'}，问数检索即时生效。`);
      closeForm();
      loadSources();
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: ExternalKbSourceItem) => {
    if (!window.confirm(`确认删除外部知识源「${s.name}」？删除后问数不再检索该源。`)) return;
    try {
      const res = await apiFetch(`/api/knowledge-external/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '删除失败');
      setNotice(`外部知识源「${s.name}」已删除。`);
      loadSources();
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  };

  const dsName = (id: string) => (id === '*' ? '全部数据源' : dataSources.find((d) => d.id === id)?.name || id);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center space-x-2">
          <div className="p-2 rounded-xl bg-cyan-600 text-white">
            <Globe className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-100">外部知识源接入 (External Knowledge)</div>
            <div className="text-[11px] text-slate-400">
              管理员配置企业级外部知识库检索接口，问数时与本地知识库一并注入，作为自主学习的又一来源。
            </div>
          </div>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow transition-all shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>接入外部源</span>
        </button>
      </div>

      <div className="flex items-start space-x-2 p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-slate-400">
        <Lightbulb className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
        <span>
          检索协议：POST 接口地址，请求体 {'{ query, topK }'}；Bearer 认证时自动携带 Authorization 头。
          响应兼容 results / documents / data / items 数组（每项取 content / text / chunk 字段）。Dify、RAGFlow、自建网关均可适配。
        </span>
      </div>

      {notice && (
        <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/60 text-xs text-emerald-300">{notice}</div>
      )}
      {error && (
        <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/60 text-xs text-rose-300">{error}</div>
      )}

      {showForm && (
        <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-100">{editing ? `编辑外部知识源 · ${editing.name}` : '接入外部知识源'}</h3>
            <button onClick={closeForm} className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="名称，如「集团知识平台」"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            />
            <input
              type="text"
              placeholder="检索接口地址，如 http://kb.internal/api/search"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              className="md:col-span-2 bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
            />
            <select
              value={form.authType}
              onChange={(e) => setForm({ ...form, authType: e.target.value })}
              className="bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="none">认证：无</option>
              <option value="bearer">认证：Bearer Token</option>
            </select>
            <input
              type="number"
              min={500}
              max={30000}
              step={500}
              placeholder="超时 ms（默认 5000）"
              value={form.timeoutMs}
              onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })}
              className="bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            />
            {form.authType === 'bearer' && (
              <input
                type="password"
                placeholder={editing?.hasKey ? 'API Key（留空保留原密钥）' : 'API Key（加密存储）'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                className="md:col-span-2 bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            )}
            <select
              value={form.dataSourceId}
              onChange={(e) => setForm({ ...form, dataSourceId: e.target.value })}
              className="bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="*">生效范围：全部数据源</option>
              {dataSources.map((d) => (
                <option key={d.id} value={d.id}>
                  仅限：{d.name}
                </option>
              ))}
            </select>
            <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="accent-cyan-500"
              />
              <span>启用（关闭后问数不再检索该源）</span>
            </label>
          </div>
          {testResult && (
            <div
              className={`p-3 rounded-xl text-xs ${
                testResult.ok
                  ? 'bg-emerald-950/60 border border-emerald-800/60 text-emerald-300'
                  : 'bg-rose-950/60 border border-rose-800/60 text-rose-300'
              }`}
            >
              {testResult.ok
                ? `连接成功：耗时 ${testResult.latencyMs}ms，测试检索返回 ${testResult.chunks} 个片段。`
                : `连接失败：${testResult.error || '未知错误'}（耗时 ${testResult.latencyMs}ms）`}
            </div>
          )}
          <div className="flex justify-between items-center">
            <button
              onClick={handleTest}
              disabled={testing || saving}
              className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold border border-slate-700"
            >
              <Zap className={`w-3.5 h-3.5 ${testing ? 'animate-pulse text-amber-300' : 'text-amber-300'}`} />
              <span>{testing ? '测试中...' : '测试连接'}</span>
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
            >
              {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              <span>{saving ? '保存中...' : editing ? '保存修改' : '接入'}</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">已接入外部源（{sources.length} 个）</div>
        <button onClick={loadSources} className="text-slate-400 hover:text-slate-200 text-xs flex items-center space-x-1">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {sources.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-500">
          {loading ? '加载中...' : '暂未接入外部知识源，点击右上角「接入外部源」配置企业级 RAG 检索接口。'}
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
              <div className="min-w-0 flex-1">
                <div className="flex items-center space-x-2">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${s.enabled ? 'bg-emerald-400' : 'bg-slate-600'}`}
                    title={s.enabled ? '已启用' : '已停用'}
                  />
                  <span className="text-xs font-semibold text-slate-200 truncate">{s.name}</span>
                  {s.authType === 'bearer' && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-mono">Bearer</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">{s.endpoint}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {dsName(s.dataSourceId)} · 超时 {s.timeoutMs}ms · {s.createdBy}
                  {!s.enabled && <span className="text-amber-400/80 ml-1">（已停用）</span>}
                </div>
              </div>
              <div className="flex items-center space-x-1 shrink-0 ml-2">
                <button
                  onClick={() => {
                    openEdit(s);
                    setShowForm(true);
                  }}
                  title="编辑该外部源"
                  className="p-1.5 rounded-lg text-slate-500 hover:text-amber-300 hover:bg-amber-950/40 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(s)}
                  title="删除该外部源"
                  className="p-1.5 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-950/40 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
