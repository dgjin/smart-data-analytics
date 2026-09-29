/**
 * 系统帮助弹窗：实时读取 docs/核心文档 下帮助文档（GET /api/help/manual、/api/help/changelog）并渲染。
 * 「使用指南」面向终端用户回答「系统怎么用」（服务端在指南缺失时回退功能说明书）；
 * 「更新日志」按版本记录主要更新内容，供用户备查（v0.9.36）；
 * 「智能问答」（v0.9.88）：基于帮助文档章节检索 + LLM 快速回答使用问题（POST /api/help/ask），
 * 支持多轮追问，回答附命中章节作为参考来源。
 * 内置轻量 Markdown 渲染器（标题/表格/列表/代码块/引用/加粗/行内代码），
 * 不引入第三方 markdown 依赖，保证与文档文件始终一致。
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, BookOpen, RefreshCw, FileText, History, Sparkles, Send } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';

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

// ---------- 智能问答面板（v0.9.88） ----------

interface AskMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 命中的帮助文档章节（「来源 · 标题」），助手消息展示参考来源 */
  sections?: string[];
  error?: boolean;
}

/** 首次进入的引导问题（帮助中心最高频的使用疑问） */
const ASK_SUGGESTIONS = [
  '如何配置数据源？',
  '怎么导入 Excel / CSV 数据？',
  '金额单位在哪里设置？',
  '如何导出报表 PDF / Word？',
];

const AskPanel: React.FC = () => {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pending]);

  const send = async (raw?: string) => {
    const question = (raw ?? input).trim();
    if (!question || pending) return;
    setInput('');
    const base: AskMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(base);
    setPending(true);
    try {
      // 携带最近 3 轮（≤6 条）历史，支持「那它呢」这类指代追问；服务端会再次清洗限量
      const history = base.slice(-7, -1).map((m) => ({ role: m.role, content: m.content }));
      const res = await apiFetch('/api/help/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI 回答失败');
      setMessages([
        ...base,
        { role: 'assistant', content: String(data.answer || ''), sections: Array.isArray(data.sections) ? data.sections : [] },
      ]);
    } catch (err) {
      setMessages([...base, { role: 'assistant', content: getErrorMessage(err) || 'AI 回答失败，请稍后重试', error: true }]);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col px-6 py-5">
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center mb-3">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <p className="text-xs text-slate-400 mb-1">向 AI 提问系统使用问题，基于「使用指南 / 更新日志」快速作答</p>
            <p className="text-[11px] text-slate-500 mb-4">支持追问，回答会附上参考章节</p>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {ASK_SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => void send(q)}
                  className="px-3 py-1.5 text-xs rounded-full border border-slate-700 text-slate-300 hover:border-cyan-600/60 hover:text-cyan-300 hover:bg-slate-800/60 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-1">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-xl bg-indigo-600 px-4 py-2.5">
                    <p className="text-xs text-white leading-relaxed whitespace-pre-wrap">{m.content}</p>
                  </div>
                ) : (
                  <div
                    className={`max-w-[85%] rounded-xl border px-4 py-3 ${
                      m.error ? 'border-rose-700/50 bg-rose-950/20' : 'border-slate-700 bg-slate-800/60'
                    }`}
                  >
                    {m.error ? (
                      <p className="text-xs text-rose-300 leading-relaxed">{m.content}</p>
                    ) : (
                      <MarkdownView markdown={m.content} />
                    )}
                    {!!m.sections?.length && (
                      <p className="mt-2 pt-2 border-t border-slate-700/60 text-[10px] text-slate-500">
                        参考：{m.sections.join('、')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <div className="flex justify-start">
                <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3 flex items-center space-x-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" />
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.3s]" />
                  <span className="pl-1 text-[11px] text-slate-500">AI 正在查阅帮助文档…</span>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* 输入区（固定于面板底部；消息列表独立滚动） */}
      <div className="mt-3 flex items-end space-x-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={500}
          placeholder="输入系统使用问题（Enter 发送，Shift+Enter 换行）"
          className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
        />
        <button
          onClick={() => void send()}
          disabled={pending || !input.trim()}
          title="发送"
          className="p-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-600">
        <span>回答基于帮助文档节选生成，仅供参考</span>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="text-slate-500 hover:text-slate-300 transition-colors">
            清空对话
          </button>
        )}
      </div>
    </div>
  );
};

// ---------- 帮助弹窗 ----------

type HelpTab = 'manual' | 'changelog' | 'ask';

const TAB_META: Record<HelpTab, { title: string; endpoint?: string; icon: typeof BookOpen }> = {
  manual: { title: '使用指南', endpoint: '/api/help/manual', icon: BookOpen },
  changelog: { title: '更新日志', endpoint: '/api/help/changelog', icon: History },
  ask: { title: '智能问答', icon: Sparkles },
};

interface DocContent {
  markdown: string;
  updatedAt: string | null;
}

export const HelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<HelpTab>('manual');
  // 按页签缓存内容：切换页签不重复请求，刷新按钮强制重拉当前页签
  const [contents, setContents] = useState<Partial<Record<HelpTab, DocContent>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (target: HelpTab, force = false) => {
    const endpoint = TAB_META[target].endpoint;
    if (!endpoint) return; // 智能问答页签不走文档加载
    if (!force && contents[target]) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(endpoint);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `加载${TAB_META[target].title}失败`);
      setContents((prev) => ({
        ...prev,
        [target]: { markdown: data.markdown || '', updatedAt: data.updatedAt || null },
      }));
    } catch (err) {
      setError(getErrorMessage(err) || `加载${TAB_META[target].title}失败`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load('manual');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (t: HelpTab) => {
    setTab(t);
    setError(null);
    if (t !== 'ask') void load(t);
  };

  const current = contents[tab];

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
        <div className="px-5 pt-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center">
                <BookOpen className="w-4 h-4 text-white" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">帮助中心</h2>
                <p className="text-[11px] text-slate-500">
                  {tab === 'ask'
                    ? '由 AI 基于使用指南与更新日志实时作答'
                    : current?.updatedAt
                      ? `文档更新于 ${new Date(current.updatedAt).toLocaleString('zh-CN')}`
                      : '实时读取最新文档'}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-1.5">
              {tab !== 'ask' && (
                <button
                  onClick={() => load(tab, true)}
                  title="重新加载"
                  className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              )}
              <button
                onClick={onClose}
                title="关闭（Esc）"
                className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 页签：使用指南 / 更新日志 */}
          <div className="flex space-x-1 mt-3">
            {(Object.keys(TAB_META) as HelpTab[]).map((key) => {
              const meta = TAB_META[key];
              const Icon = meta.icon;
              const active = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => switchTab(key)}
                  className={`flex items-center space-x-1.5 px-4 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-colors ${
                    active
                      ? 'text-cyan-300 border-cyan-400 bg-slate-800/60'
                      : 'text-slate-500 border-transparent hover:text-slate-300 hover:bg-slate-800/40'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{meta.title}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 内容：智能问答自带滚动区与固定输入栏；其余页签为文档滚动区 */}
        {tab === 'ask' ? (
          <AskPanel />
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {loading && !current && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                <RefreshCw className="w-6 h-6 animate-spin mb-3" />
                <p className="text-xs">正在加载{TAB_META[tab].title}…</p>
              </div>
            )}
            {error && (
              <div className="flex flex-col items-center justify-center py-16 text-rose-400">
                <FileText className="w-6 h-6 mb-3" />
                <p className="text-xs">{error}</p>
                <button
                  onClick={() => load(tab, true)}
                  className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  重试
                </button>
              </div>
            )}
            {current && !error && <MarkdownView markdown={current.markdown} />}
          </div>
        )}

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
          <span>
            {tab === 'manual'
              ? '面向使用者的操作指南，随功能更新同步维护'
              : tab === 'changelog'
                ? '按版本记录主要更新内容，供备查'
                : 'AI 回答基于帮助文档节选，仅供参考'}
          </span>
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
