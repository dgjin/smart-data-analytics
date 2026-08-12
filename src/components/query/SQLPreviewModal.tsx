import React, { useState } from 'react';
import {
  Code2,
  Play,
  X,
  Check,
  Brain,
  Sparkles,
  Copy,
  BookOpen,
  Gauge,
  Loader2,
} from 'lucide-react';
import { QueryResultData } from '../../types/analytics';
import { apiFetch } from '../../api/client';

interface SQLPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  queryResult: QueryResultData;
  onReRunSQL: (newSQL: string) => void;
}

export const SQLPreviewModal: React.FC<SQLPreviewModalProps> = ({
  isOpen,
  onClose,
  queryResult,
  onReRunSQL,
}) => {
  const [sqlText, setSqlText] = useState(queryResult.generatedSQL || '');
  const [copied, setCopied] = useState(false);
  // SQL AI 助手（借鉴 Chat2DB：SQL 解释 / 优化建议）
  const [assistLoading, setAssistLoading] = useState<'explain' | 'optimize' | null>(null);
  const [assistResult, setAssistResult] = useState<{ type: 'explain' | 'optimize'; text: string } | null>(null);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(sqlText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSqlAssist = async (action: 'explain' | 'optimize') => {
    if (assistLoading) return;
    setAssistLoading(action);
    try {
      const resp = await apiFetch('/api/query/sql-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sql: sqlText }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || '请求失败');
      setAssistResult({ type: action, text: String(data.text || '') });
    } catch (err: any) {
      setAssistResult({ type: action, text: `AI 助手调用失败：${String(err?.message || err)}` });
    } finally {
      setAssistLoading(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-lg bg-indigo-600/20 text-indigo-400">
              <Code2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-100 text-sm">
                NL2SQL 转换逻辑与 SQL 执行器
              </h3>
              <p className="text-[11px] text-slate-400">
                查看自然语言转 SQL 的推理链，支持手动调试 SQL 语句
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-200 rounded-lg bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs text-slate-300">
          {/* AI Thought Chain Steps */}
          {queryResult.thoughtProcess && queryResult.thoughtProcess.length > 0 && (
            <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2">
              <div className="flex items-center space-x-1.5 font-semibold text-indigo-300 text-xs">
                <Brain className="w-4 h-4 text-indigo-400" />
                <span>AI 自然语言解析与意图推导链 (Thought Process):</span>
              </div>
              <ul className="space-y-1.5 pl-5 list-disc text-slate-300 font-sans">
                {queryResult.thoughtProcess.map((step, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {step}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* SQL Editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-slate-200 flex items-center space-x-1.5">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                <span>生成的 SQL 查询语句 (可手动修改调试):</span>
              </label>
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={() => handleSqlAssist('explain')}
                  disabled={assistLoading !== null}
                  className="flex items-center space-x-1 text-[11px] text-cyan-300 hover:text-cyan-200 bg-cyan-950/50 px-2 py-1 rounded border border-cyan-500/30 disabled:opacity-50 transition-colors"
                  title="用自然语言解释这条 SQL 的业务含义"
                >
                  {assistLoading === 'explain' ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />}
                  <span>AI 解释</span>
                </button>
                <button
                  onClick={() => handleSqlAssist('optimize')}
                  disabled={assistLoading !== null}
                  className="flex items-center space-x-1 text-[11px] text-emerald-300 hover:text-emerald-200 bg-emerald-950/50 px-2 py-1 rounded border border-emerald-500/30 disabled:opacity-50 transition-colors"
                  title="给出索引与写法层面的优化建议"
                >
                  {assistLoading === 'optimize' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Gauge className="w-3 h-3" />}
                  <span>优化建议</span>
                </button>
                <button
                  onClick={handleCopy}
                  className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 px-2 py-1 rounded border border-slate-700"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copied ? '已复制' : '复制 SQL'}</span>
                </button>
              </div>
            </div>

            <textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              rows={6}
              className="w-full p-3 bg-slate-950 border border-slate-700 rounded-xl font-mono text-xs text-indigo-300 focus:outline-none focus:border-indigo-500 leading-relaxed"
            />

            {/* SQL AI 助手输出（解释 / 优化建议） */}
            {assistResult && (
              <div
                className={`p-3.5 rounded-xl border space-y-1.5 ${
                  assistResult.type === 'explain'
                    ? 'bg-cyan-950/30 border-cyan-500/30'
                    : 'bg-emerald-950/30 border-emerald-500/30'
                }`}
              >
                <div
                  className={`flex items-center space-x-1.5 font-semibold text-xs ${
                    assistResult.type === 'explain' ? 'text-cyan-300' : 'text-emerald-300'
                  }`}
                >
                  {assistResult.type === 'explain' ? <BookOpen className="w-3.5 h-3.5" /> : <Gauge className="w-3.5 h-3.5" />}
                  <span>{assistResult.type === 'explain' ? 'SQL 业务解读' : 'SQL 优化建议'}</span>
                </div>
                <p className="text-slate-300 leading-relaxed whitespace-pre-wrap">{assistResult.text}</p>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">
            执行时间: {queryResult.executionTimeMs} ms • 状态: 语法已通过校验
          </span>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
            >
              关闭
            </button>
            <button
              onClick={() => {
                onReRunSQL(sqlText);
                onClose();
              }}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>重新运行 SQL</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
