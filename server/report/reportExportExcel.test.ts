/**
 * P0-2 Excel 导出单测：XLSX 生成 smoke（含无图兜底）、伪造载荷防御。
 */
import { describe, it, expect } from 'vitest';
import { buildReportExcel } from './reportExportExcel';
import { normalizeExportData } from './reportExport';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('buildReportExcel', () => {
  it('完整报告生成 XLSX（ZIP 魔数校验）', async () => {
    const data = normalizeExportData({
      title: '季度经营简报',
      summary: '本季度整体经营向好。',
      createdAt: '2025-01-15',
      templateType: '综合经营分析',
      exportedBy: '张三（数据部） · 2025-01-15 10:00:00',
      kpiList: [
        { label: '营收', value: '1.2亿', change: '+12%', status: 'good' },
        { label: '毛利', value: '3000万', change: '-3%', status: 'bad', anomalyNote: '低于警戒线' },
      ],
      insights: [{ title: '营收增长', type: 'positive', content: '华东区拉动明显', actionItem: '加大投入' }],
      charts: [{ title: '营收趋势', commentary: '持续上行', imageBase64: PNG }],
    })!;
    const buf = await buildReportExcel(data);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // .xlsx 为 ZIP 容器，前两字节为 PK
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('无图无 KPI 无洞察兜底生成不报错', async () => {
    const data = normalizeExportData({ title: '空报告' })!;
    const buf = await buildReportExcel(data);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('伪造图片载荷（声明 PNG 实为 ICNS）走文字兜底且产物仍为有效 XLSX', async () => {
    const ICNS = `data:image/png;base64,${Buffer.concat([Buffer.from('icns'), Buffer.alloc(20)]).toString('base64')}`;
    const data = normalizeExportData({ title: 'R', charts: [{ title: '图', commentary: '解读', imageBase64: ICNS }] })!;
    const buf = await buildReportExcel(data);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
