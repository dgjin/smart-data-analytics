/** 样例通道：只读 sql_examples（MANUAL/FEEDBACK_UP/IMPORT），产出 few-shot 消息对 */
import { loadFewShotExamples } from '../../query/queryFeedback';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

const SOURCE_CONFIDENCE: Record<string, number> = { MANUAL: 0.95, FEEDBACK_UP: 0.7, IMPORT: 0.6 };

export const exampleChannel: MemoryChannel = {
  id: 'EXAMPLE',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const examples = await loadFewShotExamples(ctx.scope.dataSourceId, ctx.query, ctx.relevantTables || []);
    const pairs = examples.map((e) => ({ question: e.question, sql: e.sql }));
    return {
      pairs,
      hits: examples.map((e, i) => ({
        ref: `ext:sql_examples:${i}`,
        kind: 'EXAMPLE',
        question: e.question,
        text: `${e.question}\n${e.sql}`,
        sql: e.sql,
        rel: Math.max(0.3, 1 - i * 0.1),
        confidence: SOURCE_CONFIDENCE[e.source] ?? 0.6,
        createdAt: null,
      })),
    };
  },
};
