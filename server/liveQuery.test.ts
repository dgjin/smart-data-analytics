import { describe, expect, it, vi, afterEach } from 'vitest';
import { candidatePrompt, selfCorrectCandidates, resultSignature, VALID_STAGE1_CHARTS, normalizeAmountUnit, AMOUNT_UNIT_OPTIONS, buildAmountUnitPrompt, buildFallbackAnalysis, buildColumnStats } from './liveQuery';

describe('normalizeAmountUnit: 金额单位白名单', () => {
  it('四个白名单单位原样返回', () => {
    for (const u of ['亿元', '百万元', '万元', '元']) expect(normalizeAmountUnit(u)).toBe(u);
  });

  it('空白/undefined/非法值返回 undefined（不注入约定）', () => {
    expect(normalizeAmountUnit(undefined)).toBeUndefined();
    expect(normalizeAmountUnit('')).toBeUndefined();
    expect(normalizeAmountUnit('  ')).toBeUndefined();
    expect(normalizeAmountUnit('万亿元')).toBeUndefined();
    expect(normalizeAmountUnit('YI')).toBeUndefined();
  });

  it('除数与后缀约定正确（亿 1e8 / 百万 1e6 / 万 1e4 / 元 1）', () => {
    expect(AMOUNT_UNIT_OPTIONS['亿元'].divisor).toBe(100000000);
    expect(AMOUNT_UNIT_OPTIONS['百万元'].divisor).toBe(1000000);
    expect(AMOUNT_UNIT_OPTIONS['万元'].divisor).toBe(10000);
    expect(AMOUNT_UNIT_OPTIONS['元'].divisor).toBe(1);
    for (const u of Object.values(AMOUNT_UNIT_OPTIONS)) {
      expect(u.suffix).toMatch(/^[a-z]+$/);
    }
  });
});

describe('buildAmountUnitPrompt: 金额单位约定注入（v0.5.2 起报表链路复用）', () => {
  it('有效单位生成含除数与后缀的约定文本', () => {
    const p = buildAmountUnitPrompt('万元');
    expect(p).toContain('【金额单位约定】');
    expect(p).toContain('「万元」');
    expect(p).toContain('/10000');
    expect(p).toContain('_wan');
  });

  it('元为原值口径：明确不除以 1', () => {
    const p = buildAmountUnitPrompt('元');
    expect(p).toContain('「元」');
    expect(p).toContain('不要除以 1');
    expect(p).toContain('_yuan');
  });

  it('空/非法单位返回空串（不注入约定）', () => {
    expect(buildAmountUnitPrompt(undefined)).toBe('');
    expect(buildAmountUnitPrompt('')).toBe('');
    expect(buildAmountUnitPrompt('万亿元')).toBe('');
  });
});

describe('VALID_STAGE1_CHARTS: P2-B 图表类型白名单', () => {
  it('包含基础五种与新增 radar/scatter/treemap/heatmap', () => {
    for (const t of ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'scatter', 'treemap', 'heatmap']) {
      expect(VALID_STAGE1_CHARTS).toContain(t);
    }
  });

  it('白名单与前端 ChartType 渲染能力一致（不含 kpi/table）', () => {
    expect(VALID_STAGE1_CHARTS).not.toContain('kpi');
    expect(VALID_STAGE1_CHARTS).not.toContain('table');
  });
});

describe('candidatePrompt: 多候选差异化提示', () => {
  it('单候选或首个候选返回原 prompt', () => {
    expect(candidatePrompt('Q', 0, 1)).toBe('Q');
    expect(candidatePrompt('Q', 0, 3)).toBe('Q');
  });

  it('非首个候选追加候选编号与差异化提示', () => {
    const out = candidatePrompt('Q', 1, 3);
    expect(out.startsWith('Q')).toBe(true);
    expect(out).toContain('候选 2/3');
  });

  it('不同候选索引提示不同', () => {
    expect(candidatePrompt('Q', 1, 3)).not.toBe(candidatePrompt('Q', 2, 3));
  });
});

describe('resultSignature: P1-7 多数表决结果集规范化签名', () => {
  it('列顺序不同但内容相同 → 签名一致', () => {
    const a = [{ name: '华东', total: 100 }, { name: '华北', total: 200 }];
    const b = [{ total: 100, name: '华东' }, { total: 200, name: '华北' }];
    expect(resultSignature(a)).toBe(resultSignature(b));
  });

  it('mysql2 字符串数值与 number 归一后签名一致（DECIMAL 字符串场景）', () => {
    const a = [{ total: '1234.5', cnt: '3' }];
    const b = [{ total: 1234.5, cnt: 3 }];
    expect(resultSignature(a)).toBe(resultSignature(b));
  });

  it('结果不同 → 签名不同（多数表决能区分分歧候选）', () => {
    const a = [{ total: 100 }];
    const b = [{ total: 200 }];
    expect(resultSignature(a)).not.toBe(resultSignature(b));
  });

  it('行顺序不同 → 签名不同（结果集语义不同，不应误判为一致）', () => {
    const a = [{ name: 'A', v: 1 }, { name: 'B', v: 2 }];
    const b = [{ name: 'B', v: 2 }, { name: 'A', v: 1 }];
    expect(resultSignature(a)).not.toBe(resultSignature(b));
  });

  it('空结果集签名稳定', () => {
    expect(resultSignature([])).toBe(resultSignature([]));
    expect(resultSignature([])).not.toBe(resultSignature([{ a: 1 }]));
  });
});

describe('selfCorrectCandidates: 候选数解析', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('未设置或空值返回 1（简单问题默认不增延迟）', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '');
    expect(selfCorrectCandidates()).toBe(1);
    expect(selfCorrectCandidates(false)).toBe(1);
  });

  it('非法值返回 1', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', 'abc');
    expect(selfCorrectCandidates()).toBe(1);
  });

  it('≤1 的值返回 1', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '1');
    expect(selfCorrectCandidates()).toBe(1);
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '0');
    expect(selfCorrectCandidates()).toBe(1);
  });

  it('合法值取整且上限为 3', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '2');
    expect(selfCorrectCandidates()).toBe(2);
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '9');
    expect(selfCorrectCandidates()).toBe(3);
  });

  it('P1-7 分档触发：未配置 env 时复杂问题 3 候选、简单问题 1 候选', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '');
    expect(selfCorrectCandidates(true)).toBe(3);
    expect(selfCorrectCandidates(false)).toBe(1);
    expect(selfCorrectCandidates()).toBe(1);
  });

  it('显式 env 优先于分档（1 = 强制关闭多候选，2/3 = 强制候选数）', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '1');
    expect(selfCorrectCandidates(true)).toBe(1);
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '2');
    expect(selfCorrectCandidates(false)).toBe(2);
  });
});

describe('buildFallbackAnalysis: 阶段二 LLM 失败时的规则化降级解读', () => {
  // 回归：解读生成失败时不得再返回「查询返回 N 行」式无信息量兜底文案，
  // 而是基于真实列统计生成有数据支撑的解读
  const rows = [
    { jgmc: '北京', total_bntfje: 720.26 },
    { jgmc: '上海', total_bntfje: 285.5 },
    { jgmc: '四川', total_bntfje: 210.1 },
  ];
  const columnNames = { jgmc: '机构名称', total_bntfje: '本年投放金额（亿元）' };
  const chartConfig = { xAxisKey: 'jgmc', yAxisKeys: ['total_bntfje'] };

  it('数值列 + 维度列：解读含真实统计值与中文表头', () => {
    const stats = buildColumnStats(rows);
    const r = buildFallbackAnalysis(rows, stats, columnNames, chartConfig);
    expect(r.aiExplanation).toContain('3 条记录');
    expect(r.aiExplanation).toContain('本年投放金额（亿元）');
    expect(r.aiExplanation).toContain('1,215.86'); // 总计（千分位）
    expect(r.aiExplanation).toContain('机构名称');
    expect(r.aiExplanation).toContain('图表以 机构名称 为维度展示');
    expect(r.keyInsights.length).toBeGreaterThan(0);
    expect(r.keyInsights.length).toBeLessThanOrEqual(3);
    expect(r.keyInsights.some((s) => s.includes('720.26'))).toBe(true); // 洞察引用真实最大值
    expect(r.kpiMetrics.length).toBe(2); // 1 个数值列 → 总计/峰值两张 KPI
    expect(r.kpiMetrics[0].label).toContain('总计');
  });

  it('纯维度列：不报错且洞察仍可出分组数', () => {
    const dimRows = [{ region: '华东' }, { region: '华北' }, { region: '华东' }];
    const stats = buildColumnStats(dimRows);
    const r = buildFallbackAnalysis(dimRows, stats, {}, {});
    expect(r.aiExplanation).toContain('3 条记录');
    expect(r.kpiMetrics).toEqual([]);
    expect(r.keyInsights.some((s) => s.includes('2 个分组'))).toBe(true);
  });

  it('空 rows：解读仍可读，不抛异常', () => {
    const r = buildFallbackAnalysis([], {}, {}, {});
    expect(r.aiExplanation).toContain('0 条记录');
    expect(r.keyInsights).toEqual([]);
    expect(r.kpiMetrics).toEqual([]);
  });

  it('多个数值列：洞察取前两列且 KPI 不超过 4 张', () => {
    const multiRows = Array.from({ length: 5 }, (_, i) => ({ a: i, b: i * 10, c: i * 100, d: i * 1000 }));
    const stats = buildColumnStats(multiRows);
    const r = buildFallbackAnalysis(multiRows, stats, {}, {});
    expect(r.kpiMetrics.length).toBe(4); // 前 2 列 × 2 张 = 4，封顶
    expect(r.keyInsights.length).toBeLessThanOrEqual(3);
  });
});
