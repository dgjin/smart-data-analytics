import { describe, expect, it } from 'vitest';
import { parseRefusal, enrichRefusalReason } from './liveQuery';
import { buildSimulatedSystemPrompt } from './simulatedQuery';

describe('parseRefusal: 拒答契约解析（问题与数据源无关/超出能力）', () => {
  it('合法拒答输出解析为结构化对象', () => {
    const out = parseRefusal(JSON.stringify({ refuse: true, reason: '该问题与当前数据源无关，无法基于现有数据回答。' }));
    expect(out).not.toBeNull();
    expect(out!.reason).toContain('与当前数据源无关');
  });

  it('refuse 非 true 返回 null（走 SQL 契约）', () => {
    expect(parseRefusal(JSON.stringify({ refuse: false, reason: 'x' }))).toBeNull();
    expect(parseRefusal(JSON.stringify({ sql: 'SELECT 1' }))).toBeNull();
    expect(parseRefusal(JSON.stringify({ needClarification: true, clarification: { question: 'q', options: [{ label: 'a', query: 'b' }] } }))).toBeNull();
  });

  it('reason 为空/非字符串返回 null（不得空理由拒答）', () => {
    expect(parseRefusal(JSON.stringify({ refuse: true, reason: '' }))).toBeNull();
    expect(parseRefusal(JSON.stringify({ refuse: true, reason: '   ' }))).toBeNull();
    expect(parseRefusal(JSON.stringify({ refuse: true }))).toBeNull();
    expect(parseRefusal(JSON.stringify({ refuse: true, reason: 123 }))).toBeNull();
  });

  it('reason 超长截断至 300 字', () => {
    const long = '原'.repeat(500);
    const out = parseRefusal(JSON.stringify({ refuse: true, reason: long }));
    expect(out).not.toBeNull();
    expect(out!.reason.length).toBe(300);
  });

  it('非法 JSON 返回 null', () => {
    expect(parseRefusal('不是 JSON')).toBeNull();
    expect(parseRefusal('')).toBeNull();
  });

  it('演示模式 prompt 包含拒答规则（禁止编造演示数据托底）', () => {
    const prompt = buildSimulatedSystemPrompt([], '');
    expect(prompt).toContain('拒答');
    expect(prompt).toContain('禁止编造演示数据');
    expect(prompt).toContain('抱歉，我是数据分析助手');
  });
});

describe('enrichRefusalReason: 拒答话术规范化（统一模板 + 兜底改写）', () => {
  const schema = [{ name: 'fct_jc_financial_stat' }, { name: 'fct_jc_main_biz_stat' }];

  it('照抄旧模板句的通用理由改写为统一话术并附数据源表清单', () => {
    const out = enrichRefusalReason('问题与当前数据源无关，或数据源中缺少支撑该问题的数据', schema);
    expect(out.startsWith('抱歉，我是数据分析助手，仅协助处理数据分析相关工作，无法处理')).toBe(true);
    expect(out).toContain('fct_jc_financial_stat');
    expect(out).toContain('fct_jc_main_biz_stat');
  });

  it('过短理由用「该请求」占位并附覆盖范围', () => {
    const out = enrichRefusalReason('无法回答。', schema);
    expect(out).toContain('无法处理该请求');
    expect(out).toContain('当前数据源仅覆盖');
  });

  it('模型正确填充的模板话术原样返回（不重复拼接）', () => {
    const reason = '抱歉，我是数据分析助手，仅协助处理数据分析相关工作，无法处理天气查询';
    expect(enrichRefusalReason(reason, schema)).toBe(reason);
  });

  it('已具体的非模板理由原样返回不重复拼接', () => {
    const reason = '问题询问天气信息，当前数据源仅含机构财务与主营业务宽表，不涉及天气数据，无法完成分析。';
    expect(enrichRefusalReason(reason, schema)).toBe(reason);
  });

  it('XXXX 占位未替换时降级为「该请求」，不留存占位符', () => {
    const out = enrichRefusalReason('抱歉，我是数据分析助手，仅协助处理数据分析相关工作，无法处理XXXX', schema);
    expect(out).not.toContain('XXXX');
    expect(out).toContain('无法处理该请求');
  });

  it('schema 为空时通用理由不报错且不追加表清单', () => {
    const out = enrichRefusalReason('问题与当前数据源无关，或数据源中缺少支撑该问题的数据', []);
    expect(out).not.toContain('当前数据源仅覆盖');
  });

  it('表超过 8 张时截断列举并标注总数', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `t_${i}` }));
    const out = enrichRefusalReason('无关。', many);
    expect(out).toContain('等 10 张表');
    expect(out).not.toContain('t_9');
  });
});
