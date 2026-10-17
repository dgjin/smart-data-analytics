/**
 * 反馈 → 记忆：点踩纠正落候选、按 trace 引用调整记忆置信度。
 *
 * 主链路不等待：调用方以 fire-and-forget 方式触发，任何失败只记日志，
 * 绝不影响用户反馈响应（设计文档「失败不阻断」原则）。
 */
import { confidenceDeltaForVerdict, normalizeErrorType } from './governance';
import { insertCorrectionCandidate, updateConfidence, usageByTrace } from './provider.mysql';
import type { MemoryErrorType } from './types';

export interface FeedbackMemoryInput {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  executedSql: string;
  verdict: 'UP' | 'DOWN';
  /** 前端点踩弹层采集的纠正信息（可选） */
  correction?: {
    errorType?: string;
    note?: string;
    expectedSql?: string;
  };
  /** 本次问数的 traceId（用于定位被引用的记忆并调整置信度） */
  traceId?: string;
}

export interface FeedbackMemoryResult {
  candidateId?: number;
  adjusted: number;
}

export async function applyFeedbackToMemory(input: FeedbackMemoryInput): Promise<FeedbackMemoryResult> {
  const result: FeedbackMemoryResult = { adjusted: 0 };

  // 1) 点踩 → 纠正候选（即使未填原因也落候选，供管理员后续确认）
  if (input.verdict === 'DOWN') {
    const errorType: MemoryErrorType = normalizeErrorType(input.correction?.errorType);
    result.candidateId = await insertCorrectionCandidate({
      userId: input.userId,
      username: input.username,
      dataSourceId: input.dataSourceId,
      question: input.question,
      wrongSql: input.executedSql,
      errorType,
      note: input.correction?.note,
      expectedSql: input.correction?.expectedSql,
      traceId: input.traceId,
    });
  }

  // 2) 按本次问数实际注入的纠错记忆调整置信度（点赞 +0.05 / 点踩 -0.20）
  if (input.traceId) {
    const usages = await usageByTrace(input.traceId);
    const ids = usages
      .filter((u) => u.injected === 1 && u.memoryRef.startsWith('mem:'))
      .map((u) => Number(u.memoryRef.slice(4)))
      .filter((n) => Number.isFinite(n) && n > 0);
    const delta = confidenceDeltaForVerdict(input.verdict);
    for (const id of Array.from(new Set(ids))) {
      await updateConfidence(id, delta);
      result.adjusted++;
    }
  }

  return result;
}
