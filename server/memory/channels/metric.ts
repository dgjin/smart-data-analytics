/** 指标通道：只读 metric_definitions（ACTIVE），问题命中的指标口径整段强制注入 */
import { loadActiveMetrics, matchMetrics, buildMetricPrompt } from '../../query/metrics';
import type { ChannelResult, MemoryChannel, RecallContext } from '../types';

export const metricChannel: MemoryChannel = {
  id: 'METRIC',
  async recall(ctx: RecallContext): Promise<ChannelResult> {
    const metrics = await loadActiveMetrics(ctx.scope.dataSourceId);
    const hits = matchMetrics(ctx.query, metrics);
    return {
      forced: true,
      prompt: buildMetricPrompt(hits),
      hits: hits.map((m, i) => ({
        ref: `ext:metric_definitions:${m.id ?? i}`,
        kind: 'METRIC',
        question: m.name,
        text: `${m.name} = ${m.expr}`,
        rel: 1,
        confidence: 1,
        createdAt: null,
      })),
    };
  },
};
