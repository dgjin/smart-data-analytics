import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCsvWithWatermark, csvCell, exportApproveRows, exportMaxRows } from './export';

describe('P2-12 导出通道（水印 CSV）', () => {
  beforeEach(() => {
    delete process.env.DLP_EXPORT_APPROVE_ROWS;
    delete process.env.DLP_EXPORT_MAX_ROWS;
  });
  afterEach(() => {
    delete process.env.DLP_EXPORT_APPROVE_ROWS;
    delete process.env.DLP_EXPORT_MAX_ROWS;
  });

  describe('阈值配置', () => {
    it('默认审批阈值 5000 / 硬上限 100000', () => {
      expect(exportApproveRows()).toBe(5000);
      expect(exportMaxRows()).toBe(100000);
    });

    it('环境变量覆盖，非法值回退默认', () => {
      process.env.DLP_EXPORT_APPROVE_ROWS = '100';
      process.env.DLP_EXPORT_MAX_ROWS = 'abc';
      expect(exportApproveRows()).toBe(100);
      expect(exportMaxRows()).toBe(100000);
    });
  });

  describe('csvCell 转义', () => {
    it('普通值原样输出', () => {
      expect(csvCell('abc')).toBe('abc');
      expect(csvCell(123)).toBe('123');
    });

    it('null/undefined 输出空串', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(undefined)).toBe('');
    });

    it('含逗号/引号/换行的值正确包裹转义', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    });

    it('对象值 JSON 化', () => {
      expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    });
  });

  describe('buildCsvWithWatermark', () => {
    const base = {
      title: '测试导出',
      columns: ['dept', 'amount'],
      rows: [
        ['风险部', 100],
        ['财务部', 200],
      ],
      username: 'zhangsan',
      department: '风险部',
      exportedAt: new Date('2026-01-21T08:00:00'),
    };

    it('首行/尾行含水印（人/部门/时间/行数）', () => {
      const csv = buildCsvWithWatermark(base);
      const lines = csv.split('\r\n');
      expect(lines[0]).toContain('导出人: zhangsan（风险部）');
      expect(lines[0]).toContain('数据行数: 2');
      expect(lines[0]).toContain('严禁外传');
      expect(lines[lines.length - 1]).toContain('导出水印');
      expect(lines[lines.length - 1]).toContain('zhangsan');
    });

    it('带 BOM 头（Excel 中文兼容）且表头/数据正确', () => {
      const csv = buildCsvWithWatermark(base);
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const lines = csv.split('\r\n');
      expect(lines[1]).toBe('dept,amount');
      expect(lines[2]).toBe('风险部,100');
      expect(lines[3]).toBe('财务部,200');
    });

    it('部门为空时水印不拼括号', () => {
      const csv = buildCsvWithWatermark({ ...base, department: '' });
      expect(csv.split('\r\n')[0]).toContain('导出人: zhangsan ');
    });
  });
});
