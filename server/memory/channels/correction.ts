/**
 * 纠错记忆通道：读 memory_items（CORRECTION），按相似度召回本人与数据源共享的纠正条目。
 * 无命中/低相关（< CORRECTION_MIN_REL）不返回；Embedding 不可用时退化为 bigram。
 */
import { callEmbedding } from '../../llm/llmEmbedding';
import { rankCorrectionItems } from '../correctionRanking';
import { errorTypeLabel } from '../governance';
import { listCorrectionItems } from '../provider.mysql';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const correctionChannel: MemoryChannel = {
  id: 'CORRECTION',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const items = await listCorrectionItems(ctx.scope);
    if (!items.length) return { hits: [] };

    let queryEmbedding: number[] | null = null;
    if (items.some((i) => i.embedding && i.embedding.length > 0)) {
      try {
        queryEmbedding = await callEmbedding(ctx.query, 'query');
      } catch {
        queryEmbedding = null;
      }
    }

    const scored = rankCorrectionItems(ctx.query, items, { queryEmbedding });

    return {
      hits: scored.map(({ item, rel }) => {
        const sqlRef = item.expectedSql ? `\n  期望口径参考：${item.expectedSql.slice(0, 300)}` : '';
        return {
          ref: `mem:${item.id}`,
          kind: 'CORRECTION',
          question: item.question,
          text: `- 问题：${item.question}\n  错误类型：${errorTypeLabel(item.errorType)}\n  纠正要点：${item.content.slice(0, 400)}${sqlRef}`,
          sql: item.expectedSql || undefined,
          rel,
          confidence: item.confidence,
          createdAt: item.createdAt,
        };
      }),
    };
  },
};
