/**
 * SQL 样例库管理面板（Vanna training data 借鉴）。
 * 管理员维护问数 few-shot 训练语料：手工登记 / 编辑 / 剔除 question-SQL 对，
 * 点赞反馈自动沉淀的样例也在此统一治理；支持批量粘贴 SQL 反推问题冷启动导入。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { FileCode2, Plus, Trash2, Pencil, Upload, Sparkles, X } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';
import { DataSource } from '../../types/analytics';

interface SqlExample {
  id: number;
  dataSourceId: string;
  question: string;
  sql: string;
  source: 'MANUAL' | 'FEEDBACK_UP' | 'IMPORT';
  createdBy: string;
  createdAt: string;
}

const SOURCE_LABEL: Record<SqlExample['source'], string> = {
  MANUAL: '手工登记',
  FEEDBACK_UP: '点赞沉淀',
  IMPORT: '批量导入',
};

const SOURCE_STYLE: Record<SqlExample['source'], string> = {
  MANUAL: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  FEEDBACK_UP: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  IMPORT: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

export const SqlExamplesPanel: React.FC<{ dataSources: DataSource[]; initialId?: string }> = ({
  dataSources,
  initialId,
}) => {
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const [selectedId, setSelectedId] = useState(initialId || dataSources[0]?.id || '');
  const [examples, setExamples] = useState<SqlExample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 新增/编辑表单
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SqlExample | null>(null);
  const [question, setQuestion] = useState('');
  const [sql, setSql] = useState('');
  const [saving, setSaving] = useState(false);

  // 批量导入
  const [showImport, setShowImport] = useState(false);
  const [importSqls, setImportSqls] = useState('');
  const [importPairs, setImportPairs] = useState<{ question: string; sql: string }[]>([]);
  const [generating, setGenerating] = useState(false);
  const [importSaving, setImportSaving] = useState(false);

  const loadExamples = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sql-examples?dataSourceId=${encodeURIComponent(selectedId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载样例库失败');
      setExamples(data.examples || []);
    } catch (err: any) {
      setError(err.message || '加载样例库失败');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    loadExamples();
  }, [loadExamples]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
    setQuestion('');
    setSql('');
  };

  const handleSave = async () => {
    if (!selectedId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const url = editing ? `/api/sql-examples/${editing.id}` : '/api/sql-examples';
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { question, sql }
        : { dataSourceId: selectedId, question, sql };
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      setNotice(editing ? '样例已更新' : '样例已登记');
      closeForm();
      loadExamples();
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ex: SqlExample) => {
    try {
      const res = await apiFetch(`/api/sql-examples/${ex.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '删除失败');
      setNotice('样例已剔除');
      loadExamples();
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  };

  /** 按分号拆分粘贴的 SQL（忽略空段） */
  const splitSqls = (raw: string): string[] =>
    raw
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 10);

  const handleGenerate = async () => {
    const sqls = splitSqls(importSqls);
    if (sqls.length === 0 || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sql-examples/generate-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sqls }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '问题反推失败');
      setImportPairs(data.pairs || []);
    } catch (err: any) {
      setError(err.message || '问题反推失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleBulkSave = async () => {
    const valid = importPairs.filter((p) => p.question.trim() && p.sql.trim());
    if (valid.length === 0 || importSaving) return;
    setImportSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sql-examples/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: selectedId, examples: valid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '批量保存失败');
      setNotice(`已导入 ${data.saved} 条样例`);
      setShowImport(false);
      setImportSqls('');
      setImportPairs([]);
      loadExamples();
    } catch (err: any) {
      setError(err.message || '批量保存失败');
    } finally {
      setImportSaving(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-violet-600/20 rounded-xl border border-violet-500/30">
            <FileCode2 className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">SQL 样例库（训练语料）</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              问数时检索相似样例作为 few-shot 参考；点赞自动沉淀，管理员可登记、编辑与剔除
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
          >
            {dataSources.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name}
              </option>
            ))}
          </select>
          {isAdmin && (
            <>
              <button
                onClick={() => {
                  setShowImport((v) => !v);
                  setShowForm(false);
                }}
                className="flex items-center space-x-1.5 px-3 py-2 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>批量导入</span>
              </button>
              <button
                onClick={() => {
                  setShowForm((v) => !v);
                  setShowImport(false);
                  setEditing(null);
                  setQuestion('');
                  setSql('');
                }}
                className="flex items-center space-x-1.5 px-3 py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold rounded-lg transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>登记样例</span>
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{error}</div>
      )}
      {notice && (
        <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{notice}</div>
      )}

      {/* 新增/编辑表单 */}
      {showForm && isAdmin && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-200">{editing ? '编辑样例' : '登记新样例'}</span>
            <button onClick={closeForm} className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="自然语言问题，如：各客户类型的拜访次数统计"
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            placeholder="对应的 SELECT 查询（仅支持 SELECT）"
            rows={4}
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button
            onClick={handleSave}
            disabled={saving || !question.trim() || !sql.trim()}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-colors"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}

      {/* 批量导入（P2-8 冷启动：SQL → LLM 反推问题 → 确认入库） */}
      {showImport && isAdmin && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-200">批量导入（粘贴 SQL，多条以分号分隔，最多 10 条）</span>
            <button onClick={() => setShowImport(false)} className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <textarea
            value={importSqls}
            onChange={(e) => setImportSqls(e.target.value)}
            placeholder={'SELECT visitor_name, COUNT(*) FROM visit_records GROUP BY visitor_name;\nSELECT ...'}
            rows={4}
            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          {importPairs.length === 0 ? (
            <button
              onClick={handleGenerate}
              disabled={generating || splitSqls(importSqls).length === 0}
              className="flex items-center space-x-1.5 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-xs font-bold rounded-lg transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{generating ? 'AI 反推问题中…' : 'AI 反推问题'}</span>
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">确认或修改反推出的问题后保存：</p>
              {importPairs.map((p, i) => (
                <div key={i} className="bg-slate-900 border border-slate-700 rounded-lg p-3 space-y-2">
                  <input
                    value={p.question}
                    onChange={(e) =>
                      setImportPairs((prev) => prev.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))
                    }
                    placeholder="问题（可留空跳过该条）"
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                  <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap break-all">{p.sql}</pre>
                </div>
              ))}
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleBulkSave}
                  disabled={importSaving || importPairs.filter((p) => p.question.trim()).length === 0}
                  className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-colors"
                >
                  {importSaving ? '保存中…' : `保存 ${importPairs.filter((p) => p.question.trim()).length} 条`}
                </button>
                <button
                  onClick={() => setImportPairs([])}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg transition-colors"
                >
                  重新反推
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 样例列表 */}
      {loading ? (
        <div className="text-xs text-slate-400 py-6 text-center">加载中…</div>
      ) : examples.length === 0 ? (
        <div className="text-xs text-slate-500 py-8 text-center">
          暂无样例。登记高质量 question-SQL 对可显著提升相似提问的准确率。
        </div>
      ) : (
        <div className="space-y-2">
          {examples.map((ex) => (
            <div key={ex.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${SOURCE_STYLE[ex.source]}`}>
                      {SOURCE_LABEL[ex.source]}
                    </span>
                    <span className="text-xs font-medium text-slate-100 truncate">{ex.question}</span>
                  </div>
                  <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap break-all mt-1">{ex.sql}</pre>
                  <p className="text-[10px] text-slate-500 mt-1">
                    {ex.createdBy && `${ex.createdBy} · `}
                    {ex.createdAt ? new Date(ex.createdAt).toLocaleString() : ''}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex items-center space-x-1 shrink-0">
                    <button
                      onClick={() => {
                        setEditing(ex);
                        setQuestion(ex.question);
                        setSql(ex.sql);
                        setShowForm(true);
                        setShowImport(false);
                      }}
                      className="p-1.5 text-slate-400 hover:text-indigo-300 transition-colors"
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(ex)}
                      className="p-1.5 text-slate-400 hover:text-rose-300 transition-colors"
                      title="剔除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
