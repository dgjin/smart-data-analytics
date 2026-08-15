/**
 * P0-1 评测运行器单测：评测集加载校验、结果集等价比较、表名提取。
 */
import { describe, it, expect } from 'vitest';
import {
  loadEvalCases,
  normalizeCell,
  compareRowSets,
  extractTableNames,
} from './evalRunner';

describe('loadEvalCases', () => {
  it('内置评测集加载：全部用例合法且 golden SQL 均为 SELECT', () => {
    const suite = loadEvalCases();
    expect(suite.dataSourceId).toBeTruthy();
    expect(suite.cases.length).toBeGreaterThanOrEqual(10);
    const ids = suite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of suite.cases) {
      expect(c.goldenSql).toMatch(/^select/i);
    }
  });
});

describe('normalizeCell', () => {
  it('数值保留 6 位小数、字符串 trim、空值统一空串', () => {
    expect(normalizeCell(1.23456789)).toBe('1.234568');
    expect(normalizeCell('3.10')).toBe('3.1');
    expect(normalizeCell(' 北京 ')).toBe('北京');
    expect(normalizeCell(null)).toBe('');
    expect(normalizeCell(undefined)).toBe('');
  });
});

describe('compareRowSets', () => {
  it('无序等价：行序/列序/别名差异不影响，数值差异判 fail', () => {
    const golden = [
      { cnt: 3, industry: '金融' },
      { cnt: 1, industry: '制造' },
    ];
    // 列序与别名不同但取值一致 → 等价
    const reordered = [
      { industry: '制造', num: 1 },
      { num: 3, industry: '金融' },
    ];
    expect(compareRowSets(reordered, golden)).toBe(true);
    // 计数不同 → 不等价
    const wrong = [
      { industry: '金融', cnt: 2 },
      { industry: '制造', cnt: 1 },
    ];
    expect(compareRowSets(wrong, golden)).toBe(false);
    // 行数不同 → 不等价
    expect(compareRowSets(golden.slice(0, 1), golden)).toBe(false);
  });

  it('ordered=true 按行序比较（Top-N 用例）', () => {
    const a = [{ name: '甲', cnt: 9 }, { name: '乙', cnt: 5 }];
    const b = [{ name: '乙', cnt: 5 }, { name: '甲', cnt: 9 }];
    expect(compareRowSets(a, b, true)).toBe(false);
    expect(compareRowSets(a, b, false)).toBe(true);
  });

  it('浮点容差：1e-6 内视为相等', () => {
    expect(compareRowSets([{ v: 0.1 + 0.2 }], [{ v: 0.3 }])).toBe(true);
  });

  it('非数组一律不等价', () => {
    expect(compareRowSets(null as any, [])).toBe(false);
    expect(compareRowSets([], undefined as any)).toBe(false);
  });
});

describe('extractTableNames', () => {
  it('提取 FROM/JOIN 表名（含反引号、大小写）', () => {
    expect(extractTableNames('SELECT * FROM clients c JOIN `visits` v ON 1=1')).toEqual(
      expect.arrayContaining(['clients', 'visits'])
    );
    expect(extractTableNames('select count(*) from Departments')).toEqual(['Departments']);
    expect(extractTableNames('')).toEqual([]);
  });
});
