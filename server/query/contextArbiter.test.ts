/**
 * P1-1 上下文仲裁器单测：优先级排序、跨块去重、`表.列 = 值` 冲突裁剪、总预算尾部裁剪。
 */
import { describe, it, expect } from 'vitest';
import { arbitrateContext, arbiterTraceSummary, CONTEXT_PRIORITY } from './contextArbiter';

describe('arbitrateContext 优先级与空输入', () => {
  it('按 iron > metric > ontology > guidance > knowledge 排序输出', () => {
    const r = arbitrateContext({
      knowledge: '知识块',
      guidance: '口径块',
      ontology: '本体块',
      metric: '指标块',
      iron: '铁律块',
    });
    expect(r.blocks.map((b) => b.kind)).toEqual([...CONTEXT_PRIORITY]);
    expect(r.text.indexOf('铁律块')).toBeLessThan(r.text.indexOf('指标块'));
    expect(r.text.indexOf('指标块')).toBeLessThan(r.text.indexOf('本体块'));
    expect(r.text.indexOf('本体块')).toBeLessThan(r.text.indexOf('口径块'));
    expect(r.text.indexOf('口径块')).toBeLessThan(r.text.indexOf('知识块'));
  });

  it('全部为空：零块零 token，不产生统计噪声', () => {
    const r = arbitrateContext({});
    expect(r.blocks).toEqual([]);
    expect(r.text).toBe('');
    expect(r.stats.totalTokens).toBe(0);
    expect(r.stats.deduped).toBe(0);
    expect(r.stats.conflicts).toBe(0);
    expect(r.stats.trimmed).toBe(0);
  });

  it('未裁剪时保留原始文本（格式零改动）', () => {
    const ontology = '【业务实体】\n- 机构（JGMC）\n';
    const r = arbitrateContext({ ontology });
    expect(r.blocks[0].text).toBe(ontology.trimEnd());
    expect(r.stats.byKind.ontology.tokens).toBeGreaterThan(0);
    expect(r.stats.byKind.ontology.dropped).toBe(0);
  });
});

describe('arbitrateContext 去重', () => {
  it('低优先级块重复高优先级行时丢弃并计数', () => {
    const line = '- 合同表只统计已生效数据';
    const r = arbitrateContext({ metric: `${line}\n- 指标 A`, knowledge: `${line}\n- 知识 B` });
    expect(r.blocks.find((b) => b.kind === 'knowledge')?.text).toBe('- 知识 B');
    expect(r.stats.deduped).toBe(1);
    expect(r.stats.byKind.knowledge.dropped).toBe(1);
    // 高优先级块完整保留
    expect(r.blocks.find((b) => b.kind === 'metric')?.text).toBe(`${line}\n- 指标 A`);
  });
});

describe('arbitrateContext 事实冲突', () => {
  it('同列不同值：丢弃低优先级行并记 warning，同值行保留', () => {
    const r = arbitrateContext({
      iron: '- 铁律：t.BB = 1 表示本期',
      ontology: '- 值域：t.BB = 2 → 上期\n- 值域：t.BB = 1 → 本期',
    });
    const ontology = r.blocks.find((b) => b.kind === 'ontology')?.text || '';
    expect(ontology).toContain('t.BB = 1');
    expect(ontology).not.toContain('t.BB = 2');
    expect(r.stats.conflicts).toBe(1);
    expect(r.stats.warnings[0]).toContain('t.bb=2');
  });

  it('引号/大小写差异视为同值，不误判冲突', () => {
    const r = arbitrateContext({ iron: "- t.Status = 'A'", knowledge: '- t.status = a' });
    expect(r.stats.conflicts).toBe(0);
    expect(r.blocks.find((b) => b.kind === 'knowledge')).toBeTruthy();
  });

  it('释义模板占位符（表.列 = 值）不参与冲突判定', () => {
    const r = arbitrateContext({
      ontology: '- THEADER.STATUS = 值 → 含义\n- THEADER.STATUS = ACTIVE → 生效',
    });
    // 同块内不裁剪（避免块内自伤），占位符也不登记事实
    expect(r.stats.conflicts).toBe(0);
    expect(r.stats.byKind.ontology.dropped).toBe(0);
  });
});

describe('arbitrateContext 总预算裁剪', () => {
  it('超预算时从最低优先级块尾部裁剪，铁律优先保留', () => {
    const iron = '- 铁律：必须排除测试数据\n- 铁律：金额必须 ROUND 两位';
    const knowledge = Array.from({ length: 40 }, (_, i) => `- 知识片段 ${i}：${'细'.repeat(20)}`).join('\n');
    const r = arbitrateContext({ iron, knowledge }, { budgetTokens: 120 });
    expect(r.stats.trimmed).toBeGreaterThan(0);
    expect(r.stats.totalTokens).toBeLessThanOrEqual(120);
    // 铁律完整保留，知识被压缩/清空
    expect(r.blocks.find((b) => b.kind === 'iron')?.text).toBe(iron);
    const knowledgeKept = r.blocks.find((b) => b.kind === 'knowledge');
    expect(knowledgeKept ? knowledgeKept.text.split('\n').length : 0).toBeLessThan(40);
  });

  it('预算极小时最低优先级块整块消失，且不抛错', () => {
    const r = arbitrateContext({ iron: '- 铁律', knowledge: '知识'.repeat(200) }, { budgetTokens: 10 });
    expect(r.blocks.map((b) => b.kind)).toEqual(['iron']);
    expect(r.stats.trimmed).toBeGreaterThan(0);
  });
});

describe('arbiterTraceSummary', () => {
  it('输出注入 token、去重/冲突/裁剪统计', () => {
    const r = arbitrateContext({ iron: '- 铁律', knowledge: '知识片段' });
    const s = arbiterTraceSummary(r.stats);
    expect(s).toContain('仲裁注入');
    expect(s).toContain('iron:');
    expect(s).toContain('knowledge:');
    expect(s).toContain('去重 0 行');
    expect(s).toContain('冲突 0 行');
  });
});
