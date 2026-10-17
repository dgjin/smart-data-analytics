/** 外部知识通道：只读 external_kb_sources 聚合结果（已按外部预算截断的整段文本） */
import { searchExternalKnowledge } from '../../knowledge/externalKnowledge';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const externalChannel: MemoryChannel = {
  id: 'EXTERNAL',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const res = await searchExternalKnowledge(ctx.scope.dataSourceId, ctx.query);
    const snippet = String(res.snippet || '').trim();
    if (!snippet) return { hits: [] };
    return {
      prompt: snippet,
      hits: [
        {
          ref: `ext:external_kb:${res.okSources}:${res.totalChars}`,
          kind: 'EXTERNAL',
          question: '外部知识库',
          text: snippet.slice(0, 400),
          rel: 0.85,
          confidence: 0.85,
          createdAt: null,
        },
      ],
    };
  },
};
