/**
 * v0.9.82 问数结果 Word 导出单测：DOCX 生成 smoke（完整/最小/伪造图片经归一化丢弃兜底）。
 */
import { describe, it, expect } from 'vitest';
import { buildQueryWord } from './queryExportWord';
import { normalizeQueryExportData } from './queryExport';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('buildQueryWord', () => {
  it('完整问数结果生成 DOCX（ZIP 魔数校验）', async () => {
    const data = normalizeQueryExportData({
      title: '本月各区域拜访量',
      dataSourceName: '客户拜访管理',
      dataProvenance: 'live',
      exportedBy: '张三（数据部） · 2026-09-28 10:00:00',
      createdAt: '2026-09-28 10:00:00',
      sql: 'SELECT region, COUNT(*) FROM visits GROUP BY region',
      aiExplanation: '整体上行，华东区贡献最大。',
      kpiMetrics: [{ label: '拜访总量', value: '1,234', note: '环比 +3%' }],
      keyInsights: ['华东区增长最快'],
      chartTitle: '区域对比',
      chartImageBase64: PNG,
      columns: ['区域', '拜访量'],
      rows: [
        ['华东', '520'],
        ['华北', '380'],
      ],
      totalCount: 12,
    })!;
    const buf = await buildQueryWord(data);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // .docx 为 ZIP 容器，前两字节为 PK
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('最小载荷（仅标题）兜底生成不报错', async () => {
    const data = normalizeQueryExportData({ title: '最小' })!;
    const buf = await buildQueryWord(data);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('伪造图片载荷（声明 PNG 实为 ICNS）经归一化丢弃后产物仍为有效 DOCX', async () => {
    const ICNS = `data:image/png;base64,${Buffer.concat([Buffer.from('icns'), Buffer.alloc(20)]).toString('base64')}`;
    const data = normalizeQueryExportData({ title: 't', chartImageBase64: ICNS })!;
    expect(data.chartImageBase64).toBeUndefined();
    const buf = await buildQueryWord(data);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
