import { describe, it, expect } from 'vitest';
import { analyzeSchema, summarizeAnalysis } from './schemaAnalyzer';

describe('schemaAnalyzer', () => {
  describe('analyzeSchema', () => {
    it('识别时序表（含日期列）', () => {
      const tables = [
        {
          name: 'fct_jc_main_biz_stat',
          displayName: '机构投放业务主宽表',
          description: '月末快照口径',
          columns: [
            { name: 'XMBH', type: 'string', isPrimaryKey: true },
            { name: 'BBRQ', type: 'date', description: '报告日期（月末快照）' },
            { name: 'LJTFJE', type: 'number', description: '累计投放金额 (元)' },
          ],
        },
      ];
      const result = analyzeSchema(tables);
      expect(result.timeSeriesTables).toHaveLength(1);
      expect(result.timeSeriesTables[0].tableName).toBe('fct_jc_main_biz_stat');
      expect(result.timeSeriesTables[0].dateColumn).toBe('BBRQ');
      expect(result.timeSeriesTables[0].partitionPattern).toBe('monthly');
    });

    it('识别快照表（表名/注释含快照语义）', () => {
      const tables = [
        {
          name: 'fct_jc_main_biz_stat',
          displayName: '机构投放业务主宽表',
          description: '月末快照口径，包含项目全量经营信息',
          columns: [
            { name: 'BBRQ', type: 'date', description: '报告日期（月末快照）' },
          ],
        },
      ];
      const result = analyzeSchema(tables);
      expect(result.snapshotTables).toHaveLength(1);
      expect(result.snapshotTables[0].tableName).toBe('fct_jc_main_biz_stat');
      expect(result.snapshotTables[0].snapshotColumn).toBe('BBRQ');
      expect(result.snapshotTables[0].evidence).toContain('快照');
    });

    it('识别版本字段（BB/version）', () => {
      const tables = [
        {
          name: 'fct_jc_main_biz_stat',
          columns: [
            { name: 'BB', type: 'category', description: "版本标识（'1'=核算版）" },
          ],
        },
      ];
      const result = analyzeSchema(tables);
      expect(result.versionFields).toHaveLength(1);
      expect(result.versionFields[0].columnName).toBe('BB');
      expect(result.versionFields[0].suggestedFilter).toBe("BB = '1'");
    });

    it('识别主键字段', () => {
      const tables = [
        {
          name: 'fct_jc_main_biz_stat',
          columns: [
            { name: 'XMBH', type: 'string', isPrimaryKey: true, description: '项目编号' },
            { name: 'JGDM', type: 'string', description: '机构代码' },
          ],
        },
      ];
      const result = analyzeSchema(tables);
      expect(result.uniqueFields.length).toBeGreaterThanOrEqual(1);
      const pkField = result.uniqueFields.find((f) => f.columnName === 'XMBH');
      expect(pkField?.fieldType).toBe('primary_key');
    });

    it('识别金额字段并推断单位', () => {
      const tables = [
        {
          name: 'fct_jc_main_biz_stat',
          columns: [
            { name: 'LJTFJE', type: 'number', description: '累计投放金额 (元)' },
            { name: 'BNTFJE', type: 'number', description: '本年投放金额（万元）' },
            { name: 'YQJE', type: 'number', description: '逾期金额（亿元）' },
          ],
        },
      ];
      const result = analyzeSchema(tables);
      expect(result.amountFields).toHaveLength(3);
      expect(result.amountFields.find((f) => f.columnName === 'LJTFJE')?.suggestedUnit).toBe('元');
      expect(result.amountFields.find((f) => f.columnName === 'BNTFJE')?.suggestedUnit).toBe('万元');
      expect(result.amountFields.find((f) => f.columnName === 'YQJE')?.suggestedUnit).toBe('亿元');
    });

    it('空表数组返回空分析结果', () => {
      const result = analyzeSchema([]);
      expect(result.timeSeriesTables).toHaveLength(0);
      expect(result.snapshotTables).toHaveLength(0);
      expect(result.versionFields).toHaveLength(0);
      expect(result.uniqueFields).toHaveLength(0);
      expect(result.amountFields).toHaveLength(0);
    });

    it('无特征表返回空分析结果', () => {
      const tables = [
        {
          name: 'simple_table',
          columns: [
            { name: 'name', type: 'string' },
            { name: 'value', type: 'number' },
          ],
        },
      ];
      const result = analyzeSchema(tables);
      expect(result.timeSeriesTables).toHaveLength(0);
      expect(result.snapshotTables).toHaveLength(0);
      expect(result.versionFields).toHaveLength(0);
    });
  });

  describe('summarizeAnalysis', () => {
    it('生成人类可读摘要', () => {
      const analysis = analyzeSchema([
        {
          name: 'fct_jc_main_biz_stat',
          displayName: '机构投放业务主宽表',
          description: '月末快照口径',
          columns: [
            { name: 'XMBH', type: 'string', isPrimaryKey: true },
            { name: 'BBRQ', type: 'date', description: '报告日期（月末快照）' },
            { name: 'BB', type: 'category', description: "版本标识（'1'=核算版）" },
            { name: 'LJTFJE', type: 'number', description: '累计投放金额 (元)' },
          ],
        },
      ]);
      const summary = summarizeAnalysis(analysis);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary.some((s) => s.includes('时序表'))).toBe(true);
      expect(summary.some((s) => s.includes('快照表'))).toBe(true);
      expect(summary.some((s) => s.includes('版本字段'))).toBe(true);
      expect(summary.some((s) => s.includes('金额字段'))).toBe(true);
    });

    it('空分析结果返回空摘要', () => {
      const summary = summarizeAnalysis(analyzeSchema([]));
      expect(summary).toHaveLength(0);
    });
  });
});
