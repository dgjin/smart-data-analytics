/**
 * P2-12 导出通道单测：水印 CSV 纯函数 + v0.9.82 问数结果文档路由（POST /query-doc）HTTP 契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';

// ── mock 声明：必须位于被测路由 import 之前；工厂体惰性引用 spy，规避提升期 TDZ ──
const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

const writeAuditSpy = vi.fn();
vi.mock('../infra/auditLog', () => ({ writeAudit: (...args: unknown[]) => writeAuditSpy(...args) }));

/** Word/PDF 构建器成本高（docx / Python 子进程），桩化以精确控制成功与失败分支 */
const buildQueryWordSpy = vi.fn();
vi.mock('../query/queryExportWord', () => ({ buildQueryWord: (...args: unknown[]) => buildQueryWordSpy(...args) }));

const runQueryPdfGeneratorSpy = vi.fn();
vi.mock('../report/pdfExport', () => ({ runQueryPdfGenerator: (...args: unknown[]) => runQueryPdfGeneratorSpy(...args) }));

import exportRoutes, { buildCsvWithWatermark, csvCell, exportApproveRows, exportMaxRows } from './export';

applyTestEnv();
// 导出链路复用内存限流计数器，放宽阈值避免跨用例误伤（与 report 路由测试一致）
process.env.USER_QUERY_RATE_MAX = '100000';

const app = buildApp('/api/export', exportRoutes);
const auth = (role: 'ADMIN' | 'ANALYST' | 'VIEWER' = 'ADMIN', id = 1) => `Bearer ${tokenFor(role, id)}`;

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

describe('POST /api/export/query-doc（v0.9.82 三格式文档）', () => {
  beforeEach(() => {
    querySpy.mockReset();
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] }]));
    writeAuditSpy.mockReset();
    buildQueryWordSpy.mockReset();
    runQueryPdfGeneratorSpy.mockReset();
  });

  const base = {
    title: '本月各区域拜访量',
    dataSourceName: '客户拜访管理',
    dataSourceId: 'ds_1',
    dataProvenance: 'live',
    columns: ['区域', '拜访量'],
    rows: [['华东', '520']],
    totalCount: 1,
  };

  it('未携带令牌 → 401', async () => {
    const res = await request(app).post('/api/export/query-doc').send({ format: 'md', ...base });
    expect(res.status).toBe(401);
  });

  it('format 非法 / 缺少提问原文 → 400 且审计 DENIED_INPUT', async () => {
    const r1 = await request(app).post('/api/export/query-doc').set('Authorization', auth()).send({ format: 'xlsx', ...base });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toContain('format');
    const r2 = await request(app).post('/api/export/query-doc').set('Authorization', auth()).send({ format: 'md', columns: ['a'] });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toContain('缺少提问原文');
    expect(writeAuditSpy.mock.calls.filter(([a]) => (a as { status?: string }).status === 'DENIED_INPUT').length).toBeGreaterThanOrEqual(2);
  });

  it('markdown：服务端注入导出人水印（覆盖伪造值）+ 附录水印 + SUCCESS 审计', async () => {
    const res = await request(app)
      .post('/api/export/query-doc')
      .set('Authorization', auth())
      .send({ format: 'md', exportedBy: '伪造人', ...base });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''");
    expect(res.text).toContain('# 本月各区域拜访量');
    expect(res.text).toContain('导出人：u1（测试部）');
    expect(res.text).not.toContain('伪造人');
    expect(res.text).toContain('导出水印：');
    expect(writeAuditSpy.mock.calls.some(([a]) => (a as { status?: string }).status === 'SUCCESS')).toBe(true);
  });

  it('word：Content-Type/文件名正确，构建器收到注入水印后的数据', async () => {
    buildQueryWordSpy.mockResolvedValue(Buffer.from('PK-fake-docx'));
    const res = await request(app).post('/api/export/query-doc').set('Authorization', auth()).send({ format: 'word', ...base });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    expect(String(res.headers['content-disposition'])).toContain('.docx');
    const passed = buildQueryWordSpy.mock.calls[0][0] as { exportedBy: string; title: string };
    expect(passed.exportedBy).toContain('u1（测试部）');
    expect(passed.title).toBe('本月各区域拜访量');
  });

  it('pdf：二进制响应 application/pdf 且调用独立生成器', async () => {
    runQueryPdfGeneratorSpy.mockResolvedValue(Buffer.from('%PDF-fake'));
    const res = await request(app).post('/api/export/query-doc').set('Authorization', auth()).send({ format: 'pdf', ...base });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(runQueryPdfGeneratorSpy).toHaveBeenCalledTimes(1);
  });

  it('生成失败 → 500 + FALLBACK 审计', async () => {
    runQueryPdfGeneratorSpy.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/export/query-doc').set('Authorization', auth()).send({ format: 'pdf', ...base });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('PDF 生成失败');
    expect(writeAuditSpy.mock.calls.some(([a]) => (a as { status?: string }).status === 'FALLBACK')).toBe(true);
  });
});
