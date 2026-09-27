import { describe, it, expect } from 'vitest';
import {
  buildCapabilities,
  buildIronRuleTemplates,
  buildKnowledgeEntries,
  buildSuggestions,
  executeAutoConfig,
} from './autoConfig';
import { analyzeSchema } from './schemaAnalyzer';

const MOCK_TABLES = [
  {
    name: 'fct_jc_main_biz_stat',
    displayName: '机构投放业务主宽表',
    description: '月末快照口径，包含项目全量经营信息',
    rowCount: 28500,
    columns: [
      { name: 'XMBH', type: 'string', isPrimaryKey: true, description: '项目编号' },
      { name: 'BBRQ', type: 'date', description: '报告日期（月末快照）' },
      { name: 'BB', type: 'category', description: "版本标识（'1'=核算版）" },
      { name: 'LJTFJE', type: 'number', description: '累计投放金额 (元)' },
      { name: 'YQJE', type: 'number', description: '逾期金额 (元)' },
    ],
  },
];

describe('autoConfig', () => {
  describe('buildCapabilities', () => {
    it('有时序表时启用时序重算', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const caps = buildCapabilities(analysis);
      expect(caps.timeSeriesRecalc.enabled).toBe(true);
      expect(caps.timeSeriesRecalc.dateColumn).toBe('BBRQ');
      expect(caps.timeSeriesRecalc.maxPeriods).toBe(12);
    });

    it('有快照表/版本字段/主键时启用口径校验', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const caps = buildCapabilities(analysis);
      expect(caps.caliberCheck.enabled).toBe(true);
      expect(caps.caliberCheck.rules.snapshotLock).toBe(true);
      expect(caps.caliberCheck.rules.versionFilter).toBe(true);
      expect(caps.caliberCheck.rules.distinctCount).toBe(true);
    });

    it('领域阈值默认关闭（需人工配置）', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const caps = buildCapabilities(analysis);
      expect(caps.domainThresholds.enabled).toBe(false);
      expect(caps.domainThresholds.thresholds).toEqual([]);
    });

    it('无特征表时口径校验关闭', () => {
      const analysis = analyzeSchema([{ name: 'simple', columns: [{ name: 'name', type: 'string' }] }]);
      const caps = buildCapabilities(analysis);
      expect(caps.caliberCheck.enabled).toBe(false);
    });
  });

  describe('buildIronRuleTemplates', () => {
    it('快照表生成最新快照锁定铁律', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const rules = buildIronRuleTemplates(analysis);
      const snapshotRule = rules.find((r) => r.title.includes('最新快照锁定'));
      expect(snapshotRule).toBeDefined();
      expect(snapshotRule?.content).toContain('MAX(BBRQ)');
      expect(snapshotRule?.reason).toContain('快照表');
    });

    it('版本字段生成版本过滤铁律', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const rules = buildIronRuleTemplates(analysis);
      const versionRule = rules.find((r) => r.title.includes('版本过滤'));
      expect(versionRule).toBeDefined();
      expect(versionRule?.content).toContain("BB = '1'");
    });

    it('业务编号字段生成去重计数铁律', () => {
      const tables = [
        {
          name: 'test_table',
          columns: [{ name: 'order_bh', type: 'string', description: '订单编号' }],
        },
      ];
      const analysis = analyzeSchema(tables);
      const rules = buildIronRuleTemplates(analysis);
      const distinctRule = rules.find((r) => r.title.includes('去重计数'));
      expect(distinctRule).toBeDefined();
      expect(distinctRule?.content).toContain('COUNT(DISTINCT order_bh)');
    });

    it('无特征表不生成铁律', () => {
      const analysis = analyzeSchema([{ name: 'simple', columns: [{ name: 'name', type: 'string' }] }]);
      const rules = buildIronRuleTemplates(analysis);
      expect(rules).toHaveLength(0);
    });
  });

  describe('buildKnowledgeEntries', () => {
    it('总是生成数据源概览', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const entries = buildKnowledgeEntries(analysis, MOCK_TABLES, '数据资源库');
      const overview = entries.find((e) => e.title.includes('数据源概览'));
      expect(overview).toBeDefined();
      expect(overview?.content).toContain('机构投放业务主宽表');
      expect(overview?.category).toBe('自动生成');
    });

    it('有时序表时生成时间维度查询注意事项', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const entries = buildKnowledgeEntries(analysis, MOCK_TABLES, '数据资源库');
      const tsEntry = entries.find((e) => e.title.includes('时间维度查询注意事项'));
      expect(tsEntry).toBeDefined();
      expect(tsEntry?.content).toContain('BBRQ');
      expect(tsEntry?.content).toContain('MAX');
    });

    it('有快照表时生成快照口径说明', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const entries = buildKnowledgeEntries(analysis, MOCK_TABLES, '数据资源库');
      const snapEntry = entries.find((e) => e.title.includes('快照口径说明'));
      expect(snapEntry).toBeDefined();
      expect(snapEntry?.content).toContain('静态快照');
      expect(snapEntry?.content).toContain('不跨期累加');
    });

    it('有版本字段时生成版本过滤说明', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const entries = buildKnowledgeEntries(analysis, MOCK_TABLES, '数据资源库');
      const verEntry = entries.find((e) => e.title.includes('版本过滤说明'));
      expect(verEntry).toBeDefined();
      expect(verEntry?.content).toContain("BB = '1'");
    });
  });

  describe('buildSuggestions', () => {
    it('有金额字段时建议配置阈值', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const suggestions = buildSuggestions(analysis);
      expect(suggestions.some((s) => s.includes('金额字段'))).toBe(true);
      expect(suggestions.some((s) => s.includes('语义指标'))).toBe(true);
    });

    it('有快照表/版本字段时建议确认铁律', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const suggestions = buildSuggestions(analysis);
      expect(suggestions.some((s) => s.includes('铁律'))).toBe(true);
    });

    it('有时序表时提示时序重算已启用', () => {
      const analysis = analyzeSchema(MOCK_TABLES);
      const suggestions = buildSuggestions(analysis);
      expect(suggestions.some((s) => s.includes('时序重算'))).toBe(true);
    });
  });

  describe('executeAutoConfig', () => {
    it('完整执行自动化配置', () => {
      const report = executeAutoConfig('ds_test_001', '数据资源库', MOCK_TABLES);
      expect(report.dataSourceId).toBe('ds_test_001');
      expect(report.analysisSummary.length).toBeGreaterThan(0);
      expect(report.capabilities.timeSeriesRecalc.enabled).toBe(true);
      expect(report.ironRuleTemplates.length).toBeGreaterThan(0);
      expect(report.knowledgeEntries.length).toBeGreaterThan(0);
      expect(report.suggestions.length).toBeGreaterThan(0);
    });

    it('空表数组也能正常执行', () => {
      const report = executeAutoConfig('ds_test_002', '空数据源', []);
      expect(report.dataSourceId).toBe('ds_test_002');
      expect(report.analysisSummary).toHaveLength(0);
      expect(report.capabilities.timeSeriesRecalc.enabled).toBe(false);
      expect(report.ironRuleTemplates).toHaveLength(0);
      // 仍然生成数据源概览
      expect(report.knowledgeEntries.some((e) => e.title.includes('数据源概览'))).toBe(true);
    });
  });
});
