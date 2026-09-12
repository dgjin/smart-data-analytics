import { describe, expect, it } from 'vitest';
import { attributeDelta, MAX_ATTRIBUTION_ROWS } from './attribution';

describe('attribution: 多维归因贡献度引擎', () => {
  it('基础拆解：贡献占比按 Σ|delta| 归一，正负分离', () => {
    const r = attributeDelta([
      { dims: ['华东'], current: 12, previous: 10 }, // +2
      { dims: ['华南'], current: 5, previous: 4 }, // +1
      { dims: ['华北'], current: 6, previous: 9 }, // -3
    ]);
    expect(r.total).toEqual({ current: 23, previous: 23, delta: 0, deltaPct: 0 });
    const byDim = Object.fromEntries(r.items.map((i) => [i.dims[0], i]));
    expect(byDim['华东'].contribution).toBeCloseTo(33.33, 2);
    expect(byDim['华南'].contribution).toBeCloseTo(16.67, 2);
    expect(byDim['华北'].contribution).toBeCloseTo(-50, 2);
    // 排名按 |delta| 降序：华北(3) > 华东(2) > 华南(1)
    expect(byDim['华北'].rank).toBe(1);
    expect(byDim['华东'].rank).toBe(2);
    expect(byDim['华南'].rank).toBe(3);
  });

  it('拉高/拉低 TOP：正负分组后按幅度排序', () => {
    const r = attributeDelta(
      [
        { dims: ['A'], current: 5, previous: 1 }, // +4
        { dims: ['B'], current: 4, previous: 2 }, // +2
        { dims: ['C'], current: 1, previous: 8 }, // -7
        { dims: ['D'], current: 2, previous: 4 }, // -2
      ],
      { topN: 2 },
    );
    expect(r.topPositive.map((i) => i.dims[0])).toEqual(['A', 'B']);
    expect(r.topNegative.map((i) => i.dims[0])).toEqual(['C', 'D']);
  });

  it('自身变化率：对比期为 0 时为 null', () => {
    const r = attributeDelta([{ dims: ['A'], current: 3, previous: 0 }]);
    expect(r.items[0].deltaPct).toBeNull();
    expect(r.items[0].contribution).toBe(100);
  });

  it('数据无变化：贡献占比全 0 并给出诊断', () => {
    const r = attributeDelta([
      { dims: ['A'], current: 3, previous: 3 },
      { dims: ['B'], current: 2, previous: 2 },
    ]);
    expect(r.items.every((i) => i.contribution === 0)).toBe(true);
    expect(r.diagnostics.join('')).toContain('贡献占比不适用');
  });

  it('反向变动诊断：整体上升中仍有下降的维度组合', () => {
    const r = attributeDelta([
      { dims: ['A'], current: 10, previous: 4 }, // +6
      { dims: ['B'], current: 2, previous: 5 }, // -3
    ]);
    expect(r.total.delta).toBe(3);
    expect(r.diagnostics.join('')).toContain('与总体方向相反');
  });

  it('高集中度诊断：居首维度组合超过 50%', () => {
    const r = attributeDelta([
      { dims: ['A'], current: 10, previous: 1 }, // +9
      { dims: ['B'], current: 2, previous: 2 }, // 0
      { dims: ['C'], current: 2, previous: 1 }, // +1
    ]);
    expect(r.diagnostics.join('')).toContain('变化高度集中');
  });

  it('多维度组合：dims 原样保留', () => {
    const r = attributeDelta([{ dims: ['华东', 'M1', '保证'], current: 6, previous: 5 }]);
    expect(r.items[0].dims).toEqual(['华东', 'M1', '保证']);
  });

  it('校验：空数组、超限、非数值均抛错', () => {
    expect(() => attributeDelta([])).toThrow('至少需要一行');
    expect(() => attributeDelta(Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ dims: ['A'], current: 1, previous: 0 })))).toThrow('上限');
    expect(() => attributeDelta([{ dims: ['A'], current: Number.NaN, previous: 1 }])).toThrow('非数值');
  });
});
