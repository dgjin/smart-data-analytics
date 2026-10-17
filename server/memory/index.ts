/**
 * 统一记忆体（Memory）对外入口。
 *
 * 一期能力：
 * - recallMemory：8 通道统一召回（off/shadow/on 三态 + 用户灰度）；
 * - Provider：纠错记忆（memory_items）与候选（memory_candidates）的读写；
 * - Governance：置信度/衰减/来源权重/归档。
 */
export { recallMemory, buildMemoryBundle, DEFAULT_MEMORY_CHANNELS, persistMemoryUsage } from './router';
export {
  memoryRouterMode,
  memoryRolloutPct,
  isMemoryEnabledForUser,
  memoryRecallTimeoutMs,
  memoryChannelTimeoutMs,
  memoryTotalTokenBudget,
  memoryCorrectionLimit,
  memoryArchiveDays,
  memoryAutoCandidateEnabled,
  MEMORY_BUDGETS,
} from './config';
export {
  fusionScore,
  decayFactor,
  sourceWeight,
  confidenceDeltaForVerdict,
  initialConfidenceForApproval,
  normalizeErrorType,
  errorTypeLabel,
  isMemoryStatus,
  shouldArchive,
} from './governance';
export {
  listCorrectionItems,
  insertCorrectionCandidate,
  listCandidates,
  getCandidate,
  approveCandidate,
  rejectCandidate,
  listItems,
  updateItem,
  touchUsage,
  bumpCorrectionUsage,
  updateConfidence,
  archiveStaleMemories,
  memoryStats,
  usageByTrace,
} from './provider.mysql';
export type {
  MemoryKind,
  MemoryErrorType,
  MemoryStatus,
  MemoryRole,
  MemoryScope,
  MemoryItem,
  MemoryCandidate,
  ChannelHit,
  ChannelResult,
  MemoryChannel,
  RecallContext,
  MemoryRecallStats,
  MemoryRecallBundle,
  UsageRow,
  RememberCorrectionInput,
} from './types';
