/**
 * P0-1 评测运行器单测：评测集加载校验、结果集等价比较、表名提取。
 */
import { describe, it, expect } from 'vitest';
import {
  loadEvalCases,
  normalizeCell,
  compareRowSets,
  extractTableNames,
  computeCategoryStats,
  isBelowThreshold,
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

  it('金额容差：ROUND(x,2) 与全精度 golden 等价；口径差异不误放', () => {
    // 系统常用 ROUND(SUM(x),2) 写法 → 与全精度 golden 差在半分钱内，判一致
    expect(compareRowSets([{ v: 419538967830.73 }], [{ v: 419538967830.726625 }])).toBe(true);
    // 超过半分钱的差异判不一致（口径错误差异以千万计，此处验证容差边界）
    expect(compareRowSets([{ v: 100.01 }], [{ v: 100 }])).toBe(false);
    // 锁错快照期级别的差异必须判 fail
    expect(compareRowSets([{ v: 6754900374804.33 }], [{ v: 6756457114688.569613 }])).toBe(false);
    // 多列行内排序 + 数值容差混合
    expect(compareRowSets([{ a: '金融', v: 12.344 }], [{ b: 12.34, c: '金融' }])).toBe(true);
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

describe('P0-1 六类分层扩展', () => {
  it('loadEvalCases 解析 category 与 expect 字段，六类齐全', () => {
    const suite = loadEvalCases();
    const cats = new Set(suite.cases.map((c) => c.category));
    for (const cat of ['single_agg', 'join', 'time', 'subquery', 'clarify', 'refuse']) {
      expect(cats.has(cat as any)).toBe(true);
    }
    expect(suite.cases.find((c) => c.id === 'cl01')?.expect).toBe('clarify');
    expect(suite.cases.find((c) => c.id === 'rf01')?.expect).toBe('refuse');
    expect(suite.cases.find((c) => c.id === 'sa01')?.expect).toBe('result');
  });

  it('computeCategoryStats 按 category 聚合 total/pass/accuracy', () => {
    const cases = [
      { id: 'a', question: '', goldenSql: 'SELECT 1', category: 'single_agg', expect: 'result' as const },
      { id: 'b', question: '', goldenSql: 'SELECT 1', category: 'single_agg', expect: 'result' as const },
      { id: 'c', question: '', goldenSql: 'SELECT 1', category: 'join', expect: 'result' as const },
    ];
    const results = [
      { caseId: 'a', question: '', status: 'pass' as const, durationMs: 0 },
      { caseId: 'b', question: '', status: 'fail' as const, durationMs: 0 },
      { caseId: 'c', question: '', status: 'pass' as const, durationMs: 0 },
    ];
    const stats = computeCategoryStats(results, cases);
    expect(stats.single_agg.total).toBe(2);
    expect(stats.single_agg.pass).toBe(1);
    expect(stats.single_agg.accuracy).toBeCloseTo(0.5);
    expect(stats.join.total).toBe(1);
    expect(stats.join.accuracy).toBe(1);
  });

  it('isBelowThreshold 阈值判定（等于阈值不算低于）', () => {
    expect(isBelowThreshold(0.8, 0.85)).toBe(true);
    expect(isBelowThreshold(0.9, 0.85)).toBe(false);
    expect(isBelowThreshold(0.8, undefined)).toBe(false);
    expect(isBelowThreshold(0.85, 0.85)).toBe(false);
  });
});
