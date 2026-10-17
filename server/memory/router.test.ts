import { afterEach, describe, expect, it } from 'vitest';
import { approxTokens } from '../llm/promptBudget';
import { isMemoryEnabledForUser, memoryRolloutPct, memoryRouterMode } from './config';
import { buildMemoryBundle } from './router';
import type { ChannelHit, ChannelResult, MemoryKind } from './types';

function hit(kind: MemoryKind, overrides: Partial<ChannelHit> = {}): ChannelHit {
  return {
    ref: `ext:test:${kind}`,
    kind,
    question: '测试问题',
    text: '测试片段',
    rel: 0.9,
    confidence: 0.9,
    createdAt: null,
    ...overrides,
  };
}

function results(entries: [MemoryKind, ChannelResult][]): Map<MemoryKind, ChannelResult> {
  return new Map(entries);
}

const ENV_KEYS = ['MEMORY_ROUTER_ENABLED', 'MEMORY_ROUTER_ROLLOUT_PCT', 'MEMORY_TOTAL_TOKEN_BUDGET'] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('config: 三态与灰度', () => {
  it('默认 off；on/true/1 归一为 on；shadow 独立', () => {
    expect(memoryRouterMode()).toBe('off');
    process.env.MEMORY_ROUTER_ENABLED = 'on';
    expect(memoryRouterMode()).toBe('on');
    process.env.MEMORY_ROUTER_ENABLED = '1';
    expect(memoryRouterMode()).toBe('on');
    process.env.MEMORY_ROUTER_ENABLED = 'shadow';
    expect(memoryRouterMode()).toBe('shadow');
    process.env.MEMORY_ROUTER_ENABLED = 'garbage';
    expect(memoryRouterMode()).toBe('off');
  });

  it('灰度百分比边界：0 全关、100 全开、同一用户结果稳定', () => {
    process.env.MEMORY_ROUTER_ROLLOUT_PCT = '0';
    expect(memoryRolloutPct()).toBe(0);
    expect(isMemoryEnabledForUser(42)).toBe(false);
    process.env.MEMORY_ROUTER_ROLLOUT_PCT = '100';
    expect(isMemoryEnabledForUser(42)).toBe(true);
    process.env.MEMORY_ROUTER_ROLLOUT_PCT = '50';
    const first = isMemoryEnabledForUser(42);
    expect(isMemoryEnabledForUser(42)).toBe(first);
  });
});

describe('buildMemoryBundle: 拼装与预算', () => {
  it('强制段原样保留，文本块按 纠错→知识→外部 顺序拼装', () => {
    const bundle = buildMemoryBundle(
      results([
        ['IRON', { forced: true, prompt: '【铁律规则】严禁跨法人统计', hits: [hit('IRON')] }],
        ['METRIC', { forced: true, prompt: '【语义指标层定义】有效客户数 = COUNT(DISTINCT id)', hits: [hit('METRIC')] }],
        [
          'CORRECTION',
          { hits: [hit('CORRECTION', { ref: 'mem:1', question: '上月销售额', text: '- 问题：上月销售额\n  纠正要点：按订单表支付时间统计' })] },
        ],
        ['KNOWLEDGE', { prompt: '业务知识库（权威口径）', hits: [hit('KNOWLEDGE')] }],
        ['EXTERNAL', { prompt: '【外部知识】指标字典', hits: [hit('EXTERNAL')] }],
      ])
    );
    expect(bundle.ironRulesPrompt).toContain('铁律规则');
    expect(bundle.metricPrompt).toContain('语义指标层定义');
    expect(bundle.knowledgeBlock).toContain('历史纠错记忆');
    expect(bundle.knowledgeBlock.indexOf('历史纠错')).toBeLessThan(bundle.knowledgeBlock.indexOf('业务知识库'));
    expect(bundle.knowledgeBlock.indexOf('业务知识库')).toBeLessThan(bundle.knowledgeBlock.indexOf('外部知识'));
    expect(bundle.stats.forced).toBe(2);
    expect(bundle.stats.channelHits.CORRECTION).toBe(1);
  });

  it('few-shot 按归一化 SQL 去重，团队样例在前、个人沉淀补充', () => {
    const bundle = buildMemoryBundle(
      results([
        [
          'EXAMPLE',
          {
            pairs: [
              { question: '问题A', sql: 'SELECT  1' },
              { question: '问题B', sql: 'SELECT 2' },
            ],
            hits: [hit('EXAMPLE'), hit('EXAMPLE')],
          },
        ],
        ['CONVERSATION', { pairs: [{ question: '问题C', sql: 'select 1' }, { question: '问题D', sql: 'SELECT 4' }], hits: [] }],
      ])
    );
    expect(bundle.fewShotPairs.map((p) => p.question)).toEqual(['问题A', '问题B', '问题D']);
    expect(bundle.stats.deduped).toBe(1);
  });

  it('反例与纠错记忆同问题时丢弃反例', () => {
    const bundle = buildMemoryBundle(
      results([
        ['CORRECTION', { hits: [hit('CORRECTION', { ref: 'mem:9', question: '问题A' })] }],
        [
          'NEGATIVE',
          {
            examples: [
              { question: '问题A', wrongTables: 't1' },
              { question: '问题B', wrongTables: 't2' },
            ],
            hits: [hit('NEGATIVE'), hit('NEGATIVE')],
          },
        ],
      ])
    );
    expect(bundle.negativeExamples).toEqual([{ question: '问题B', wrongTables: 't2' }]);
  });

  it('few-shot 超出共享预算时截断', () => {
    const sql = `SELECT ${'x'.repeat(200)} FROM t`;
    const pairs = Array.from({ length: 30 }, (_, i) => ({ question: `问题${i}`, sql: `${sql}${i}` }));
    const bundle = buildMemoryBundle(results([['EXAMPLE', { pairs, hits: [] }]]));
    expect(bundle.fewShotPairs.length).toBeGreaterThan(0);
    expect(bundle.fewShotPairs.length).toBeLessThan(30);
    const tokens = bundle.fewShotPairs.reduce((s, p) => s + approxTokens(p.question) + approxTokens(p.sql) + 8, 0);
    expect(tokens).toBeLessThanOrEqual(3600);
  });

  it('全局硬上限生效：知识+外部 被压缩到预算内', () => {
    process.env.MEMORY_TOTAL_TOKEN_BUDGET = '500';
    const bundle = buildMemoryBundle(
      results([
        ['CORRECTION', { hits: [hit('CORRECTION', { ref: 'mem:1', text: `- 问题：A\n  纠正要点：${'纠'.repeat(150)}` })] }],
        ['KNOWLEDGE', { prompt: `业务知识库\n${'知'.repeat(4000)}`, hits: [hit('KNOWLEDGE')] }],
        ['EXTERNAL', { prompt: `外部知识\n${'外'.repeat(2000)}`, hits: [hit('EXTERNAL')] }],
      ])
    );
    expect(bundle.knowledgeBlock).toContain('历史纠错记忆');
    expect(approxTokens(bundle.knowledgeBlock)).toBeLessThanOrEqual(520);
  });

  it('空结果：不产生文本块与消息对', () => {
    const bundle = buildMemoryBundle(results([]));
    expect(bundle.ironRulesPrompt).toBe('');
    expect(bundle.metricPrompt).toBe('');
    expect(bundle.knowledgeBlock).toBe('');
    expect(bundle.fewShotPairs).toEqual([]);
    expect(bundle.negativeExamples).toEqual([]);
    expect(bundle.stats.injectedTokens).toBe(0);
  });
});
