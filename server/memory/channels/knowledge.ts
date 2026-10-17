/** 知识通道：只读 knowledge_base 分块（RRF 混合检索），整段进文本块预算 */
import { retrieveKnowledgeChunks, formatKnowledgeSnippets } from '../../knowledge/knowledgeBase';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const knowledgeChannel: MemoryChannel = {
  id: 'KNOWLEDGE',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const chunks = await retrieveKnowledgeChunks(ctx.scope.dataSourceId, ctx.query);
    const prompt = formatKnowledgeSnippets(chunks);
    return {
      prompt,
      hits: chunks.map((c, i) => ({
        ref: `ext:knowledge_base:${i}`,
        kind: 'KNOWLEDGE',
        question: c.title,
        text: c.text.slice(0, 400),
        rel: Math.max(0.2, 1 - i * 0.12),
        confidence: 0.9,
        createdAt: null,
      })),
    };
  },
};
