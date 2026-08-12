/**
 * P1-A 知识库管理面板（借鉴 DB-GPT RAG 知识库）。
 * 管理员为当前数据源登记业务知识（指标口径、术语表、计算规则），
 * 问数时服务端检索相关片段注入 prompt，弥补 Schema 元数据表达不足。
 * 支持查看文档详情（切块明细）与编辑维护（重新切块 + embedding）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Plus, Trash2, RefreshCw, X, Lightbulb, Eye, Pencil } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';
import { DataSource } from '../../types/analytics';

interface KnowledgeDoc {
  docId: string;
  title: string;
  chunkCount: number;
  createdBy: string;
  createdAt: string;
}

interface KnowledgeDocDetail {
  docId: string;
  dataSourceId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  chunkCount: number;
  chunks: { index: number; text: string }[];
}

export const KnowledgeBasePanel: React.FC<{ dataSources: DataSource[]; initialId?: string }> = ({
  dataSources,
  initialId,
}) => {
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const [selectedId, setSelectedId] = useState(initialId || dataSources[0]?.id || '');
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 维护态：editingDoc 非空表示编辑现有文档（表单复用新增表单）
  const [editingDoc, setEditingDoc] = useState<KnowledgeDoc | null>(null);
  // 详情弹窗
  const [detail, setDetail] = useState<KnowledgeDocDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const selectedDs = dataSources.find((d) => d.id === selectedId);

  const loadDocs = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/knowledge?dataSourceId=${encodeURIComponent(selectedId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载知识库失败');
      setDocs(data.docs || []);
    } catch (err: any) {
      setError(err.message || '加载知识库失败');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const closeForm = () => {
    setShowAdd(false);
    setEditingDoc(null);
    setTitle('');
    setContent('');
  };

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const isEdit = !!editingDoc;
      const res = await apiFetch(isEdit ? `/api/knowledge/${encodeURIComponent(editingDoc!.docId)}` : '/api/knowledge', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEdit ? { title: title.trim(), content } : { dataSourceId: selectedId, title: title.trim(), content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (isEdit ? '保存失败' : '登记失败'));
      closeForm();
      setNotice(`知识「${title.trim()}」已${isEdit ? '更新' : '登记'}（切分为 ${data.chunkCount} 个片段）。`);
      loadDocs();
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (doc: KnowledgeDoc) => {
    // 拉取完整内容（拼接切块）回填编辑表单
    setError(null);
    try {
      const res = await apiFetch(`/api/knowledge/${encodeURIComponent(doc.docId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载详情失败');
      const d = data.doc as KnowledgeDocDetail;
      setEditingDoc(doc);
      setTitle(d.title);
      setContent(d.chunks.map((c) => c.text).join('\n'));
      setShowAdd(true);
      setDetail(null);
    } catch (err: any) {
      setError(err.message || '加载详情失败');
    }
  };

  const handleView = async (doc: KnowledgeDoc) => {
    setError(null);
    setDetailLoading(true);
    setDetail({ docId: doc.docId, dataSourceId: selectedId, title: doc.title, createdBy: doc.createdBy, createdAt: doc.createdAt, chunkCount: doc.chunkCount, chunks: [] });
    try {
      const res = await apiFetch(`/api/knowledge/${encodeURIComponent(doc.docId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载详情失败');
      setDetail(data.doc);
    } catch (err: any) {
      setDetail(null);
      setError(err.message || '加载详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async (doc: KnowledgeDoc) => {
    if (!window.confirm(`确认删除知识「${doc.title}」？`)) return;
    try {
      const res = await apiFetch(`/api/knowledge/${encodeURIComponent(doc.docId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '删除失败');
      setNotice(`知识「${doc.title}」已删除。`);
      loadDocs();
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  };

  return (
    <div className="space-y-4">
      {/* 面板头部：数据源选择 + 新增 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <div className="p-2 rounded-xl bg-indigo-600 text-white">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-100">业务知识库 (Knowledge Base)</div>
              <div className="text-[11px] text-slate-400">
                登记指标口径、术语与计算规则，问数时自动检索注入，提升 SQL 生成的业务准确性。
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            >
              {dataSources.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.type})
                </option>
              ))}
            </select>
            {isAdmin && (
              <button
                onClick={() => {
                  closeForm();
                  setShowAdd(true);
                }}
                disabled={!selectedId}
                className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow transition-all"
              >
                <Plus className="w-4 h-4" />
                <span>登记知识</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-start space-x-2 p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-slate-400">
          <Lightbulb className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <span>
            示例：「不良率 = 不良贷款余额 / 贷款总余额，五级分类中次级、可疑、损失三类计入不良」「客户类型 VIP 指近 90 天日均资产 ≥ 50 万的客户」。
          </span>
        </div>
      </div>

      {notice && (
        <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/60 text-xs text-emerald-300">{notice}</div>
      )}
      {error && (
        <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/60 text-xs text-rose-300">{error}</div>
      )}

      {/* 新增 / 编辑知识表单 */}
      {showAdd && (
        <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-100">
              {editingDoc ? `编辑业务知识 · ${editingDoc.title}` : `登记业务知识 · ${selectedDs?.name || ''}`}
            </h3>
            <button onClick={closeForm} className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          {editingDoc && (
            <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/30 text-[11px] text-amber-300">
              保存后原文内容将被重新切块并生成新的检索向量，问数检索即时生效。
            </div>
          )}
          <input
            type="text"
            placeholder="知识标题，如「不良率口径」"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          />
          <textarea
            placeholder="知识内容，可用多行。登记后将被切块并在问数时按相关性检索注入。"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 resize-y"
          />
          <div className="flex justify-end">
            <button
              onClick={handleSubmit}
              disabled={!title.trim() || !content.trim() || saving}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
            >
              {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              <span>{saving ? '保存中...' : editingDoc ? '保存修改' : '保存知识'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 知识文档详情弹窗 */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <div
            className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between p-4 border-b border-slate-800">
              <div className="min-w-0">
                <div className="text-sm font-bold text-slate-100 truncate">{detail.title}</div>
                <div className="text-[10px] text-slate-500 font-mono mt-1">
                  {detail.chunkCount} 个检索片段 · {detail.createdBy} · {detail.createdAt ? String(detail.createdAt).slice(0, 16).replace('T', ' ') : ''} · {detail.docId}
                </div>
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-200 shrink-0 ml-3">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {detailLoading ? (
                <div className="py-10 text-center text-xs text-slate-500">加载中...</div>
              ) : detail.chunks.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-500">无内容</div>
              ) : (
                detail.chunks.map((c) => (
                  <div key={c.index} className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-mono text-indigo-400 mb-1.5">片段 {c.index}/{detail.chunkCount}</div>
                    <div className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{c.text}</div>
                  </div>
                ))
              )}
            </div>
            {isAdmin && (
              <div className="flex justify-end gap-2 p-4 border-t border-slate-800">
                <button
                  onClick={() => handleEdit(detail as any)}
                  disabled={detailLoading}
                  className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  <span>编辑该知识</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 知识文档列表 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            已登记知识（{docs.length} 条）
          </div>
          <button
            onClick={loadDocs}
            className="text-slate-400 hover:text-slate-200 text-xs flex items-center space-x-1"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>

        {docs.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500">
            {loading ? '加载中...' : '该数据源暂无业务知识，点击右上角「登记知识」添加。'}
          </div>
        ) : (
          <div className="space-y-2">
            {docs.map((doc) => (
              <div
                key={doc.docId}
                className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800"
              >
                <div className="min-w-0 flex-1 cursor-pointer" onClick={() => handleView(doc)} title="查看详情">
                  <div className="text-xs font-semibold text-slate-200 truncate">{doc.title}</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    {doc.chunkCount} 个片段 · {doc.createdBy} · {doc.createdAt ? String(doc.createdAt).slice(0, 10) : ''}
                  </div>
                </div>
                <div className="flex items-center space-x-1 shrink-0 ml-2">
                  <button
                    onClick={() => handleView(doc)}
                    title="查看详情"
                    className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-300 hover:bg-indigo-950/40 transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => handleEdit(doc)}
                        title="编辑该知识"
                        className="p-1.5 rounded-lg text-slate-500 hover:text-amber-300 hover:bg-amber-950/40 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(doc)}
                        title="删除该知识"
                        className="p-1.5 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-950/40 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
