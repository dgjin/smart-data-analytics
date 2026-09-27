/**
 * 服务端异常扫描引擎（v0.9.73）单测：
 * 四红线口径校验（各违规场景） / 时序重算 SQL 改写与序列判定 / 分类维度上一期对比 /
 * 领域阈值命中与覆盖 / 本地时间维度检测 / LLM 归因降级（模板 reasoning 保留）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 依赖隔离：DB / LLM / SQL 执行 / Schema 上下文 / 铁律均 mock（纯函数 + 编排逻辑单测）
const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('../llm/llmClient', () => ({ callLLMText: vi.fn() }));
vi.mock('../query/sqlExecutor', () => ({ executeSafeSql: vi.fn() }));
vi.mock('../query/schemaContext', () => ({ loadSchemaContext: vi.fn(), isLiveCapableType: () => true }));
vi.mock('../query/ironRules', () => ({ loadActiveIronRules: vi.fn(async () => []) }));

import {
  checkCaliber,
  collectSqlFacts,
  buildTimeSeriesSql,
  buildPrevPeriodSql,
  detectSeriesAnomalies,
  detectCategoricalShift,
  detectChartSeriesAnomalies,
  isTimeDimensionKey,
  evaluateMetricRule,
  resolveDomainRules,
  normalizeCapabilities,
  parseNumericValue,
  parseLlmAttributionPayload,
  scanReportAnomalies,
  BUILTIN_SNAPSHOT_COLUMNS,
} from './anomalyScan';
import { callLLMText } from '../llm/llmClient';
import type { SavedReport } from '../../src/types/analytics';

const CALIBER_OPTS = {
  snapshotColumns: BUILTIN_SNAPSHOT_COLUMNS,
  rules: { snapshotLock: true, versionFilter: true, distinctCount: true },
};

const LOCKED_SQL =
  "SELECT SUM(LJTFJE) AS total_amount FROM fct_jc_main_biz_stat WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')";

describe('Step 1 口径校验（四红线 AST 静态检查）', () => {
  it('合规 SQL（锁定 + 核算版 + 去重计数）→ 无违规', () => {
    const sql =
      "SELECT COUNT(DISTINCT XMBH) AS c FROM fct_jc_main_biz_stat WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')";
    const res = checkCaliber(sql, CALIBER_OPTS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.violations).toEqual([]);
  });

  it('漏 BB=1 → missing_bb_filter（子查询中的 BB 过滤不算外层合规）', () => {
    const res = checkCaliber("SELECT SUM(LJTFJE) AS total FROM fct_jc_main_biz_stat WHERE BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')", CALIBER_OPTS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.violations.map((v) => v.rule)).toContain('missing_bb_filter');
  });

  it('无 MAX 快照锁定 → missing_snapshot_lock', () => {
    const res = checkCaliber("SELECT SUM(LJTFJE) AS total FROM fct_jc_main_biz_stat WHERE BB = '1' AND BBRQ >= '2026-01-01'", CALIBER_OPTS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.violations.map((v) => v.rule)).toContain('missing_snapshot_lock');
  });

  it('GROUP BY 快照列的序列查询 → 不报缺锁定（天然合规）', () => {
    const res = checkCaliber("SELECT BBRQ, SUM(LJTFJE) AS total FROM fct_jc_main_biz_stat WHERE BB = '1' GROUP BY BBRQ", CALIBER_OPTS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.violations).toEqual([]);
  });

  it('COUNT(XMBH) 无 DISTINCT → count_not_distinct；COUNT(DISTINCT) 合规', () => {
    const bad = checkCaliber("SELECT COUNT(XMBH) AS c FROM fct_jc_main_biz_stat WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')", CALIBER_OPTS);
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.violations.map((v) => v.rule)).toContain('count_not_distinct');
    const good = checkCaliber("SELECT COUNT(DISTINCT XMBH) AS c FROM fct_jc_main_biz_stat WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')", CALIBER_OPTS);
    if (good.ok) expect(good.violations).toEqual([]);
  });

  it('收益字段走业务表 → wrong_table_for_finance；走财务表合规', () => {
    const bad = checkCaliber("SELECT SUM(DNTZSY) AS income FROM fct_jc_main_biz_stat WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')", CALIBER_OPTS);
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.violations.map((v) => v.rule)).toContain('wrong_table_for_finance');
    const good = checkCaliber("SELECT SUM(DNTZSY) AS income FROM fct_jc_financial_stat WHERE BB = '1' AND SJRQ = (SELECT MAX(SJRQ) FROM fct_jc_financial_stat WHERE BB = '1')", CALIBER_OPTS);
    if (good.ok) expect(good.violations).toEqual([]);
  });

  it('不涉及快照/核算版列的普通表 SQL → 天然 N/A 无违规', () => {
    const res = checkCaliber('SELECT name, age FROM clients WHERE age > 18', CALIBER_OPTS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.violations).toEqual([]);
  });

  it('语法非法 SQL → ok:false（不阻断扫描）', () => {
    const res = checkCaliber('SELECT FROM WHERE', CALIBER_OPTS);
    expect(res.ok).toBe(false);
  });

  it('collectSqlFacts：事实收集（锁定列/过滤/COUNT/GROUP BY）', () => {
    const facts = collectSqlFacts(LOCKED_SQL);
    expect(facts).not.toBeNull();
    if (facts) {
      expect(facts.lockedSnapshotColumns).toContain('BBRQ');
      expect(facts.hasVersionFilter).toBe(true);
      expect(facts.tables).toContain('fct_jc_main_biz_stat');
      expect(facts.columns).toContain('LJTFJE');
    }
  });
});

describe('Step 2 时序重算（SQL 改写与序列判定）', () => {
  it('buildTimeSeriesSql：快照锁定 → 近 12 期 DATE_SUB 序列', () => {
    const out = buildTimeSeriesSql(LOCKED_SQL, BUILTIN_SNAPSHOT_COLUMNS, 12);
    expect(out).toBeTruthy();
    expect(out).toMatch(/`?BBRQ`?\s*>=\s*DATE_SUB\s*\(\s*\(SELECT MAX\(`?BBRQ`?\)/i);
    expect(out).toMatch(/INTERVAL\s+12\s+MONTH/i);
    expect(out).toMatch(/GROUP BY `?BBRQ`?/i);
    expect(out).toMatch(/ORDER BY/i);
  });

  it('buildTimeSeriesSql：无锁定 / 已有分类 GROUP BY → null（不适用）', () => {
    expect(buildTimeSeriesSql("SELECT SUM(LJTFJE) FROM fct_jc_main_biz_stat WHERE BB = '1'", BUILTIN_SNAPSHOT_COLUMNS)).toBeNull();
    expect(buildTimeSeriesSql("SELECT JGMC, SUM(BNTFJE) AS v FROM fct_jc_main_biz_stat WHERE BB='1' GROUP BY JGMC", BUILTIN_SNAPSHOT_COLUMNS)).toBeNull();
  });

  it('buildPrevPeriodSql：锁定 → 上一期（MAX < 最新期）', () => {
    const out = buildPrevPeriodSql(LOCKED_SQL, BUILTIN_SNAPSHOT_COLUMNS);
    expect(out).toBeTruthy();
    expect(out).toMatch(/`?BBRQ`?\s*<\s*\(\s*SELECT MAX\(`?BBRQ`?\)/i);
  });

  it('detectSeriesAnomalies：MoM 超阈值 → high（2 倍阈值）；平稳序列 → null', () => {
    const hit = detectSeriesAnomalies(
      [
        { period: '2026-06-30', value: 100 },
        { period: '2026-07-31', value: 100 },
        { period: '2026-08-31', value: 150 },
      ],
      { momPercent: 20, yoyPercent: 30 }
    );
    expect(hit).not.toBeNull();
    if (hit) {
      expect(hit.kind).toBe('mom');
      expect(hit.direction).toBe('up');
      expect(hit.severity).toBe('high'); // 50% ≥ 20% * 2
    }
    const calm = detectSeriesAnomalies(
      [
        { period: '2026-01-31', value: 100 },
        { period: '2026-02-28', value: 101 },
        { period: '2026-03-31', value: 100 },
        { period: '2026-04-30', value: 101 },
      ],
      { momPercent: 20, yoyPercent: 30 }
    );
    expect(calm).toBeNull();
  });

  it('detectSeriesAnomalies：MoM 未超但 YoY 超 → yoy 命中', () => {
    const hit = detectSeriesAnomalies(
      [
        { period: '2025-08-31', value: 60 },
        { period: '2026-07-31', value: 100 },
        { period: '2026-08-31', value: 101 },
      ],
      { momPercent: 20, yoyPercent: 30 }
    );
    expect(hit).not.toBeNull();
    if (hit) expect(hit.kind).toBe('yoy'); // 68.3% ≥ 30%（MoM 仅 1%）
  });

  it('detectSeriesAnomalies：连续 3 期同向 → trend（medium）', () => {
    const hit = detectSeriesAnomalies(
      [
        { period: '2026-06-30', value: 100 },
        { period: '2026-07-31', value: 110 },
        { period: '2026-08-31', value: 120 },
      ],
      { momPercent: 20, yoyPercent: 30 }
    );
    expect(hit).not.toBeNull();
    if (hit) {
      expect(hit.kind).toBe('trend');
      expect(hit.severity).toBe('medium');
    }
  });
});

describe('Step 3 维度适配检测', () => {
  it('isTimeDimensionKey：时间语义命中 / 分类维度不命中', () => {
    expect(isTimeDimensionKey('BBRQ')).toBe(true);
    expect(isTimeDimensionKey('SJRQ')).toBe(true);
    expect(isTimeDimensionKey('月份')).toBe(true);
    expect(isTimeDimensionKey('JGMC')).toBe(false);
    expect(isTimeDimensionKey('机构名称')).toBe(false);
  });

  it('detectCategoricalShift：占比偏移 ≥10pp 命中（不因头部高值误报）', () => {
    const prev = [
      { JGMC: '华东', amt: 150 },
      { JGMC: '华南', amt: 200 },
      { JGMC: '华北', amt: 50 },
      { JGMC: '西部', amt: 60 },
    ];
    const cur = [
      { JGMC: '华东', amt: 100 },
      { JGMC: '华南', amt: 80 },
      { JGMC: '华北', amt: 60 },
      { JGMC: '西部', amt: 40 },
    ];
    const shifts = detectCategoricalShift(cur, prev, 'JGMC', ['amt'], { rankChangeThreshold: 3, shareShiftThreshold: 10 });
    const huanan = shifts.find((s) => s.dimValue === '华南');
    expect(huanan).toBeDefined();
    if (huanan) {
      expect(huanan.shareShift).toBeLessThan(-10); // 43.5% → 28.6%
      expect(huanan.severity).toBe('medium');
    }
    // 华东排名未变且占比偏移小 → 不命中（消除头部机构天然离群的误报）
    expect(shifts.some((s) => s.dimValue === '华东')).toBe(false);
  });

  it('detectCategoricalShift：排名突变 ≥3 位 → 命中', () => {
    const prev = [
      { d: 'A', v: 100 },
      { d: 'B', v: 90 },
      { d: 'C', v: 80 },
      { d: 'D', v: 70 },
      { d: 'E', v: 60 },
      { d: 'X', v: 50 },
    ];
    const cur = [
      { d: 'X', v: 200 },
      { d: 'A', v: 95 },
      { d: 'B', v: 85 },
      { d: 'C', v: 75 },
      { d: 'D', v: 65 },
      { d: 'E', v: 55 },
    ];
    const shifts = detectCategoricalShift(cur, prev, 'd', ['v'], { rankChangeThreshold: 3, shareShiftThreshold: 10 });
    const x = shifts.find((s) => s.dimValue === 'X');
    expect(x).toBeDefined();
    if (x) {
      expect(x.rankChange).toBe(5); // 第 6 位 → 第 1 位
      expect(x.severity).toBe('high'); // 占比 11% → 35%（≥ 2 倍阈值）
    }
  });

  it('detectCategoricalShift：长尾分类（占比 <1%）排名波动 → 不命中（长尾守卫）', () => {
    const prev = [
      { d: 'A', v: 900 },
      { d: 'B', v: 800 },
      { d: 'C', v: 700 },
      { d: 'D', v: 10 },
      { d: 'E', v: 8 },
      { d: 'F', v: 6 },
      { d: 'G', v: 4 },
    ];
    const cur = [
      { d: 'A', v: 900 },
      { d: 'B', v: 800 },
      { d: 'C', v: 700 },
      { d: 'G', v: 10 },
      { d: 'E', v: 8 },
      { d: 'F', v: 6 },
      { d: 'D', v: 4 },
    ];
    // D 排名第 4 → 第 7、G 第 7 → 第 4（|Δ|=3），但两期占比均 <1% → 不命中
    const shifts = detectCategoricalShift(cur, prev, 'd', ['v'], { rankChangeThreshold: 3, shareShiftThreshold: 10 });
    expect(shifts).toEqual([]);
  });

  it('detectChartSeriesAnomalies：Z-Score 离群与环比突变（时间维度本地检测）', () => {
    const zHits = detectChartSeriesAnomalies(
      [
        { BBRQ: '2026-03-31', v: 100 },
        { BBRQ: '2026-04-30', v: 100 },
        { BBRQ: '2026-05-31', v: 100 },
        { BBRQ: '2026-06-30', v: 100 },
        { BBRQ: '2026-07-31', v: 100 },
        { BBRQ: '2026-08-31', v: 300 },
      ],
      'BBRQ',
      ['v'],
      20
    );
    expect(zHits.some((h) => h.kind === 'zscore' && h.rowIndex === 5)).toBe(true);

    const momHits = detectChartSeriesAnomalies(
      [
        { BBRQ: '2026-01-31', v: 100 },
        { BBRQ: '2026-02-28', v: 100 },
        { BBRQ: '2026-03-31', v: 50 },
        { BBRQ: '2026-04-30', v: 50 },
      ],
      'BBRQ',
      ['v'],
      20
    );
    expect(momHits.some((h) => h.kind === 'mom' && h.rowIndex === 2)).toBe(true);
  });
});

describe('Step 4 领域阈值（内置 + 数据源覆盖）', () => {
  it('evaluateMetricRule：above 阈值分级与边界', () => {
    const rule = { unit: '%', warnAbove: 30, criticalAbove: 40 };
    expect(evaluateMetricRule(42, rule)?.severity).toBe('high');
    expect(evaluateMetricRule(35, rule)?.severity).toBe('medium');
    expect(evaluateMetricRule(20, rule)).toBeNull();
  });

  it('evaluateMetricRule：levels 分级（边界含入下一档）', () => {
    const rule = {
      unit: '万元',
      levels: [
        { maxExclusive: 100, label: '一般', level: 'low' as const },
        { maxExclusive: 500, label: '较大', level: 'medium' as const },
        { label: '重大', level: 'high' as const },
      ],
    };
    expect(evaluateMetricRule(50, rule)?.severity).toBe('low');
    expect(evaluateMetricRule(100, rule)?.severity).toBe('medium'); // ≥100 落入较大档
    expect(evaluateMetricRule(500, rule)?.severity).toBe('high'); // ≥500 重大
    expect(evaluateMetricRule(600, rule)?.severity).toBe('high');
  });

  it('evaluateMetricRule：below 阈值（成本回收率 <50 → medium）与无命中', () => {
    expect(evaluateMetricRule(45, { unit: '%', warnBelow: 50 })?.severity).toBe('medium');
    expect(evaluateMetricRule(60, { unit: '%', warnBelow: 50 })).toBeNull();
    expect(evaluateMetricRule(5, { unit: '%', criticalAbove: 10 })).toBeNull();
  });

  it('resolveDomainRules：关闭 / 名单过滤 / 数据源覆盖 / 内置补齐', () => {
    const disabled = normalizeCapabilities({ domainThresholds: { enabled: false, thresholds: ['长龄化率'] } });
    expect(resolveDomainRules(disabled, null)).toEqual({});

    const cap = normalizeCapabilities({ domainThresholds: { enabled: true, thresholds: ['长龄化率', '逾期金额'] } });
    expect(cap.domainThresholds.enabled).toBe(true);
    const rules = resolveDomainRules(cap, { metrics: { 长龄化率: { unit: '%', warnAbove: 25, criticalAbove: 35 } } });
    expect(rules['长龄化率'].criticalAbove).toBe(35); // 数据源覆盖
    expect(rules['逾期金额'].levels).toBeDefined(); // 内置补齐
    expect(rules['逾期率']).toBeUndefined(); // 名单外不启用
  });

  it('normalizeCapabilities：未配置 → 通用默认（时序开启 / 领域阈值关闭 / 校验全开）', () => {
    const cap = normalizeCapabilities(undefined);
    expect(cap.timeSeriesRecalc.enabled).toBe(true);
    expect(cap.caliberCheck.rules).toEqual({ snapshotLock: true, versionFilter: true, distinctCount: true });
    expect(cap.domainThresholds.enabled).toBe(false);
    expect(cap.categoricalDetection.rankChangeThreshold).toBe(3);
  });

  it('parseNumericValue：千分位/百分号可解析；中文单位不可比返回 null', () => {
    expect(parseNumericValue(42)).toBe(42);
    expect(parseNumericValue('42%')).toBe(42);
    expect(parseNumericValue('1,234.5')).toBe(1234.5);
    expect(parseNumericValue('12.3亿')).toBeNull();
    expect(parseNumericValue('abc')).toBeNull();
    expect(parseNumericValue(null)).toBeNull();
  });
});

describe('Step 5 LLM 归因与主流程', () => {
  beforeEach(() => {
    querySpy.mockReset();
    vi.mocked(callLLMText).mockReset();
  });

  it('parseLlmAttributionPayload：围栏 JSON 可解析；非 JSON 返回空', () => {
    const ok = parseLlmAttributionPayload('```json\n[{"idx":1,"reasoning":"r1","action":"a1"}]\n```');
    expect(ok.size).toBe(1);
    expect(ok.get(1)?.action).toBe('a1');
    expect(parseLlmAttributionPayload('no json here').size).toBe(0);
  });

  // 按 SQL 分派 mock：knowledge_base_entries 查询返回知识库条目，其余（data_sources）返回数据源行
  const mockPoolBySql = (capabilities: Record<string, unknown>) => {
    querySpy.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('knowledge_base_entries')) {
        return [[{ title: '异常检测口径与阈值说明', content: '长龄化率 >40% 为严重异常需上报，>30% 为关注阈值。' }], []];
      }
      return [
        [{ name: '测试源', anomaly_capabilities_json: JSON.stringify(capabilities), anomaly_thresholds_json: null }],
        [],
      ];
    });
  };

  it('scanReportAnomalies：领域阈值命中 high + LLM 降级仍保留模板 reasoning', async () => {
    mockPoolBySql({ domainThresholds: { enabled: true, thresholds: ['长龄化率'] } });
    vi.mocked(callLLMText).mockRejectedValue(new Error('LLM 不可用'));

    const report = {
      id: 'r1',
      title: '测试报表',
      summary: '',
      createdAt: '',
      dataSourceId: 'ds-x',
      templateType: 'executive',
      insights: [],
      kpiList: [{ label: '长龄化率', value: '42%', change: null, status: 'bad' }],
      charts: [],
    } as unknown as SavedReport;

    const out = await scanReportAnomalies({ reportId: 'r1', report, dataSourceId: 'ds-x', skipSqlReplay: true });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.engine).toBe('server-v2');
      expect(out.llmEnriched).toBe(false); // 降级
      const hit = out.anomalies.find((a) => a.metricLabel === '长龄化率');
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe('high');
      expect(String(hit?.reasoning || '').length).toBeGreaterThan(10); // 规则模板文案保留
      expect(hit?.category).toBe('value');
    }
  });

  it('scanReportAnomalies：LLM 归因成功 → reasoning 被领域化替换（含知识库口径注入）', async () => {
    mockPoolBySql({ domainThresholds: { enabled: true, thresholds: ['逾期金额'] } });
    vi.mocked(callLLMText).mockResolvedValue('[{"idx":1,"reasoning":"单机构逾期金额达重大级，资产回收放缓。","action":"启动专项催收"}]');

    const report = {
      id: 'r2',
      title: '测试报表',
      summary: '',
      createdAt: '',
      dataSourceId: 'ds-x',
      templateType: 'executive',
      insights: [],
      kpiList: [{ label: '逾期金额', value: 600, change: null, status: 'bad' }],
      charts: [],
    } as unknown as SavedReport;

    const out = await scanReportAnomalies({ reportId: 'r2', report, dataSourceId: 'ds-x', skipSqlReplay: true });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.llmEnriched).toBe(true);
      const hit = out.anomalies.find((a) => a.metricLabel === '逾期金额');
      expect(hit?.severity).toBe('high');
      expect(String(hit?.reasoning)).toContain('专项催收');
      // 知识库注入：LLM user prompt 应包含 kb 条目口径片段（第二参数为 user）
      const userPrompt = String(vi.mocked(callLLMText).mock.calls[0]?.[1] ?? '');
      expect(userPrompt).toContain('异常检测口径（知识库）');
      expect(userPrompt).toContain('长龄化率 >40% 为严重异常需上报');
    }
  });
});
