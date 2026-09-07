/**
 * M4 报告导出单测：导出数据归一化校验、PPTX 生成 smoke（含无图兜底）、文件名安全化。
 */
import { describe, it, expect } from 'vitest';
import { normalizeExportData, buildReportPptx, buildExportFilename } from './reportExport';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('normalizeExportData', () => {
  it('缺少标题或非对象返回 null', () => {
    expect(normalizeExportData(null)).toBeNull();
    expect(normalizeExportData({ summary: 'x' })).toBeNull();
    expect(normalizeExportData({ title: '   ' })).toBeNull();
  });

  it('合法数据归一化：截断长度、过滤非法图表/非法 base64、KPI 上限 12', () => {
    const data = normalizeExportData({
      title: '测试报告',
      summary: '摘要',
      kpiList: Array.from({ length: 20 }, (_, i) => ({ label: `K${i}`, value: '1' })),
      insights: [{ title: '洞察', type: 'bad-type', content: '内容' }],
      charts: [
        { title: '图1', commentary: '解读', imageBase64: PNG },
        { title: '图2', imageBase64: 'not-valid-base64' },
        { noTitle: true },
      ],
    });
    expect(data).not.toBeNull();
    expect(data!.kpiList).toHaveLength(12);
    expect(data!.insights![0].type).toBe('info'); // 非法类型归一为 info
    expect(data!.charts).toHaveLength(2); // 无 title 的被过滤
    expect(data!.charts![0].imageBase64).toBe(PNG);
    expect(data!.charts![1].imageBase64).toBeUndefined(); // 非法 base64 丢弃（无图兜底）
  });
});

describe('buildReportPptx', () => {
  it('完整报告生成 PPTX（ZIP 魔数校验）', async () => {
    const data = normalizeExportData({
      title: '季度经营简报',
      summary: '本季度整体经营向好。',
      createdAt: '2025-01-15',
      templateType: '综合经营分析',
      kpiList: [
        { label: '营收', value: '1.2亿', change: '+12%', status: 'good' },
        { label: '毛利', value: '3000万', change: '-3%', status: 'bad', anomalyNote: '低于警戒线' },
      ],
      insights: [{ title: '营收增长', type: 'positive', content: '华东区拉动明显', actionItem: '加大投入' }],
      charts: [{ title: '营收趋势', commentary: '持续上行', imageBase64: PNG }],
    })!;
    const buf = await buildReportPptx(data);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    // .pptx 为 ZIP 容器，前两字节为 PK
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('无图无 KPI 无洞察兜底生成不报错', async () => {
    const data = normalizeExportData({ title: '空报告' })!;
    const buf = await buildReportPptx(data);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});

describe('buildExportFilename', () => {
  it('剔除路径分隔符与特殊字符并拼接日期', () => {
    expect(buildExportFilename('2025/Q1: 经营*简报', '2025-01-15')).toBe('2025_Q1_经营_简报_分析简报_2025-01-15.pptx');
    expect(buildExportFilename('', undefined)).toMatch(/^分析报告_分析简报\.pptx$/);
  });
});
