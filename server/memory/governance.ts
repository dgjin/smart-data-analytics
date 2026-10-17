/**
 * 记忆治理：置信度规则、时效衰减、来源权重、归档。
 *
 * 一期不引入 LLM 合并：候选去重按问题 bigram 相似度合并（provider 层），
 * 记忆条目合并留待二期（避免自动改写引入不可控风险）。
 */
import { memoryArchiveDays, memoryHalfLifeDays } from './config';
import type { MemoryErrorType, MemoryKind, MemoryStatus } from './types';

/** 来源权重：纠错 > 权威知识/指标/铁律 > 样例 > 外部 > 反例 > 个人沉淀 */
const SOURCE_WEIGHT: Record<MemoryKind, number> = {
  CORRECTION: 1.1,
  IRON: 1.0,
  METRIC: 1.0,
  KNOWLEDGE: 1.0,
  EXAMPLE: 0.9,
  EXTERNAL: 0.85,
  NEGATIVE: 0.8,
  CONVERSATION: 0.7,
};

/** 半衰期类别系数：口径纠正衰减更慢，个人沉淀衰减更快 */
const HALF_LIFE_FACTOR: Record<MemoryKind, number> = {
  CORRECTION: 1.5,
  IRON: 10,
  METRIC: 10,
  KNOWLEDGE: 3,
  EXAMPLE: 1,
  EXTERNAL: 0.75,
  NEGATIVE: 0.75,
  CONVERSATION: 0.5,
};

export function sourceWeight(kind: MemoryKind): number {
  return SOURCE_WEIGHT[kind] ?? 1;
}

/**
 * 时效衰减：decay = 0.5 ^ (ageDays / (halfLife × factor))。
 * createdAt 缺失时按 1 处理（宁可不衰减，也不误杀）。
 */
export function decayFactor(createdAt: string | null | undefined, kind: MemoryKind): number {
  if (!createdAt) return 1;
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return 1;
  const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
  const halfLife = Math.max(1, memoryHalfLifeDays() * (HALF_LIFE_FACTOR[kind] ?? 1));
  return Math.pow(0.5, ageDays / halfLife);
}

/** 融合分：rel × confidence × decay × sourceWeight */
export function fusionScore(kind: MemoryKind, rel: number, confidence: number, createdAt: string | null): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return clamp(rel) * clamp(confidence) * decayFactor(createdAt, kind) * sourceWeight(kind);
}

/** 反馈对置信度的影响：点赞 +0.05；点踩 -0.20（与设计文档一致） */
export function confidenceDeltaForVerdict(verdict: 'UP' | 'DOWN'): number {
  return verdict === 'UP' ? 0.05 : -0.2;
}

/** 审核生效时的初始置信度：用户提交 0.4 / 管理员确认 0.9 / 填写期望 SQL 1.0 */
export function initialConfidenceForApproval(opts: { expectedSql?: string; approvedByAdmin: boolean }): number {
  if (opts.expectedSql && opts.expectedSql.trim()) return 1.0;
  return opts.approvedByAdmin ? 0.9 : 0.4;
}

/** 点踩候选的默认错误类型兜底 */
export function normalizeErrorType(raw: unknown): MemoryErrorType {
  const v = String(raw || '').trim().toUpperCase();
  if (v === 'TABLE_CHOICE' || v === 'COLUMN' || v === 'CALIBER' || v === 'UNDERSTANDING' || v === 'OTHER') return v;
  return 'OTHER';
}

/** 错误类型中文标签（注入文本与后台展示共用） */
export function errorTypeLabel(t: MemoryErrorType): string {
  switch (t) {
    case 'TABLE_CHOICE':
      return '选表错误';
    case 'COLUMN':
      return '字段错误';
    case 'CALIBER':
      return '口径或聚合错误';
    case 'UNDERSTANDING':
      return '理解偏差';
    default:
      return '其他';
  }
}

/** 状态合法性（后台 PATCH 校验） */
export function isMemoryStatus(v: unknown): v is MemoryStatus {
  return v === 'ACTIVE' || v === 'ARCHIVED' || v === 'DISABLED';
}

/**
 * 归档判定：last_used_at（缺失用 created_at）超过 N 天未命中且置信度低于阈值。
 * 返回是否应归档；实际更新由 provider.archiveStale 批量执行。
 */
export function shouldArchive(item: { lastUsedAt: string | null; createdAt: string | null; confidence: number }): boolean {
  const last = item.lastUsedAt || item.createdAt;
  if (!last) return false;
  const ts = new Date(last).getTime();
  if (!Number.isFinite(ts)) return false;
  const ageDays = (Date.now() - ts) / 86400000;
  return ageDays >= memoryArchiveDays() && item.confidence < 0.3;
}
