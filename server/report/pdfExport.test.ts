/**
 * v0.5.3 ReportLab PDF 导出集成单测。
 * 真实 spawn python3 调 ReportLab 脚本（本机/CI 有 reportlab 时跑生成用例，否则自动跳过）。
 * 覆盖：环境探测、脚本路径解析、合法 PDF 生成（中文/KPI/洞察/图表）、方向切换、异常输入兜底。
 * v0.9.82 扩展：query_pdf.py 问数结果 PDF（标题/指标/洞察/SQL/图表/明细表）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  resolvePdfScriptPath,
  resolveQueryPdfScriptPath,
  checkPdfEnv,
  runPdfGenerator,
  runQueryPdfGenerator,
} from './pdfExport';

// 1x1 红色像素 PNG（合法 data URL，供图表嵌入用例）
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SAMPLE = {
  title: '2026 年上半年经营分析报告',
  summary: '本期营业收入稳步增长，长三角区域贡献突出；坏账率小幅上升需持续关注。',
  createdAt: '2026-08-21',
  templateType: '综合经营分析',
  kpiList: [
    { label: '营业收入', value: '12.6 亿元', change: '+8.3%', status: 'good' },
    { label: '净利润率', value: '15.2%', change: '-0.6pct', status: 'bad' },
    { label: '资产周转率', value: '1.8 次', change: '+0.2', status: 'neutral' },
  ],
  insights: [
    { title: '长三角增长强劲', type: 'positive', content: '该区域收入同比增长 23%。', actionItem: '加大资源倾斜' },
    { title: '坏账率上行', type: 'warning', content: '较上期上升 0.6 个百分点。', actionItem: '加强贷后管理' },
  ],
  charts: [
    { title: '各区域收入对比', commentary: '长三角、珠三角领先。', imageBase64: TINY_PNG },
    { title: '月度趋势（无图兜底）', commentary: '整体呈上行态势。' },
  ],
};

let envOk = false;

beforeAll(async () => {
  envOk = (await checkPdfEnv()).ok;
}, 20000);

describe('resolvePdfScriptPath', () => {
  it('能解析到存在的 report_pdf.py', () => {
    const p = resolvePdfScriptPath();
    expect(p).toBeTruthy();
    expect(p).toMatch(/report_pdf\.py$/);
  });
});

describe('checkPdfEnv', () => {
  it('返回结构合法（ok 布尔，失败时带 reason）', async () => {
    const r = await checkPdfEnv();
    expect(typeof r.ok).toBe('boolean');
    if (!r.ok) expect(typeof r.reason).toBe('string');
  }, 15000);
});

describe('runPdfGenerator（需 python3 + reportlab）', () => {
  // 环境不可用时跳过断言并提示（集成测试依赖外部进程，避免 CI 无 Python 误报）
  const skip = () => {
    if (envOk) return false;
    console.warn('[pdfExport.test] 跳过：python3/reportlab 不可用');
    return true;
  };

  it('生成合法 PDF：%PDF- 头、非空、体积合理', async () => {
    if (skip()) return;
    const pdf = await runPdfGenerator(SAMPLE);
    expect(pdf.length).toBeGreaterThan(2000);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('landscape 横版方向正常生成', async () => {
    if (skip()) return;
    const pdf = await runPdfGenerator({ ...SAMPLE, orientation: 'landscape' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('portrait 竖版方向正常生成', async () => {
    if (skip()) return;
    const pdf = await runPdfGenerator({ ...SAMPLE, orientation: 'portrait' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('仅标题的最小报告也能生成（其余字段缺省）', async () => {
    if (skip()) return;
    const pdf = await runPdfGenerator({ title: '最小报告' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('非法 base64 图表不导致崩溃（脚本内容错）', async () => {
    if (skip()) return;
    const pdf = await runPdfGenerator({
      title: '容错测试',
      charts: [{ title: '坏图', imageBase64: 'data:image/png;base64,!!!notbase64!!!' }],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);
});

// v0.9.82：问数结果 PDF（query_pdf.py，与报告脚本共用 runPdfScript 主体但独立脚本/独立文案）
const QUERY_SAMPLE = {
  title: '本月各区域拜访量',
  dataSourceName: '客户拜访管理',
  dataSourceId: 'ds_1',
  provenanceLabel: '真实数据',
  createdAt: '2026-09-28 10:00:00',
  exportedBy: '张三（数据部） · 2026-09-28 10:00:00',
  sql: 'SELECT region, COUNT(*) AS cnt FROM visits GROUP BY region',
  aiExplanation: '本月拜访量整体上行，华东区贡献最大。',
  kpiMetrics: [{ label: '拜访总量', value: '1,234', note: '环比 +3%' }],
  keyInsights: ['华东区增长最快', '西南区待补齐'],
  chartTitle: '区域拜访量对比',
  chartImageBase64: TINY_PNG,
  columns: ['区域', '拜访量'],
  rows: [
    ['华东', '520'],
    ['华北', '380'],
  ],
  totalCount: 120,
  truncated: true,
};

describe('resolveQueryPdfScriptPath', () => {
  it('能解析到存在的 query_pdf.py', () => {
    const p = resolveQueryPdfScriptPath();
    expect(p).toBeTruthy();
    expect(p).toMatch(/query_pdf\.py$/);
  });
});

describe('runQueryPdfGenerator（需 python3 + reportlab）', () => {
  const skip = () => {
    if (envOk) return false;
    console.warn('[pdfExport.test] 跳过：python3/reportlab 不可用');
    return true;
  };

  it('生成合法 PDF：%PDF- 头、非空（含明细截断注记）', async () => {
    if (skip()) return;
    const pdf = await runQueryPdfGenerator(QUERY_SAMPLE);
    expect(pdf.length).toBeGreaterThan(2000);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('最小载荷（仅标题）兜底生成', async () => {
    if (skip()) return;
    const pdf = await runQueryPdfGenerator({ title: '最小问数结果' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('明细 100 行大表跨页生成不报错', async () => {
    if (skip()) return;
    const rows = Array.from({ length: 100 }, (_, i) => [`区域${i}`, String(i * 10)]);
    const pdf = await runQueryPdfGenerator({ ...QUERY_SAMPLE, chartImageBase64: undefined, rows, totalCount: 500, truncated: true });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60000);

  it('缺少标题：脚本以退出码 2 拒收', async () => {
    if (skip()) return;
    await expect(runQueryPdfGenerator({ sql: 'SELECT 1' })).rejects.toThrow(/退出码 2/);
  }, 60000);
});
