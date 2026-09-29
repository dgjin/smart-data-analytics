/**
 * 系统帮助弹窗：实时读取 docs/核心文档 下帮助文档（GET /api/help/manual、/api/help/changelog）并渲染。
 * 「使用指南」面向终端用户回答「系统怎么用」（服务端在指南缺失时回退功能说明书）；
 * 「更新日志」按版本记录主要更新内容，供用户备查（v0.9.36）。
 * v0.9.89：
 * - 文档按 ## 模块以「抽屉」收缩展示（默认展开首个模块，支持全部展开/收起）；
 * - 头部搜索框跨使用指南与更新日志检索章节（GET /api/help/search），
 *   结果显示来源/标题/摘要（高亮关键词），点击跳转到对应页签并展开定位该模块。
 * v0.9.90（检索体验）：
 * - 搜索采用 stale-while-revalidate：再次检索期间保留上次结果（标题行提示「正在搜索」），
 *   仅在无结果可展示时显示加载态，消除输入过程中「结果 ↔ 加载」反复替换的闪烁；
 * - 文档视图搜索时仅隐藏不卸载且保留滚动位置，清空搜索后原位置恢复，不再跳回顶部；
 * - MarkdownView 以 memo 渲染，输入搜索词时跳过文档重解析。
 * 「智能问答」（v0.9.88）：基于帮助文档章节检索 + LLM 快速回答使用问题（POST /api/help/ask），
 * 支持多轮追问，回答附命中章节作为参考来源。
 * 内置轻量 Markdown 渲染器（标题/表格/列表/代码块/引用/加粗/行内代码），
 * 不引入第三方 markdown 依赖，保证与文档文件始终一致。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, BookOpen, RefreshCw, FileText, History, Sparkles, Send, Search, ChevronDown } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import { splitDocForAccordion } from '../../utils/markdownAccordion';

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

const MarkdownViewInner: React.FC<{ markdown: string }> = ({ markdown }) => {
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

/** memo：搜索输入等高频重渲染场景下，同一段 markdown 跳过重复解析（v0.9.90） */
export const MarkdownView = React.memo(MarkdownViewInner);

// ---------- 文档模块抽屉与搜索（v0.9.89） ----------

interface HelpSearchHit {
  title: string;
  source: string;
  snippet: string;
  score: number;
}

/** 摘要高亮词剥离：与 server/help/helpSearch 的填充词同款正则（仅影响高亮显示，不参与检索） */
const SNIPPET_FILLER_RE = /为什么|在哪里|怎么|如何|什么|哪些|哪个|哪里|哪儿|在哪|是否|能否|请问|告诉我|帮我|帮忙|一下/g;

/** 摘要高亮：优先匹配完整关键词，其次匹配剔除疑问/口语词后的短语；均未命中则原样展示 */
function renderHighlightedSnippet(snippet: string, query: string): React.ReactNode {
  const candidates = [query, query.replace(SNIPPET_FILLER_RE, ' ').replace(/\s+/g, ' ').trim()].filter(
    (t) => t.length >= 2,
  );
  const lower = snippet.toLowerCase();
  const hit = candidates.find((c) => lower.includes(c.toLowerCase()));
  if (!hit) return snippet;
  const lc = hit.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let rest = snippet;
  while (true) {
    const at = rest.toLowerCase().indexOf(lc);
    if (at < 0) {
      if (rest) nodes.push(<React.Fragment key={nodes.length}>{rest}</React.Fragment>);
      break;
    }
    if (at > 0) nodes.push(<React.Fragment key={nodes.length}>{rest.slice(0, at)}</React.Fragment>);
    nodes.push(
      <mark key={nodes.length} className="bg-cyan-500/20 text-cyan-200 rounded px-0.5">
        {rest.slice(at, at + hit.length)}
      </mark>
    );
    rest = rest.slice(at + hit.length);
  }
  return <>{nodes}</>;
}

/** 模块抽屉：标题行点击展开/收起，展开后渲染模块正文（含 ### 子标题） */
const DrawerSection: React.FC<{
  title: string;
  markdown: string;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
}> = ({ title, markdown, expanded, highlighted, onToggle }) => (
  <div
    data-accordion-title={title}
    className={`rounded-xl border transition-colors ${
      highlighted ? 'border-cyan-500/70 bg-cyan-500/5' : 'border-slate-800 bg-slate-900/40'
    }`}
  >
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full flex items-center justify-between px-4 py-3 text-left group"
    >
      <span
        className={`text-sm font-semibold transition-colors ${
          expanded ? 'text-cyan-300' : 'text-slate-200 group-hover:text-cyan-300'
        }`}
      >
        {title}
      </span>
      <ChevronDown className={`w-4 h-4 shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
    {expanded && (
      <div className="px-4 pb-3 pt-2 border-t border-slate-800/70">
        <MarkdownView markdown={markdown} />
      </div>
    )}
  </div>
);

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
  // 抽屉展开集合（key = `${tab}::${模块标题}`）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 搜索状态：query 非空时内容区显示搜索结果
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<HelpSearchHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // 搜索跳转：待定位模块（页签 + 标题），渲染后滚动展开并短暂高亮
  const [pendingScroll, setPendingScroll] = useState<{ tab: HelpTab; title: string } | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<number | null>(null);
  const searchSeq = useRef(0);
  // v0.9.90：文档滚动位置暂存（进入搜索前保存；用户清空搜索后在绘制前恢复，避免跳回顶部）
  const savedScrollRef = useRef(0);
  const restoreScrollRef = useRef(false);

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
      const markdown = data.markdown || '';
      setContents((prev) => ({
        ...prev,
        [target]: { markdown, updatedAt: data.updatedAt || null },
      }));
      // 默认展开首个模块（仅当该页签尚无任何展开项时，保留用户已有的收起选择）
      const first = splitDocForAccordion(markdown).find((s) => s.title);
      if (first?.title) {
        setExpanded((prev) => {
          const key = `${target}::${first.title}`;
          if (prev.has(key) || [...prev].some((k) => k.startsWith(`${target}::`))) return prev;
          return new Set(prev).add(key);
        });
      }
    } catch (err) {
      setError(getErrorMessage(err) || `加载${TAB_META[target].title}失败`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load('manual');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc：搜索词非空时先清空搜索，否则关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (query.trim()) {
        clearSearch(true);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, onClose]);

  // 搜索防抖：输入停顿 250ms 后请求；序号机制丢弃过期响应，避免旧结果覆盖新结果
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    setSearchError(null); // 新查询开始，清除上一次的错误态（v0.9.90）
    setSearchLoading(true);
    const timer = window.setTimeout(() => void runSearch(q), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 搜索跳转：目标页签文档就绪后，滚动到对应模块并短暂高亮
  useEffect(() => {
    if (!pendingScroll || tab !== pendingScroll.tab || !contents[pendingScroll.tab]) return;
    const container = scrollRef.current;
    const node = container
      ? Array.from(container.querySelectorAll<HTMLElement>('[data-accordion-title]')).find(
          (el) => el.dataset.accordionTitle === pendingScroll.title,
        )
      : undefined;
    if (container) {
      if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else container.scrollTo({ top: 0 }); // 命中「文档概述」等头部内容时回到顶部
    }
    const key = `${pendingScroll.tab}::${pendingScroll.title}`;
    setHighlightKey(key);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightKey(null), 2000);
    setPendingScroll(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScroll, tab, contents]);

  const runSearch = async (q: string) => {
    const seq = ++searchSeq.current;
    try {
      const res = await apiFetch(`/api/help/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (seq !== searchSeq.current) return; // 已有更新查询发出，丢弃过期响应
      if (!res.ok) throw new Error(data.error || '搜索失败');
      setSearchResults(Array.isArray(data.results) ? data.results : []);
      setSearchError(null);
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setSearchError(getErrorMessage(err) || '搜索失败');
      setSearchResults(null);
    } finally {
      if (seq === searchSeq.current) setSearchLoading(false);
    }
  };

  /** 清空搜索；restoreScroll=true（用户主动清空）时清空后恢复文档原滚动位置（v0.9.90） */
  const clearSearch = (restoreScroll = false) => {
    searchSeq.current++; // 使在途请求失效
    if (restoreScroll && searchActive) restoreScrollRef.current = true;
    setQuery('');
    setSearchResults(null);
    setSearchError(null);
    setSearchLoading(false);
  };

  const switchTab = (t: HelpTab) => {
    setTab(t);
    setError(null);
    clearSearch(); // 切换页签回到文档视图
    if (t !== 'ask') void load(t);
  };

  const toggleDrawer = (t: HelpTab, title: string) => {
    const key = `${t}::${title}`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 搜索结果点击：切页签 + 展开命中模块（### 命中时定位其父 ## 模块）并滚动定位 */
  const jumpToHit = (r: HelpSearchHit) => {
    const targetTab: HelpTab = r.source === '更新日志' ? 'changelog' : 'manual';
    const parentTitle = r.title.split(' · ')[0];
    clearSearch();
    setTab(targetTab);
    setError(null);
    void load(targetTab);
    setExpanded((prev) => new Set(prev).add(`${targetTab}::${parentTitle}`));
    setPendingScroll({ tab: targetTab, title: parentTitle });
  };

  const current = contents[tab];
  const searchActive = query.trim().length > 0;
  const sections = useMemo(() => (current ? splitDocForAccordion(current.markdown) : []), [current]);
  const moduleTitles = useMemo(() => sections.filter((s) => s.title).map((s) => s.title as string), [sections]);
  const allExpanded = moduleTitles.length > 0 && moduleTitles.every((t) => expanded.has(`${tab}::${t}`));
  const toggleAll = () => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const t of moduleTitles) {
        if (allExpanded) next.delete(`${tab}::${t}`);
        else next.add(`${tab}::${t}`);
      }
      return next;
    });
  };

  // v0.9.90：用户清空搜索后，在浏览器绘制前把文档视图恢复到搜索前的滚动位置（无可见跳动）
  useLayoutEffect(() => {
    if (searchActive || !restoreScrollRef.current) return;
    restoreScrollRef.current = false;
    if (scrollRef.current) scrollRef.current.scrollTop = savedScrollRef.current;
  }, [searchActive]);

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
                    : searchActive
                      ? '跨「使用指南 / 更新日志」搜索章节'
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

          {/* 页签 + 搜索框（搜索跨使用指南与更新日志） */}
          <div className="flex items-end justify-between gap-3 mt-3">
            <div className="flex space-x-1">
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
            {tab !== 'ask' && (
              <div className="relative mb-0.5">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => {
                    // 进入搜索前记录文档滚动位置（v0.9.90）
                    if (!searchActive && scrollRef.current) savedScrollRef.current = scrollRef.current.scrollTop;
                    setQuery(e.target.value);
                  }}
                  placeholder="搜索帮助内容…"
                  aria-label="搜索帮助内容"
                  className="w-56 pl-8 pr-7 py-1.5 rounded-lg border border-slate-700 bg-slate-950/60 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-600/70"
                />
                {query && (
                  <button
                    onClick={() => clearSearch(true)}
                    title="清空搜索"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 内容：智能问答自带滚动区与固定输入栏；文档页签为「模块抽屉」滚动区；搜索词非空时显示结果列表 */}
        {tab === 'ask' && <AskPanel />}
        {/* 文档视图：搜索时仅隐藏不卸载（保留 DOM 与滚动位置），清空搜索后原样恢复展示（v0.9.90） */}
        {tab !== 'ask' && (
          <div ref={scrollRef} className={`flex-1 overflow-y-auto px-6 py-5 ${searchActive ? 'hidden' : ''}`}>
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
            {current && !error && (
              <div className="space-y-2">
                {/* 模块工具条：模块计数 + 全部展开 / 收起 */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-slate-500">共 {moduleTitles.length} 个模块，点击标题展开 / 收起</span>
                  {moduleTitles.length > 0 && (
                    <button onClick={toggleAll} className="text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors">
                      {allExpanded ? '全部收起' : '全部展开'}
                    </button>
                  )}
                </div>
                {sections.map((s, i) => {
                  if (!s.title) {
                    return (
                      <div key={`${tab}-head-${i}`}>
                        <MarkdownView markdown={s.markdown} />
                      </div>
                    );
                  }
                  const title = s.title;
                  const key = `${tab}::${title}`;
                  return (
                    <DrawerSection
                      key={`${tab}-${title}-${i}`}
                      title={title}
                      markdown={s.markdown}
                      expanded={expanded.has(key)}
                      highlighted={highlightKey === key}
                      onToggle={() => toggleDrawer(tab, title)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* 搜索结果视图：加载中保留上次结果（stale-while-revalidate），避免结果与加载态反复替换闪烁（v0.9.90） */}
        {tab !== 'ask' && searchActive && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {!searchError && (searchResults === null || (searchLoading && searchResults.length === 0)) && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                <RefreshCw className="w-6 h-6 animate-spin mb-3" />
                <p className="text-xs">正在搜索「{query.trim()}」…</p>
              </div>
            )}
            {!searchLoading && searchError && (
              <div className="flex flex-col items-center justify-center py-16 text-rose-400">
                <FileText className="w-6 h-6 mb-3" />
                <p className="text-xs">{searchError}</p>
                <button
                  onClick={() => void runSearch(query.trim())}
                  className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  重试
                </button>
              </div>
            )}
            {!searchLoading && !searchError && searchResults && searchResults.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                <Search className="w-6 h-6 mb-3" />
                <p className="text-xs">未找到与「{query.trim()}」相关的章节，试试更短的关键词</p>
                <p className="text-[11px] text-slate-600 mt-1.5">也可以切换到「智能问答」直接用自然语言提问</p>
              </div>
            )}
            {!searchError && !!searchResults?.length && (
              <div className="space-y-2">
                <p className="text-[11px] text-slate-500 mb-1 flex items-center space-x-1.5">
                  {searchLoading ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>正在搜索，以下为上次结果…</span>
                    </>
                  ) : (
                    <span>找到 {searchResults.length} 个相关章节，点击跳转</span>
                  )}
                </p>
                {searchResults.map((r, i) => (
                  <button
                    key={`${r.source}-${r.title}-${i}`}
                    onClick={() => jumpToHit(r)}
                    className="w-full text-left rounded-xl border border-slate-800 hover:border-cyan-600/60 hover:bg-slate-800/40 px-4 py-3 transition-colors group"
                  >
                    <div className="flex items-center space-x-2 mb-1">
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 shrink-0">
                        {r.source}
                      </span>
                      <span className="text-xs font-semibold text-slate-200 group-hover:text-cyan-300 truncate">
                        {r.title}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed">{renderHighlightedSnippet(r.snippet, query.trim())}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
          <span>
            {searchActive
              ? '搜索范围：使用指南 + 更新日志，点击结果跳转对应模块'
              : tab === 'manual'
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
