/** 个人对话沉淀通道：只读 conversation_history（本人 SUCCESS），产出 few-shot 消息对 */
import { loadConversationFewShot } from '../../query/conversationHistory';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const conversationChannel: MemoryChannel = {
  id: 'CONVERSATION',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const pairs = await loadConversationFewShot(
      ctx.scope.userId,
      ctx.scope.dataSourceId,
      ctx.query,
      ctx.relevantTables || []
    );
    return {
      pairs: pairs.map((p) => ({ question: p.question, sql: p.sql })),
      hits: pairs.map((p, i) => ({
        ref: `ext:conversation_history:${i}`,
        kind: 'CONVERSATION',
        question: p.question,
        text: `${p.question}\n${p.sql}`,
        sql: p.sql,
        rel: Math.max(0.3, 0.9 - i * 0.1),
        confidence: 0.6,
        createdAt: null,
      })),
    };
  },
};
