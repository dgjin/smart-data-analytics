/**
 * P1-1 上下文仲裁器（v0.9.110）：问数阶段一注入面扩至「铁律/指标/本体/业务口径/知识」五类后，
 * 各块独立按预算注入会互相稀释注意力，且不同来源可能对同一事实给出相反写法。
 * 本模块统一做三件事（纯函数、无 IO，便于单测与 trace 统计）：
 * 1) 固定优先级排序：铁律 > 指标 > 本体 > 业务口径 > 知识，越靠前越晚被裁剪；
 * 2) 去重与冲突裁剪：跨块重复行丢弃；同一 `表.列 = 值` 事实与高优先级块矛盾时丢弃低优先级行并记 warning；
 * 3) 总预算裁剪：超出预算时从最低优先级块尾部逐行裁剪。
 * 仅做「文本裁决」，不拼 SQL、不改写业务语义；执行层表白名单仍是最终兜底。
 */
import { approxTokens } from '../llm/promptBudget';

export type ContextBlockKind = 'iron' | 'metric' | 'ontology' | 'guidance' | 'knowledge';

/** 优先级从高到低（数组顺序即注入顺序） */
export const CONTEXT_PRIORITY: ContextBlockKind[] = ['iron', 'metric', 'ontology', 'guidance', 'knowledge'];

export interface ContextArbiterInput {
  /** 铁律规则段（最高优先级，恒注入） */
  iron?: string;
  /** 语义指标层段 */
  metric?: string;
  /** 业务本体段（实体/值域/关联路径/层级） */
  ontology?: string;
  /** 可用维度与指标摘要 */
  guidance?: string;
  /** 知识库 / 外部知识 / 历史沉淀段 */
  knowledge?: string;
}

export interface ContextBlockStat {
  /** 最终注入行数（含空行，按 split('\n') 口径） */
  lines: number;
  /** 最终注入近似 token */
  tokens: number;
  /** 被去重/冲突/预算裁剪掉的行数 */
  dropped: number;
}

export interface ContextArbiterStats {
  /** 总预算（近似 token） */
  budgetTokens: number;
  /** 实际注入近似 token */
  totalTokens: number;
  byKind: Record<ContextBlockKind, ContextBlockStat>;
  /** 跨块重复丢弃行数 */
  deduped: number;
  /** `表.列 = 值` 冲突丢弃行数 */
  conflicts: number;
  /** 预算裁剪丢弃行数 */
  trimmed: number;
  /** 冲突明细（截断保留，便于 trace 展示与排障） */
  warnings: string[];
}

export interface ContextArbiterResult {
  /** 按优先级排序、已裁剪的块（仅非空） */
  blocks: { kind: ContextBlockKind; text: string }[];
  /** 按优先级拼接后的完整文本（便于调试/单测；liveQuery 按块注入 V2 提示词） */
  text: string;
  stats: ContextArbiterStats;
}

/** 默认总预算：五类块合计超出该量级通常说明重复堆砌，按最低优先级裁剪保注意力 */
export const CONTEXT_ARBITER_TOKEN_BUDGET = 6000;

/** 单条冲突 warning 截断长度与条数上限（防止 trace 被超长行撑爆） */
const WARNING_LINE_MAX = 80;
const WARNING_KEEP_MAX = 20;

/** 事实模式：`表.列 = 值`（本体值域释义、铁律约束等统一形态），表/列须合法标识符 */
const FACT_RE = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*[=＝]\s*('[^']*'|"[^"]*"|[^\s,，;；)）]+)/g;

/** 值归一化：去引号、去空白、小写（`'1'` 与 `1`、`A` 与 `a` 视为同值） */
function normalizeValue(raw: string): string {
  return raw.replace(/^['"]+|['"]+$/g, '').trim().toLowerCase();
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/** 提取行内全部 `表.列 = 值` 事实；占位符（释义模板）与空值不参与冲突判定 */
function extractFacts(line: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  FACT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FACT_RE.exec(line)) !== null) {
    const value = normalizeValue(m[3]);
    if (!value || value === '值' || value === 'value' || value === 'xxx') continue;
    out.push({ key: `${m[1]}.${m[2]}`.toLowerCase(), value });
  }
  return out;
}

function emptyStat(): ContextBlockStat {
  return { lines: 0, tokens: 0, dropped: 0 };
}

interface KeptBlock {
  kind: ContextBlockKind;
  /** 原始文本（未被裁剪时原样注入，保证格式/换行零改动） */
  original: string;
  lines: string[];
  dropped: number;
}

/**
 * 上下文仲裁：排序 → 跨块去重 → `表.列 = 值` 冲突裁剪 → 总预算尾部裁剪。
 * @param input 五类文本块（缺失/空串视为未命中，零注入）
 * @param opts.budgetTokens 总预算（近似 token），缺省 CONTEXT_ARBITER_TOKEN_BUDGET
 */
export function arbitrateContext(
  input: ContextArbiterInput,
  opts: { budgetTokens?: number } = {}
): ContextArbiterResult {
  const rawBudget = opts.budgetTokens ?? (Number(process.env.CONTEXT_ARBITER_TOKEN_BUDGET) || CONTEXT_ARBITER_TOKEN_BUDGET);
  const budgetTokens = Math.max(0, Math.floor(rawBudget));
  const stats: ContextArbiterStats = {
    budgetTokens,
    totalTokens: 0,
    byKind: {
      iron: emptyStat(),
      metric: emptyStat(),
      ontology: emptyStat(),
      guidance: emptyStat(),
      knowledge: emptyStat(),
    },
    deduped: 0,
    conflicts: 0,
    trimmed: 0,
    warnings: [],
  };

  // 已出现行（高优先级先登记）与已确认事实（key -> 首个高优先级取值）
  const seenLines = new Set<string>();
  const facts = new Map<string, { value: string; kind: ContextBlockKind }>();
  const kept: KeptBlock[] = [];

  for (const kind of CONTEXT_PRIORITY) {
    const raw = String(input?.[kind] || '');
    if (!raw.trim()) {
      kept.push({ kind, original: '', lines: [], dropped: 0 });
      continue;
    }
    const lines = raw.split('\n');
    const out: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      const norm = normalizeLine(line);
      if (!norm) {
        out.push(line);
        continue;
      }
      // 1) 跨块去重：低优先级块重复同一行直接丢弃（同块内重复亦收敛）
      if (seenLines.has(norm)) {
        dropped++;
        stats.deduped++;
        continue;
      }
      // 2) 事实冲突：与更高优先级块同列不同值 → 丢弃低优先级行（只跨块判定，避免块内自伤）
      const lineFacts = extractFacts(line);
      const conflicts = lineFacts.filter((f) => {
        const prev = facts.get(f.key);
        return prev !== undefined && prev.kind !== kind && prev.value !== f.value;
      });
      if (conflicts.length > 0) {
        dropped++;
        stats.conflicts++;
        if (stats.warnings.length < WARNING_KEEP_MAX) {
          const detail = conflicts.map((c) => `${c.key}=${c.value}`).join('、');
          stats.warnings.push(`[${kind}] 丢弃与高优先级块冲突的行（${detail}）：${norm.slice(0, WARNING_LINE_MAX)}`);
        }
        continue;
      }
      out.push(line);
      seenLines.add(norm);
      for (const f of lineFacts) {
        if (!facts.has(f.key)) facts.set(f.key, { value: f.value, kind });
      }
    }
    kept.push({ kind, original: raw, lines: out, dropped });
  }

  // 3) 总预算裁剪：从最低优先级块（knowledge）尾部逐行弹出，铁律最后才动
  const totalCost = () => kept.reduce((s, b) => s + approxTokens(b.lines.join('\n')), 0);
  let total = totalCost();
  for (let i = kept.length - 1; i >= 0 && total > budgetTokens; i--) {
    const block = kept[i];
    while (block.lines.length > 0 && total > budgetTokens) {
      const removed = block.lines.pop() as string;
      block.dropped++;
      if (removed.trim()) stats.trimmed++;
      total = totalCost();
    }
  }

  const blocks = kept
    .filter((b) => b.lines.join('\n').trim())
    .map((b) => ({
      kind: b.kind,
      // 未裁剪块保留原始文本（换行/缩进零改动）；有裁剪时按保留行重建
      text: b.dropped === 0 ? b.original.trimEnd() : b.lines.join('\n').trimEnd(),
    }));

  for (const b of blocks) {
    stats.byKind[b.kind] = {
      lines: b.text.split('\n').length,
      tokens: approxTokens(b.text),
      dropped: kept.find((k) => k.kind === b.kind)?.dropped || 0,
    };
    stats.totalTokens += stats.byKind[b.kind].tokens;
  }

  return { blocks, text: blocks.map((b) => b.text).join('\n\n'), stats };
}

/** 仲裁统计 → 单行 trace 摘要（字段稳定，便于运行态核对与日志检索） */
export function arbiterTraceSummary(stats: ContextArbiterStats): string {
  const parts = CONTEXT_PRIORITY.filter((k) => stats.byKind[k].tokens > 0).map(
    (k) => `${k}:${stats.byKind[k].tokens}`
  );
  return (
    `仲裁注入 ${stats.totalTokens}/${stats.budgetTokens} tokens（${parts.join(' ') || '空'}）` +
    `；去重 ${stats.deduped} 行、冲突 ${stats.conflicts} 行、预算裁剪 ${stats.trimmed} 行`
  );
}
