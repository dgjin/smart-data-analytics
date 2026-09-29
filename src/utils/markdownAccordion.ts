/**
 * 帮助中心文档「模块抽屉」切分（v0.9.89）：
 * 把 Markdown 帮助文档按 ## 模块标题切成可折叠段，用于帮助弹窗的抽屉收缩展示。
 * - 首个 ## 之前的内容（含 h1 文档标题与前言）归为头部段（title 为 null，直接展示不折叠）；
 * - 每个 ## 及其后续内容为一段，title 为模块名（不含 ## 行，标题由抽屉头部展示）；
 * - ### 子标题保留在段内随内容渲染；
 * - 纯函数：头部段无实质内容时丢弃；空文档返回空数组，不抛错。
 */

export interface AccordionSection {
  /** 模块标题；null 表示文档头部段（h1 + 前言），直接展示不折叠 */
  title: string | null;
  /** 该段 Markdown（模块段不含 ## 标题行；头部段为原始内容） */
  markdown: string;
}

/** ## 模块标题正则（与 server/help/helpSearch 的章节切分口径一致：## 为模块边界，### 留在段内） */
const H2_RE = /^##\s+(.*)$/;

/** Markdown → 抽屉段列表（头部段 + 各 ## 模块段） */
export function splitDocForAccordion(markdown: string): AccordionSection[] {
  const lines = String(markdown || '').split(/\r?\n/);
  const out: AccordionSection[] = [];
  let title: string | null = null;
  let buf: string[] = [];

  const push = () => {
    const text = buf.join('\n').trim();
    if (title !== null) {
      out.push({ title, markdown: text }); // 模块段：标题内联展示，正文可为空但保留结构
    } else if (text) {
      out.push({ title: null, markdown: text }); // 头部段仅有 h1 / 前言时保留
    }
    buf = [];
  };

  for (const line of lines) {
    const m = H2_RE.exec(line);
    if (m) {
      push();
      title = m[1].trim();
      continue;
    }
    buf.push(line);
  }
  push();
  return out;
}
