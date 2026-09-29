/**
 * 帮助中心「智能问答」业务逻辑（v0.9.88）：
 * 读取帮助文档（用户使用指南 + 更新日志）→ 章节级检索选取相关片段 → 组装提示词 → 调用 LLM 回答。
 * 与问数链路的区别：仅依据帮助文档回答「系统怎么用」，不接触业务数据与数据库；
 * 文档未覆盖的问题由提示词约束模型如实说明，不编造功能。
 */
import { callLLMText } from '../llm/llmClient';
import { CHANGELOG_FILENAME, candidatePathsFor, readDoc, readManual } from './helpDocs';
import { selectHelpSections } from './helpSearch';

export interface HelpAskTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface HelpAskResult {
  answer: string;
  /** 命中的帮助文档章节（「来源 · 标题」），前端作为参考来源展示 */
  sections: string[];
}

/** 问题长度上限（路由层校验同源使用） */
export const MAX_QUESTION_CHARS = 500;
/** 单条历史消息截断长度 */
const MAX_HISTORY_CHARS = 300;
/** 最多携带的最近历史条数（3 轮问答） */
const MAX_HISTORY_MESSAGES = 6;
const TOP_K_SECTIONS = 5;
const MAX_CONTEXT_CHARS = 6000;

/** 清洗前端传来的对话历史：仅保留合法 user/assistant 文本，超长截断、只留最近 6 条 */
export function normalizeHelpHistory(raw: unknown): HelpAskTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HelpAskTurn[] = [];
  for (const item of raw) {
    const turn = item as HelpAskTurn | null;
    const role = turn?.role;
    const content = String(turn?.content || '').trim();
    if ((role === 'user' || role === 'assistant') && content) {
      out.push({ role, content: content.slice(0, MAX_HISTORY_CHARS) });
    }
  }
  return out.slice(-MAX_HISTORY_MESSAGES);
}

function buildSystemPrompt(context: string): string {
  return `你是「智能问数分析系统」的官方帮助助手，只依据下面提供的帮助文档节选，回答用户关于本系统的使用问题。

回答要求：
1. 只依据文档节选回答；节选未覆盖、或标注「未检索到相关章节」时，明确说明帮助文档中没有找到相关内容，建议用户切换到「使用指南」页签查阅全文或联系管理员，不要编造功能与操作步骤。
2. 先给结论、再给必要步骤，界面路径用「系统管理 → 规则治理」这类写法；回答保持简洁，2~6 条要点为宜。
3. 功能名称与文档保持一致，不要发明新名词；可以少量使用 Markdown 加粗与列表。
4. 仅回答本系统的使用问题：无关话题（闲聊、其他软件）礼貌说明你只负责本系统帮助；查询业务数据请引导用户使用「智能问答」问数功能。

帮助文档节选：
${context}`;
}

/** 帮助问答主流程：读取文档 → 检索相关章节 → 调用 LLM；文档缺失或模型失败时抛错由路由兜底 */
export async function answerHelpQuestion(question: string, history: HelpAskTurn[] = []): Promise<HelpAskResult> {
  const sources: { label: string; markdown: string }[] = [];
  const manual = readManual();
  if (manual) sources.push({ label: '用户使用指南', markdown: manual.markdown });
  const changelog = readDoc(candidatePathsFor(CHANGELOG_FILENAME));
  if (changelog) sources.push({ label: '更新日志', markdown: changelog.markdown });
  if (sources.length === 0) {
    throw new Error('帮助文档缺失（docs/核心文档 下未找到使用指南或更新日志）');
  }

  const picked = selectHelpSections(sources, question, { topK: TOP_K_SECTIONS, maxChars: MAX_CONTEXT_CHARS });
  const context = picked.length
    ? picked.map((s) => `【${s.source} · ${s.title}】\n${s.content}`).join('\n\n---\n\n')
    : '（未检索到相关章节）';

  const historyText = history.length
    ? `最近对话（供理解指代，如「它」「这个功能」）：\n${history
        .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`)
        .join('\n')}\n\n`
    : '';

  const answer = String((await callLLMText(buildSystemPrompt(context), `${historyText}用户问题：${question}`)) || '').trim();
  if (!answer) throw new Error('AI 未返回内容');
  return { answer, sections: picked.map((s) => `${s.source} · ${s.title}`) };
}
