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
  selectEvalCases,
  summarizeRuns,
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
    // （字面量控制在 15 位有效数字内，避免 JS double 精度丢失告警）
    expect(compareRowSets([{ v: 419538967830.73 }], [{ v: 419538967830.726 }])).toBe(true);
    // 超过半分钱的差异判不一致（口径错误差异以千万计，此处验证容差边界）
    expect(compareRowSets([{ v: 100.01 }], [{ v: 100 }])).toBe(false);
    // 锁错快照期级别的差异必须判 fail
    expect(compareRowSets([{ v: 6754900374804.33 }], [{ v: 6756457114688.57 }])).toBe(false);
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

  it('permission 权限类：存在、逐用例 dataSourceId 覆盖且 golden 含部门谓词（P0 扩容）', () => {
    const suite = loadEvalCases();
    expect(suite.cases.length).toBeGreaterThanOrEqual(140);
    const pm = suite.cases.filter((c) => c.category === 'permission');
    expect(pm.length).toBeGreaterThanOrEqual(10);
    for (const c of pm) {
      expect(c.dataSourceId).toBe('ds_eval_crm_dept1');
      expect(c.expect).toBe('result');
      // golden 与受限数据源 rowFilters 同口径（ownerId / ownerName 部门谓词），保证注入后结果等价
      expect(/ownerId IN|ownerName IN/.test(c.goldenSql)).toBe(true);
    }
    // 非 permission 用例不携带 per-case 数据源（走评测集默认源）
    expect(suite.cases.find((c) => c.id === 'sa01')?.dataSourceId).toBeUndefined();
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

describe('P0-4 评测双跑', () => {
  const cases = [
    { id: 'a', question: '', goldenSql: 'SELECT 1', category: 'join', expect: 'result' as const },
    { id: 'b', question: '', goldenSql: 'SELECT 1', category: 'join', expect: 'result' as const },
    { id: 'c', question: '', goldenSql: 'SELECT 1', category: 'join', expect: 'result' as const },
    { id: 'd', question: '', goldenSql: 'SELECT 1', category: 'time', expect: 'result' as const },
    { id: 'e', question: '', goldenSql: 'SELECT 1', category: 'time', expect: 'result' as const },
    { id: 'f', question: '', goldenSql: 'SELECT 1', category: 'single_agg', expect: 'result' as const },
  ];

  it('selectEvalCases：按 ID / 分类（大小写不敏感）/ 每类上限 / 全局上限筛选', () => {
    // 指定 ID
    expect(selectEvalCases(cases, { caseIds: ['a', 'd'] }).map((c) => c.id)).toEqual(['a', 'd']);
    // 分类过滤（大小写不敏感、多分类）
    expect(selectEvalCases(cases, { categories: ['JOIN', 'time'] }).map((c) => c.id)).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
    // 每类上限：每类只留前 2 条
    expect(selectEvalCases(cases, { perCategoryLimit: 2 }).map((c) => c.id)).toEqual([
      'a', 'b', 'd', 'e', 'f',
    ]);
    // 每类上限先于全局上限生效
    expect(selectEvalCases(cases, { perCategoryLimit: 2, limit: 3 }).map((c) => c.id)).toEqual([
      'a', 'b', 'd',
    ]);
    // 无条件时不丢失用例
    expect(selectEvalCases(cases, {})).toHaveLength(cases.length);
  });

  it('summarizeRuns：单跑均值等于该跑准确率、跌幅 0、保留分类统计', () => {
    const runs = [
      {
        accuracy: 0.8,
        pass: 8,
        total: 10,
        byCategory: { join: { total: 5, pass: 4, accuracy: 0.8 } },
      },
    ];
    const s = summarizeRuns(runs, 0.7);
    expect(s.meanAccuracy).toBeCloseTo(0.8);
    expect(s.maxRunDrop).toBe(0);
    expect(s.byCategoryMean.join.accuracy).toBeCloseTo(0.8);
    expect(s.belowThreshold).toBe(false);
  });

  it('summarizeRuns：多跑求均值、分类均值、最大跌幅取 best-mean', () => {
    const mk = (accuracy: number, joinAcc: number) => ({
      accuracy,
      pass: Math.round(accuracy * 10),
      total: 10,
      byCategory: { join: { total: 5, pass: Math.round(joinAcc * 5), accuracy: joinAcc } },
    });
    const s = summarizeRuns([mk(1, 1), mk(0.6, 0.4)], 0.7, 0.15);
    expect(s.meanAccuracy).toBeCloseTo(0.8);
    // best(1) - mean(0.8) = 0.2
    expect(s.maxRunDrop).toBeCloseTo(0.2);
    expect(s.byCategoryMean.join.accuracy).toBeCloseTo(0.7);
    expect(s.byCategoryMean.join.total).toBe(5);
    // 均值 0.8 ≥ 阈值 0.7，但跌幅 0.2 > 0.15 → 门禁失败
    expect(s.belowThreshold).toBe(true);
    // 放宽跌幅上限后通过
    expect(summarizeRuns([mk(1, 1), mk(0.6, 0.4)], 0.7, 0.25).belowThreshold).toBe(false);
  });

  it('summarizeRuns：均值低于阈值不通过；空输入安全返回', () => {
    const mk = (accuracy: number) => ({ accuracy, pass: 0, total: 10, byCategory: {} });
    expect(summarizeRuns([mk(0.5), mk(0.5)], 0.7, 0.15).belowThreshold).toBe(true);
    expect(summarizeRuns([mk(0.5), mk(0.5)], undefined, 0.15).belowThreshold).toBe(false);
    const empty = summarizeRuns([], 0.7);
    expect(empty.meanAccuracy).toBe(0);
    expect(empty.belowThreshold).toBe(false);
  });
});
