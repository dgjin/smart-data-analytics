/**
 * v0.9.82 问数结果文档导出单测：载荷归一化（截断/防御/图片魔数校验）、
 * Markdown 构建（section 动态出现/表格转义/水印）、安全文件名。
 */
import { describe, it, expect } from 'vitest';
import {
  QUERY_EXPORT_MAX_COLUMNS,
  QUERY_EXPORT_MAX_ROWS,
  normalizeQueryExportData,
  buildQueryMarkdown,
  buildQueryExportFilename,
} from './queryExport';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const BASE = {
  title: '本月各区域拜访量',
  dataSourceName: '客户拜访管理',
  dataSourceId: 'ds_1',
  dataProvenance: 'live',
  sql: 'SELECT region, COUNT(*) AS cnt FROM visits GROUP BY region',
  aiExplanation: '本月拜访量整体上行。',
  kpiMetrics: [{ label: '拜访总量', value: '1,234', note: '环比 +3%' }],
  keyInsights: ['华东区增长最快', '西南区待补齐'],
  chartTitle: '区域拜访量对比',
  chartImageBase64: PNG,
  columns: ['区域', '拜访量'],
  rows: [
    ['华东', '520'],
    ['华北', '380'],
  ],
  totalCount: 12,
  createdAt: '2026-09-28 10:00:00',
  exportedBy: '张三（数据部） · 2026-09-28 10:00:00',
};

describe('normalizeQueryExportData', () => {
  it('缺少提问原文返回 null；title 空白亦然', () => {
    expect(normalizeQueryExportData(null)).toBeNull();
    expect(normalizeQueryExportData({ columns: ['a'] })).toBeNull();
    expect(normalizeQueryExportData({ title: '   ' })).toBeNull();
  });

  it('完整载荷归一化：来源标签、明细与截断标记', () => {
    const d = normalizeQueryExportData(BASE)!;
    expect(d.title).toBe('本月各区域拜访量');
    expect(d.provenanceLabel).toBe('真实数据');
    expect(d.columns).toEqual(['区域', '拜访量']);
    expect(d.rows).toEqual([
      ['华东', '520'],
      ['华北', '380'],
    ]);
    expect(d.totalCount).toBe(12);
    expect(d.truncated).toBe(true);
    expect(d.chartImageBase64).toBe(PNG);
  });

  it('明细截断前 100 行 / 前 12 列，单元格对象 JSON 化', () => {
    const columns = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 150 }, () => columns.map((_, i) => (i === 0 ? { a: 1 } : 'x')));
    const d = normalizeQueryExportData({ title: 't', columns, rows, totalCount: 150 })!;
    expect(d.columns.length).toBe(QUERY_EXPORT_MAX_COLUMNS);
    expect(d.rows.length).toBe(QUERY_EXPORT_MAX_ROWS);
    expect(d.rows[0][0]).toBe('{"a":1}');
    expect(d.truncated).toBe(true);
  });

  it('伪造 PNG（ICNS 魔数）被丢弃；simulated 标签为演示数据', () => {
    const ICNS = `data:image/png;base64,${Buffer.concat([Buffer.from('icns'), Buffer.alloc(20)]).toString('base64')}`;
    const d = normalizeQueryExportData({ title: 't', chartImageBase64: ICNS, dataProvenance: 'simulated' })!;
    expect(d.chartImageBase64).toBeUndefined();
    expect(d.provenanceLabel).toBe('演示数据');
  });

  it('无 columns 时 rows 为空；totalCount 非法回退为行数', () => {
    const d = normalizeQueryExportData({ title: 't', columns: [], rows: [['a']], totalCount: 'x' })!;
    expect(d.rows).toEqual([]);
    expect(d.totalCount).toBe(0);
  });
});

describe('buildQueryMarkdown', () => {
  it('完整文档：标题/元信息/各 section/尾部水印齐全', () => {
    const md = buildQueryMarkdown(normalizeQueryExportData(BASE)!);
    expect(md).toContain('# 本月各区域拜访量');
    expect(md).toContain('数据源：客户拜访管理');
    expect(md).toContain('数据来源：真实数据');
    expect(md).toContain('导出人：张三（数据部）');
    expect(md).toContain('严禁外传');
    expect(md).toContain('## AI 解读');
    expect(md).toContain('## 核心指标');
    expect(md).toContain('| 拜访总量 | 1,234 | 环比 +3% |');
    expect(md).toContain('## AI 归因分析与决策提示');
    expect(md).toContain('1. 华东区增长最快');
    expect(md).toContain('```sql');
    expect(md).toContain('## 图表：区域拜访量对比');
    expect(md).toContain(`![区域拜访量对比](${PNG})`);
    expect(md).toContain('## 明细数据（共 12 行，展示前 2 行）');
    expect(md).toContain('| 区域 | 拜访量 |');
    expect(md).toContain('导出水印：');
  });

  it('空 section 不出现；KPI 无说明时以 — 占位', () => {
    const md = buildQueryMarkdown(normalizeQueryExportData({ title: '最小', kpiMetrics: [{ label: 'X', value: '1' }] })!);
    expect(md).not.toContain('## AI 解读');
    expect(md).not.toContain('## 生成的 SQL');
    expect(md).not.toContain('## 明细数据');
    expect(md).toContain('| X | 1 | — |');
  });

  it('表格单元格转义：竖线与换行', () => {
    const md = buildQueryMarkdown(
      normalizeQueryExportData({
        title: 't',
        columns: ['col|a', 'b'],
        rows: [['x|y', 'line1\nline2']],
        totalCount: 1,
      })!,
    );
    expect(md).toContain('| col\\|a | b |');
    expect(md).toContain('| x\\|y | line1<br>line2 |');
  });
});

describe('buildQueryExportFilename', () => {
  it('非法字符替换为下划线，带日期与扩展名', () => {
    const name = buildQueryExportFilename('本月/拜访量: 华东 "重点"', '.pdf');
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name).toContain('问数结果');
    expect(name).not.toMatch(/[\\/:*?"<>|\s]/);
    expect(name).toContain(new Date().toISOString().slice(0, 10));
  });

  it('长标题截断为 40 字以内；空标题回退「问数结果」', () => {
    const name = buildQueryExportFilename('长'.repeat(80), '.md');
    const base = name.split('_问数结果_')[0];
    expect(base.length).toBeLessThanOrEqual(40);
    expect(buildQueryExportFilename('', '.md')).toContain('问数结果');
  });
});
