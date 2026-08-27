/**
 * 系统帮助弹窗：实时读取 docs/用户使用指南.md（GET /api/help/manual）并渲染。
 * 帮助面向终端用户回答「系统怎么用」（服务端在指南缺失时回退功能说明书）。
 * 内置轻量 Markdown 渲染器（标题/表格/列表/代码块/引用/加粗/行内代码），
 * 不引入第三方 markdown 依赖，保证与文档文件始终一致。
 */
import React, { useEffect, useState } from 'react';
import { X, BookOpen, RefreshCw, FileText } from 'lucide-react';
import { apiFetch } from '../../api/client';

// ---------- 轻量 Markdown 渲染 ----------

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // 拆分行内代码 `code` 与加粗 **bold**
  const nodes: React.ReactNode[] = [];
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  parts.forEach((part, i) => {
    if (!part) return;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="px-1 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    } else {
      nodes.push(<React.Fragment key={`${keyPrefix}-t${i}`}>{part}</React.Fragment>);
    }
  });
  return nodes;
}

function TableBlock({ rows, keyPrefix }: { key?: string; rows: string[]; keyPrefix: string }) {
  // 第一行为表头，第二行为对齐分隔行（---），其余为数据行
  const cells = (line: string) =>
    line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(rows[0]);
  const body = rows.slice(1).filter((r) => !/^\s*\|?\s*:?-{3,}/.test(r));
  return (
    <div className="overflow-x-auto my-3 rounded-lg border border-slate-700">
      <table className="w-full text-xs text-left">
        <thead className="bg-slate-800/80 text-slate-300">
          <tr>
            {header.map((h, i) => (
              <th key={`${keyPrefix}-h${i}`} className="px-3 py-2 font-semibold border-b border-slate-700">
                {renderInline(h, `${keyPrefix}-h${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={`${keyPrefix}-r${ri}`} className="border-b border-slate-800 last:border-b-0">
              {cells(r).map((c, ci) => (
                <td key={`${keyPrefix}-r${ri}c${ci}`} className="px-3 py-2 text-slate-400 align-top">
                  {renderInline(c, `${keyPrefix}-r${ri}c${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const MarkdownView: React.FC<{ markdown: string }> = ({ markdown }) => {
  const lines = markdown.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const kp = `md${key++}`;

    // 代码块
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push(
        <pre
          key={kp}
          className="my-3 p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs text-emerald-300 font-mono overflow-x-auto whitespace-pre"
        >
          {buf.join('\n')}
        </pre>
      );
      continue;
    }

    // 表格（连续的 | 开头行）
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim());
        i++;
      }
      blocks.push(<TableBlock key={kp} rows={rows} keyPrefix={kp} />);
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = renderInline(h[2], kp);
      if (level === 1) {
        blocks.push(
          <h1 key={kp} className="text-xl font-bold text-slate-100 mt-6 mb-3 first:mt-0 pb-2 border-b border-slate-800">
            {content}
          </h1>
        );
      } else if (level === 2) {
        blocks.push(
          <h2 key={kp} className="text-lg font-semibold text-indigo-300 mt-5 mb-2">
            {content}
          </h2>
        );
      } else if (level === 3) {
        blocks.push(
          <h3 key={kp} className="text-base font-semibold text-slate-200 mt-4 mb-1.5">
            {content}
          </h3>
        );
      } else {
        blocks.push(
          <h4 key={kp} className="text-sm font-semibold text-slate-300 mt-3 mb-1">
            {content}
          </h4>
        );
      }
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={kp} className="my-4 border-slate-800" />);
      i++;
      continue;
    }

    // 引用
    if (line.trim().startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        buf.push(lines[i].trim().slice(2));
        i++;
      }
      blocks.push(
        <blockquote
          key={kp}
          className="my-3 pl-3 border-l-2 border-indigo-500/60 text-slate-400 text-xs italic"
        >
          {buf.map((b, bi) => (
            <p key={`${kp}-p${bi}`}>{renderInline(b, `${kp}-p${bi}`)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={kp} className="my-2 space-y-1.5 pl-1">
          {items.map((it, ii) => (
            <li key={`${kp}-li${ii}`} className="flex items-start text-xs text-slate-400 leading-relaxed">
              <span className="mt-1.5 mr-2 w-1 h-1 rounded-full bg-indigo-400 shrink-0" />
              <span>{renderInline(it, `${kp}-li${ii}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={kp} className="my-2 space-y-1.5 pl-1">
          {items.map((it, ii) => (
            <li key={`${kp}-oli${ii}`} className="flex items-start text-xs text-slate-400 leading-relaxed">
              <span className="mr-2 w-4 h-4 rounded bg-slate-800 text-indigo-300 text-[10px] flex items-center justify-center shrink-0 font-mono">
                {ii + 1}
              </span>
              <span>{renderInline(it, `${kp}-oli${ii}`)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // 空行跳过
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 普通段落
    blocks.push(
      <p key={kp} className="my-2 text-xs text-slate-400 leading-relaxed">
        {renderInline(line, kp)}
      </p>
    );
    i++;
  }

  return <div className="space-y-1">{blocks}</div>;
};

// ---------- 帮助弹窗 ----------

export const HelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/help/manual');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载使用指南失败');
      setMarkdown(data.markdown || '');
      setUpdatedAt(data.updatedAt || null);
    } catch (err: any) {
      setError(err.message || '加载使用指南失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">使用指南</h2>
              <p className="text-[11px] text-slate-500">
                {updatedAt ? `文档更新于 ${new Date(updatedAt).toLocaleString('zh-CN')}` : '实时读取最新文档'}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-1.5">
            <button
              onClick={load}
              title="重新加载"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              title="关闭（Esc）"
              className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && !markdown && (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500">
              <RefreshCw className="w-6 h-6 animate-spin mb-3" />
              <p className="text-xs">正在加载使用指南…</p>
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center py-16 text-rose-400">
              <FileText className="w-6 h-6 mb-3" />
              <p className="text-xs">{error}</p>
              <button
                onClick={load}
                className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
              >
                重试
              </button>
            </div>
          )}
          {markdown !== null && !loading && <MarkdownView markdown={markdown} />}
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
          <span>面向使用者的操作指南，随功能更新同步维护</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
