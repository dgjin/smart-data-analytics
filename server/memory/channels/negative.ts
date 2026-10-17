/** 反例通道：只读 query_feedback（DOWN）按相似度取 top N（只给问题与错表名，不给错误 SQL） */
import { loadNegativeExamples } from '../../query/queryFeedback';
import { MEMORY_BUDGETS } from '../config';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const negativeChannel: MemoryChannel = {
  id: 'NEGATIVE',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const examples = await loadNegativeExamples(ctx.scope.dataSourceId, ctx.query, MEMORY_BUDGETS.negativeMax);
    return {
      examples: examples.map((e) => ({ question: e.question, wrongTables: e.wrongTables })),
      hits: examples.map((e, i) => ({
        ref: `ext:query_feedback:${i}`,
        kind: 'NEGATIVE',
        question: e.question,
        text: `错误案例：${e.question}${e.wrongTables ? `（错误答案涉及表：${e.wrongTables}）` : ''}`,
        rel: Math.max(0.4, 1 - i * 0.2),
        confidence: 0.5,
        createdAt: null,
      })),
    };
  },
};
