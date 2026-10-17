/**
 * 统一记忆体配置：全部有默认值，缺省不改变现有问数行为。
 *
 * 灰度三态：
 * - off    ：完全不启用（默认），行为与接入前一致；
 * - shadow ：完整召回并写留痕，但不注入 prompt（用于离线对比与延迟评估）；
 * - on     ：按 MEMORY_ROUTER_ROLLOUT_PCT 对 userId 哈希灰度注入。
 */

export type MemoryRouterMode = 'off' | 'shadow' | 'on';

export function memoryRouterMode(): MemoryRouterMode {
  const raw = String(process.env.MEMORY_ROUTER_ENABLED || 'off').trim().toLowerCase();
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

/** 灰度百分比（0-100），仅 on/shadow 生效；100 表示全量 */
export function memoryRolloutPct(): number {
  const raw = Number(process.env.MEMORY_ROUTER_ROLLOUT_PCT);
  if (!Number.isFinite(raw)) return 20;
  return Math.min(100, Math.max(0, Math.floor(raw)));
}

/**
 * 稳定灰度判定：userId 乘法哈希（同一用户结果固定，便于 A/B 归因）。
 * pct=100 恒真；pct=0 恒假。
 */
export function isMemoryEnabledForUser(userId: number): boolean {
  const pct = memoryRolloutPct();
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const h = Math.abs(Math.imul(Number(userId) || 0, 2654435761)) % 100;
  return h < pct;
}

/** Router 整体超时：超时即以已完成通道结果拼装 */
export function memoryRecallTimeoutMs(): number {
  const raw = Number(process.env.MEMORY_RECALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 800;
}

/** 单通道超时：超时的通道视为无命中，不影响其他通道 */
export function memoryChannelTimeoutMs(): number {
  const raw = Number(process.env.MEMORY_CHANNEL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : 400;
}

/** 各通道注入预算（token 近似值，沿用现有常量语义：1 中文字≈1 token，approxTokens 按 /1.5 保守估计） */
export const MEMORY_BUDGETS = {
  /** 纠错记忆（新增，优先于知识/样例） */
  correction: 600,
  /** 业务知识库（与 promptBudget.KNOWLEDGE_TOKEN_BUDGET 一致） */
  knowledge: 2700,
  /** 外部知识库（与 EXTERNAL_KB_TOKEN_BUDGET 一致） */
  external: 1200,
  /** few-shot（example + conversation 共享，与 FEWSHOT_TOKEN_BUDGET 一致） */
  fewShot: 3600,
  /** 反例条数上限（沿用 loadNegativeExamples 默认 2） */
  negativeMax: 2,
} as const;

/** 融合后注入总量硬上限（不含铁律/指标强制段） */
export function memoryTotalTokenBudget(): number {
  const raw = Number(process.env.MEMORY_TOTAL_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : 6000;
}

/** 纠错记忆最多召回条数 */
export function memoryCorrectionLimit(): number {
  const raw = Number(process.env.MEMORY_CORRECTION_LIMIT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

/** 统一衰减半衰期（天）；按类别再乘系数（见 governance） */
export function memoryHalfLifeDays(): number {
  const raw = Number(process.env.MEMORY_HALF_LIFE_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 120;
}

/** 未命中归档阈值（天） */
export function memoryArchiveDays(): number {
  const raw = Number(process.env.MEMORY_ARCHIVE_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 90;
}

/** 自动候选识别（下一轮否定检测）开关，默认关 */
export function memoryAutoCandidateEnabled(): boolean {
  return String(process.env.MEMORY_AUTO_CANDIDATE || 'off').trim().toLowerCase() === 'on';
}
