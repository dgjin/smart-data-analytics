/**
 * 纠错记忆排序（纯函数）：通道召回与离线评测共用。
 * 过滤阈值 rel ≥ 0.45，按融合分（rel × confidence × decay × sourceWeight）降序取 top-N。
 */
import { memoryCorrectionLimit } from './config';
import { fusionScore } from './governance';
import { CORRECTION_MIN_REL, memoryRelevance } from './similarity';
import type { MemoryItem } from './types';

export interface RankedCorrection {
  item: MemoryItem;
  rel: number;
}

export function rankCorrectionItems(
  query: string,
  items: MemoryItem[],
  opts: { limit?: number; queryEmbedding?: number[] | null } = {}
): RankedCorrection[] {
  const limit = Math.max(1, opts.limit ?? memoryCorrectionLimit());
  return items
    .map((item) => ({
      item,
      rel: memoryRelevance(query, item.question, opts.queryEmbedding, item.embedding),
    }))
    .filter((s) => s.rel >= CORRECTION_MIN_REL)
    .sort(
      (a, b) =>
        fusionScore('CORRECTION', b.rel, b.item.confidence, b.item.createdAt) -
        fusionScore('CORRECTION', a.rel, a.item.confidence, a.item.createdAt)
    )
    .slice(0, limit);
}
