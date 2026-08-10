/**
 * 智能问数纵深防御：输入净化（L1）、上下文敏感列过滤（L3）、历史净化（L4）。
 * 全部为纯函数，服务端在 LLM 调用前强制执行，不信任前端提交的任何内容。
 */

// L1：单条提问最大长度（架构图约定 500 字，超长截断而非拒绝）
export const MAX_QUESTION_LENGTH = 500;
// L4：进入 LLM 上下文的历史轮数上限
export const MAX_HISTORY_TURNS = 5;

// 提示注入特征：命中即拒绝。清单保持保守，避免误伤正常中文业务提问。
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /forget\s+(all\s+)?(the\s+)?(previous|above)\s+(instructions?|rules?)/i,
  /忽略(你|所有|全部)?(之前|以上|上述|原先)(的)?(指令|指示|命令|提示词|规则|设定)/,
  /(忘记|忘掉)(之前|以上|上述)(的)?(指令|指示|提示词|规则|设定)/,
  /你现在是(一个)?(新|其他|别的|完全不同)/,
  /(jailbreak|越狱模式|DAN\s*模式)/i,
];

// 控制字符（保留换行与制表符，其余剥离）
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\x0B\x0C\x0E-\x1F\x7F]/g;

export function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

export type SanitizeResult =
  | { ok: true; question: string; truncated: boolean }
  | { ok: false; reason: string };

/**
 * L1 输入净化：类型校验 → 控制字符过滤 → 注入特征拒绝 → 500 字截断。
 */
export function sanitizeQuestion(raw: unknown): SanitizeResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: '查询内容格式无效' };
  }
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) {
    return { ok: false, reason: '查询内容不能为空' };
  }
  if (containsInjection(cleaned)) {
    return { ok: false, reason: '查询内容包含不允许的指令，请仅描述数据分析需求' };
  }
  if (cleaned.length > MAX_QUESTION_LENGTH) {
    return { ok: true, question: cleaned.slice(0, MAX_QUESTION_LENGTH), truncated: true };
  }
  return { ok: true, question: cleaned, truncated: false };
}

/**
 * L4 历史净化：仅保留 user 消息（assistant 输出一律丢弃，防止模型输出回流污染上下文），
 * 每条过注入检测（命中即丢弃该条），截断 500 字，最多保留最近 5 轮。
 */
export function sanitizeHistory(raw: unknown): { role: 'user'; content: string }[] {
  if (!Array.isArray(raw)) return [];
  const turns: { role: 'user'; content: string }[] = [];
  for (const m of raw) {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    const cleaned = m.content.replace(CONTROL_CHARS, '').trim();
    if (!cleaned || containsInjection(cleaned)) continue;
    turns.push({ role: 'user', content: cleaned.slice(0, MAX_QUESTION_LENGTH) });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

// L3：敏感列特征（列名或描述命中即从 AI 上下文剔除）
const SENSITIVE_COLUMN_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|id[_-]?card|idcard|身份证|密码|密钥|令牌)/i;

interface ColumnLike {
  name: string;
  description?: string;
}

interface TableLike {
  name: string;
  columns?: ColumnLike[];
}

/**
 * L3 上下文层敏感过滤：在 scope 白名单过滤之后执行，
 * 把疑似敏感列从进入 LLM 的 Schema 中剔除，返回剔除清单供 UI 标记与审计。
 */
export function filterSensitiveColumns<T extends TableLike>(schema: T[]): {
  schema: T[];
  removed: string[];
} {
  const removed: string[] = [];
  const filtered = (Array.isArray(schema) ? schema : []).map((table) => {
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const kept = columns.filter((c) => {
      const text = `${c?.name || ''} ${c?.description || ''}`;
      if (SENSITIVE_COLUMN_PATTERN.test(text)) {
        removed.push(`${table.name}.${c?.name || ''}`);
        return false;
      }
      return true;
    });
    return { ...table, columns: kept };
  });
  return { schema: filtered, removed };
}
