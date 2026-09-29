/**
 * 帮助文档章节级检索（v0.9.88 帮助中心「智能问答」；v0.9.89 扩展关键词搜索 searchHelpDocs）：
 * 无 embedding 依赖的轻量词法检索——按 Markdown 标题（## / ###）把帮助文档切成章节，
 * 以「中文 bigram 集合重叠度」打分（标题命中加权 3 倍、长章节做长度惩罚），
 * 取最相关的若干章节组成问答上下文，控制提示词体量、提升本地模型响应速度；
 * 搜索场景复用同一打分口径，但不设上下文预算，返回「标题 + 来源 + 摘要」供列表展示。
 * 纯函数、无模块级状态；对空文档 / 异常输入返回空结果，不抛错。
 */

export interface HelpDocSource {
  /** 文档展示名（如「用户使用指南」），用于上下文标注与来源提示 */
  label: string;
  markdown: string;
}

export interface HelpSection {
  /** 章节标题；含父级链（如「3. 智能问答 · 怎么看结果」） */
  title: string;
  content: string;
  /** 来源文档 label */
  source: string;
  /** 相关度得分（标题命中 ×3 + 正文命中，除以 sqrt(正文 bigram 数 + 50) 做长度惩罚） */
  score: number;
}

/** 文本 → bigram 集合：小写、去符号与空白；单字符文本退化为其自身 */
export function bigramSet(text: string): Set<string> {
  const clean = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set<string>();
  if (!clean) return out;
  if (clean.length === 1) {
    out.add(clean);
    return out;
  }
  for (let i = 0; i + 1 < clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 把 Markdown 切成章节：
 * - ## / ### 标题为边界，### 标题自动拼接最近的 ## 父级（「父 · 子」）；
 * - 首个标题前的非空内容归入「文档概述」；h1（#）视为文档主标题跳过；
 * - 正文全空的章节丢弃（无检索价值）。
 */
export function splitMarkdownSections(markdown: string): { title: string; content: string }[] {
  const lines = String(markdown || '').split(/\r?\n/);
  const out: { title: string; content: string }[] = [];
  let h2 = '';
  let cur: { title: string; lines: string[] } | null = null;

  const push = () => {
    if (!cur) return;
    const content = cur.lines.join('\n').trim();
    if (content) out.push({ title: cur.title, content });
    cur = null;
  };

  for (const line of lines) {
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) {
      push();
      const title = m[2].trim();
      if (m[1].length === 2) {
        h2 = title;
        cur = { title, lines: [] };
      } else {
        cur = { title: h2 ? `${h2} · ${title}` : title, lines: [] };
      }
      continue;
    }
    if (/^#\s+/.test(line)) {
      push();
      continue;
    }
    if (!cur) {
      if (line.trim()) cur = { title: '文档概述', lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  push();
  return out;
}

/** 参与评分的正文长度上限（说明书兜底场景单章可达数十 KB，截断保证检索耗时稳定） */
const MAX_SCORE_BODY_CHARS = 8000;

function scoreSection(questionBigrams: Set<string>, title: string, body: string): number {
  if (questionBigrams.size === 0) return 0;
  const titleBigrams = bigramSet(title);
  let hits = 0;
  for (const g of questionBigrams) if (titleBigrams.has(g)) hits += 3;
  const bodyBigrams = bigramSet(String(body || '').slice(0, MAX_SCORE_BODY_CHARS));
  for (const g of questionBigrams) if (bodyBigrams.has(g)) hits += 1;
  if (hits === 0) return 0;
  return hits / Math.sqrt(bodyBigrams.size + 50);
}

export interface SelectSectionsOpts {
  /** 最多返回章节数（默认 5） */
  topK?: number;
  /** 上下文总字符预算（默认 6000），超出预算的章节截断、预算耗尽的跳过 */
  maxChars?: number;
}

/**
 * 问题侧疑问 / 口语填充词：检索前先剔除。
 * 只在问题侧处理——文档正文中的「怎么 / 哪里」属于真实内容，不做剔除。
 * 词序长的在前（「在哪里」先于「哪里 / 在哪」匹配），避免残留「里设置」类碎片。
 */
const QUESTION_FILLER_RE = /为什么|在哪里|怎么|如何|什么|哪些|哪个|哪里|哪儿|在哪|是否|能否|请问|告诉我|帮我|帮忙|一下/g;

/** 剔除问题中的疑问/口语填充词（导出供测试）；剔除后无实词时回退原文，保证不产生空问题 */
export function stripQuestionFillers(question: string): string {
  const text = String(question || '');
  const stripped = text.replace(QUESTION_FILLER_RE, ' ');
  return /[\p{L}\p{N}]/u.test(stripped) ? stripped : text;
}

/** 从多份帮助文档中检出与问题最相关的章节（按得分降序，受 topK 与 maxChars 双重约束） */
export function selectHelpSections(
  sources: HelpDocSource[],
  question: string,
  opts: SelectSectionsOpts = {},
): HelpSection[] {
  const topK = Math.max(1, Math.floor(opts.topK ?? 5));
  const maxChars = Math.max(500, Math.floor(opts.maxChars ?? 6000));
  // 先剔除疑问/口语填充词：避免「怎么 / 哪里」等纯疑问词命中
  // 「3. 智能问答：怎么问、怎么看」类父链标题，把真正相关的章节（如「数据管理」）挤出 topK
  const questionBigrams = bigramSet(stripQuestionFillers(question));
  if (questionBigrams.size === 0) return [];

  const scored: HelpSection[] = [];
  for (const src of sources) {
    const label = String(src?.label || '').trim() || '帮助文档';
    for (const sec of splitMarkdownSections(String(src?.markdown || ''))) {
      const score = scoreSection(questionBigrams, sec.title, sec.content);
      if (score > 0) scored.push({ ...sec, source: label, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const picked: HelpSection[] = [];
  let used = 0;
  for (const sec of scored) {
    if (picked.length >= topK) break;
    const remain = maxChars - used;
    if (remain < 200) break; // 预算不足以容纳有意义的片段
    const content = sec.content.length > remain ? sec.content.slice(0, remain) : sec.content;
    picked.push({ ...sec, content });
    used += content.length;
  }
  return picked;
}

// ---------- 帮助文档关键词搜索（v0.9.89） ----------

/** 搜索关键词长度上限（路由层校验同源使用） */
export const MAX_SEARCH_CHARS = 100;
/** 摘要片段长度上限（超出截断并加省略号） */
const SNIPPET_CHARS = 120;
/** 搜索默认返回条数上限 */
const SEARCH_TOP_K = 20;

export interface HelpSearchHit {
  /** 章节标题（含父链，如「3. 智能问答：怎么问、怎么看 · 历史对话」） */
  title: string;
  /** 来源文档 label */
  source: string;
  /** 命中摘要：围绕首个命中行截取的正文片段（已清洗 Markdown 标记，不超过 120 字） */
  snippet: string;
  /** 相关度得分（与 selectHelpSections 同口径） */
  score: number;
}

/** 行级 Markdown 标记清洗：标题井号、列表/引用前缀、加粗/行内代码记号、表格竖线 → 纯文本摘要 */
function cleanMarkdownLine(line: string): string {
  return String(line || '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[->*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 生成命中摘要：从首个与关键词 bigram 有交集的行开始向后拼接，超长截断加省略号；仅标题命中时取正文开头 */
function buildSnippet(body: string, queryBigrams: Set<string>): string {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map(cleanMarkdownLine)
    .filter(Boolean);
  if (lines.length === 0) return '';
  const hitAt = lines.findIndex((line) => {
    const gs = bigramSet(line);
    for (const g of queryBigrams) if (gs.has(g)) return true;
    return false;
  });
  let text = '';
  let truncated = false;
  for (const line of hitAt >= 0 ? lines.slice(hitAt) : lines) {
    text += (text ? ' ' : '') + line;
    if (text.length > SNIPPET_CHARS) {
      text = text.slice(0, SNIPPET_CHARS);
      truncated = true;
      break;
    }
  }
  return truncated ? `${text}…` : text;
}

/**
 * 关键词搜索帮助文档（v0.9.89）：与智能问答共用分词与打分口径，但不设上下文预算，
 * 命中章节按相关度降序返回「标题 + 来源 + 摘要」，供帮助中心搜索框展示与跳转定位。
 */
export function searchHelpDocs(
  sources: HelpDocSource[],
  query: string,
  opts: { topK?: number } = {},
): HelpSearchHit[] {
  const topK = Math.max(1, Math.floor(opts.topK ?? SEARCH_TOP_K));
  const queryBigrams = bigramSet(stripQuestionFillers(query));
  if (queryBigrams.size === 0) return [];

  const hits: HelpSearchHit[] = [];
  for (const src of sources) {
    const label = String(src?.label || '').trim() || '帮助文档';
    for (const sec of splitMarkdownSections(String(src?.markdown || ''))) {
      const score = scoreSection(queryBigrams, sec.title, sec.content);
      if (score > 0) {
        hits.push({ title: sec.title, source: label, snippet: buildSnippet(sec.content, queryBigrams), score });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}
