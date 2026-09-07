/**
 * Prompt 资源预算控制（借鉴 Vanna max_tokens 截断机制）。
 * 本地大模型上下文有限，知识库/few-shot/历史对话无限注入会拖慢推理并稀释注意力，
 * 统一按近似 token 预算截断：中文约 1 字 1 token，取保守估计（length / 1.5）。
 */

/** 近似 token 估算（保守偏高，宁少勿超） */
export function approxTokens(text: string): number {
  return Math.ceil(String(text || '').length / 1.5);
}

/** 将文本裁剪到 token 预算内（按字符边界截断） */
export function budgetText(text: string, maxTokens: number): string {
  const t = String(text || '');
  if (approxTokens(t) <= maxTokens) return t;
  return t.slice(0, Math.max(0, Math.floor(maxTokens * 1.5)));
}

/** 知识库片段注入预算
 * v0.4.15：KNOWLEDGE_TOKEN_BUDGET 1800→2700（topK 扩容至 6 块 + 强指令更强调口径遵循，预留更多字数空间；
 * 不无限放大的理由：无关问题相关性阈值已过滤，但仍有少量命中，需保留截断防注人稀释；同时与 topK+GUIDED 保留槽位协同）。 */
export const KNOWLEDGE_TOKEN_BUDGET = 2700;
/** 外部知识库片段注入预算（与本地知识库分开控制，避免外部源挤占本地口径注入） */
export const EXTERNAL_KB_TOKEN_BUDGET = 1200;
/** few-shot 样例注入预算
 * v0.4.15：FEWSHOT_TOKEN_BUDGET 1800→3600（复杂 SQL 范式引导 + 新增 8-12 条复杂场景样例；预算上调但样例库仍按场景标签召回，避免全量堆砌导致注意力分散）。 */
export const FEWSHOT_TOKEN_BUDGET = 3600;
/** 多轮历史对话预算（保留最近若干轮，从新到旧贪心） */
export const HISTORY_TOKEN_BUDGET = 1500;

/** 历史消息按预算截断：从最新往前贪心保留，保持原始顺序返回 */
export function budgetHistory<T extends { content: string }>(messages: T[], maxTokens = HISTORY_TOKEN_BUDGET): T[] {
  const kept: T[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = approxTokens(messages[i].content);
    if (used + cost > maxTokens && kept.length > 0) break;
    used += cost;
    kept.unshift(messages[i]);
  }
  return kept;
}
