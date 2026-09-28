/**
 * v0.9.82 问数结果文档导出 E2E：mock SSE → 工具条「导出」PDF / Word / MD 下载 → 魔数与内容校验。
 * 依赖：服务已在 127.0.0.1:3000 运行（config webServer 自动复用/拉起）；PDF 生成需 python3 + reportlab。
 * 设计：问数环节 mock SSE（稳定，不受 LLM 波动/配额影响）；导出链路走真实 HTTP → 真实三格式生成器 → 真实浏览器下载。
 * 证据产物（截图与导出文件副本）输出至 assets/.aistudio/（该目录自带 .gitignore，仅本地留档不入库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'admin123' };
const QUESTION = '按区域统计本季度的销售金额';
const SQL = 'SELECT region, SUM(amount) AS total FROM all_channel_sales GROUP BY region';
const ARTIFACTS = path.join(process.cwd(), 'assets', '.aistudio');

// 与 main-flow.spec.ts 同源的完整问数结果载荷（含 KPI / 洞察 / 图表配置 / 明细与中文表头）
const donePayload = {
  success: true,
  dataProvenance: 'simulated',
  executionTimeMs: 260,
  traceId: 'e2e-export-mock-trace',
  result: {
    aiExplanation: '（E2E 模拟）各区域华东销售金额领先，季度环比稳中有升。',
    generatedSQL: SQL,
    thoughtProcess: ['识别维度：区域', '聚合指标：销售金额求和'],
    keyInsights: ['华东占比最高'],
    chartConfig: {
      type: 'bar',
      title: '各区域销售金额',
      xAxisKey: 'region',
      yAxisKeys: ['total'],
      yAxisNames: { total: '销售金额' },
      stacked: false,
    },
    columns: ['region', 'total'],
    totalCount: 5,
    rows: [
      { region: '华东', total: 128000 },
      { region: '华南', total: 96000 },
      { region: '华北', total: 87000 },
      { region: '西南', total: 52000 },
      { region: '东北', total: 41000 },
    ],
    columnNames: { region: '区域', total: '销售金额' },
    kpiMetrics: [{ label: '总销售金额', value: '40.4 万', change: 8.2, trend: 'up', subtext: '本季度合计' }],
    suggestedQuestions: ['按月拆分销售趋势', '各渠道占比分析'],
  },
};
const sseBody = [
  'event: stage\ndata: {"stage":"understanding"}\n\n',
  `event: stage\ndata: ${JSON.stringify({ stage: 'sql_ready', sql: SQL })}\n\n`,
  'event: trace\ndata: {"title":"语义匹配：区域 → region，销售金额 → amount"}\n\n',
  'event: stage\ndata: {"stage":"executed"}\n\n',
  'event: stage\ndata: {"stage":"analyzing"}\n\n',
  `event: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
].join('');

test.describe('问数结果文档导出 E2E', () => {
  test('mock SSE → PDF / Word / MD 三格式下载与内容校验', async ({ page }) => {
    await page.route('**/api/query/natural-language', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        body: sseBody,
      }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // 1. 登录
    await page.getByPlaceholder('请输入用户名').fill(ADMIN.username);
    await page.getByPlaceholder('请输入密码').fill(ADMIN.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page.getByText('当前数据源:')).toBeVisible({ timeout: 30_000 });

    // 2. 选源（导出不依赖真实查询，优先演示数据源保持链路稳定）
    const dsSelect = page.getByTestId('datasource-select');
    await expect(dsSelect).toBeVisible({ timeout: 15_000 });
    const options = await dsSelect.locator('option').allTextContents();
    const pick = options.find((t) => /演示|demo/i.test(t)) || options.find((t) => t.trim());
    test.skip(!pick, '环境缺少可用数据源，跳过导出链路');
    await dsSelect.selectOption({ label: pick! });

    // 3. 问数（SSE mock；结果含图表/明细/KPI/洞察）
    const input = page.getByPlaceholder(/用自然语言提问/);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(QUESTION);
    await input.press('Enter');
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/销售金额领先/).first()).toBeVisible();

    // 证据截图 1：结果区（含工具条导出按钮组）
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS, 'v082-query-export-01-result-toolbar.png') });

    // 4. 三格式导出：真实点击 → 服务端生成 → 浏览器下载
    const exportAs = async (label: 'PDF' | 'Word' | 'MD') => {
      const btn = page.getByTitle(`导出为 ${label} 文档（含 AI 解读、KPI、SQL、图表与明细数据，带溯源水印）`);
      await expect(btn).toBeEnabled();
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), btn.click()]);
      await expect(page.getByRole('status').filter({ hasText: `${label} 已导出` })).toBeVisible({ timeout: 10_000 });
      const filePath = await download.path();
      expect(filePath).toBeTruthy();
      return { download, buf: fs.readFileSync(filePath!) };
    };

    // ---- PDF ----
    const pdf = await exportAs('PDF');
    expect(pdf.download.suggestedFilename()).toMatch(/_问数结果_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(pdf.buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.buf.length).toBeGreaterThan(10_000);
    expect(pdf.buf.subarray(-2048).toString('latin1')).toContain('%%EOF');
    fs.copyFileSync((await pdf.download.path())!, path.join(ARTIFACTS, 'v082-query-export-result.pdf'));

    // ---- Word（docx 为 ZIP：需含正文部件与图表媒体部件） ----
    const word = await exportAs('Word');
    expect(word.download.suggestedFilename()).toMatch(/_问数结果_\d{4}-\d{2}-\d{2}\.docx$/);
    expect(word.buf.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(word.buf.includes(Buffer.from('word/document.xml'))).toBe(true);
    expect(word.buf.includes(Buffer.from('word/media/'))).toBe(true);
    fs.copyFileSync((await word.download.path())!, path.join(ARTIFACTS, 'v082-query-export-result.docx'));

    // ---- MD（纯文本：全量内容校验，含水印/图表内嵌/中文表头/明细行） ----
    const md = await exportAs('MD');
    expect(md.download.suggestedFilename()).toMatch(/_问数结果_\d{4}-\d{2}-\d{2}\.md$/);
    const text = md.buf.toString('utf8');
    expect(text).toContain(`# ${QUESTION}`);
    expect(text).toContain('数据来源：演示数据');
    expect(text).toMatch(/导出人：admin/); // 服务端注入水印（覆盖前端传入，防伪造）
    expect(text).toContain('严禁外传');
    expect(text).toContain('## AI 解读');
    expect(text).toContain('（E2E 模拟）各区域华东销售金额领先');
    expect(text).toContain('## 核心指标');
    expect(text).toContain('| 总销售金额 | 40.4 万 | 环比 +8.2% · 本季度合计 |');
    expect(text).toContain('## AI 归因分析与决策提示');
    expect(text).toContain('华东占比最高');
    expect(text).toContain('## 生成的 SQL');
    expect(text).toContain(SQL);
    expect(text).toContain('## 图表：各区域销售金额');
    expect(text).toContain('data:image/png;base64,'); // 前端 foreignObject 截图成功内嵌
    expect(text).toContain('| 区域 | 销售金额 |'); // 中文表头映射
    expect(text).toContain('| 华东 | 128000 |');
    expect(text).toContain('（共 5 行）');
    // 页脚水印：导出人（可选部门）· 导出时间 · 系统名——时间恰好出现一次（防「导出人内嵌时间 + 再拼时间」回归）
    expect(text).toMatch(/导出水印：admin(?:（[^）]+）)? · \d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2} · 智能问数据分析系统/);
    fs.copyFileSync((await md.download.path())!, path.join(ARTIFACTS, 'v082-query-export-result.md'));

    // 证据截图 2：导出成功提示（MD 下载后状态行）
    await page.screenshot({ path: path.join(ARTIFACTS, 'v082-query-export-02-md-notice.png') });
  });
});
