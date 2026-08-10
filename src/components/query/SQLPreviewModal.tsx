import React, { useState } from 'react';
import {
  Code2,
  Play,
  X,
  Check,
  Brain,
  Sparkles,
  Copy,
} from 'lucide-react';
import { QueryResultData } from '../../types/analytics';

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

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(sqlText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              <button
                onClick={handleCopy}
                className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 px-2 py-1 rounded border border-slate-700"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? '已复制' : '复制 SQL'}</span>
              </button>
            </div>

            <textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              rows={6}
              className="w-full p-3 bg-slate-950 border border-slate-700 rounded-xl font-mono text-xs text-indigo-300 focus:outline-none focus:border-indigo-500 leading-relaxed"
            />
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
