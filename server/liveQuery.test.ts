import { describe, expect, it, vi, afterEach } from 'vitest';
import { candidatePrompt, selfCorrectCandidates, VALID_STAGE1_CHARTS } from './liveQuery';

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

describe('selfCorrectCandidates: 候选数解析', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('未设置或空值返回 1（默认不增延迟）', () => {
    vi.stubEnv('SELF_CORRECT_CANDIDATES', '');
    expect(selfCorrectCandidates()).toBe(1);
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
});
