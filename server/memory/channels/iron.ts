/** 铁律通道：只读 iron_rules（ACTIVE），整段强制注入，不参与竞争预算 */
import { loadActiveIronRules, buildIronRulesPrompt } from '../../query/ironRules';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const ironChannel: MemoryChannel = {
  id: 'IRON',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const rules = await loadActiveIronRules(ctx.scope.dataSourceId);
    return {
      forced: true,
      prompt: buildIronRulesPrompt(rules),
      hits: rules.map((r, i) => ({
        ref: `ext:iron_rules:${r.id ?? i}`,
        kind: 'IRON',
        question: r.title,
        text: `【${r.title}】${r.content}`,
        rel: 1,
        confidence: 1,
        createdAt: null,
      })),
    };
  },
};
