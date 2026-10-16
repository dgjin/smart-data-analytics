/**
 * 演示视频交互预演脚本（一次性）：
 * 验证各幕核心交互是否可靠，并截图确认画面效果（不录制）。
 * 输出：scripts/demo-video/scan/r-*.png
 *
 * 运行：node scripts/demo-video/dry-rehearsal.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'scan');
mkdirSync(OUT, { recursive: true });

const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const log = (m) => console.log(`[rehearsal] ${m}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `r-${name}.png`) });
  log(`shot ${name}`);
};

try {
  // ── 登录 ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('请输入用户名').fill('admin');
  await page.getByPlaceholder('请输入密码').fill('admin123');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  log('logged in');

  // ── 幕2 预演：选 Demo 源 + 新鲜问题问数（观察流式过程）──
  const dsSelect = page.getByTestId('datasource-select');
  const opts = await dsSelect.locator('option').allTextContents();
  log('datasource options: ' + JSON.stringify(opts));
  const demoOpt = opts.find((t) => /demo|演示/i.test(t));
  await dsSelect.selectOption({ label: demoOpt });
  await page.waitForTimeout(2500);
  await shot('m2-datasource');

  const input = page.getByPlaceholder(/用自然语言提问/);
  await input.fill('对比各渠道的广告消耗与转化ROI');
  await input.press('Enter');
  await page.waitForTimeout(4000);
  await shot('m2-stream-early');
  await page.waitForTimeout(8000);
  await shot('m2-stream-mid');
  // 等图表出现（结果完成）
  await page.locator('.recharts-wrapper').first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(3000);
  await shot('m2-result');
  log('query result rendered');

  // 结果工具条：全屏 + 导出按钮定位探测
  const fullBtn = page.getByRole('button', { name: '全屏' }).first();
  log('fullscreen btn visible: ' + (await fullBtn.isVisible().catch(() => false)));
  const exportTitles = await page
    .locator('button[title*="导出"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  log('export buttons: ' + JSON.stringify(exportTitles));
  try {
    await fullBtn.click();
    await page.waitForTimeout(2200);
    await shot('m2-fullscreen');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    log('fullscreen ok');
  } catch (e) {
    log('fullscreen fail: ' + e.message.slice(0, 100));
  }

  // ── 幕3 预演：报表页 + 历史报表切换 + 配色切换 ──
  await page.getByText('一键自动生成高管分析简报').click();
  await page.waitForTimeout(4000);
  await shot('m3-report-enter');
  try {
    await page.getByText(/2026年企业战略决策简/).first().click();
    await page.waitForTimeout(3000);
    await shot('m3-report-switch');
    log('report switch ok');
  } catch (e) {
    log('report switch fail: ' + e.message.slice(0, 100));
  }
  try {
    await page.getByRole('button', { name: '翡翠生态' }).first().click();
    await page.waitForTimeout(2000);
    await shot('m3-report-color');
    log('color switch ok');
  } catch (e) {
    log('color switch fail: ' + e.message.slice(0, 100));
  }

  // ── 幕4 预演：看板（滚动展示）──
  await page.getByText('固化指标图表与看板展示').click();
  await page.waitForTimeout(3500);
  await shot('m4-dashboard-top');
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(1200);
  await shot('m4-dashboard-scroll');

  // ── 幕5 预演：灵活查询切源到 MySQL 数据源 ──
  await page.getByText('拖拉拽可视化定制固定报表').click();
  await page.waitForTimeout(2500);
  try {
    const opts2 = await dsSelect.locator('option').allTextContents();
    const mysqlOpt = opts2.find((t) => /客户拜访|评测库|数据资源/.test(t));
    await dsSelect.selectOption({ label: mysqlOpt });
    await page.waitForTimeout(5000);
    await shot('m5-flexquery-mysql');
    log('flexquery switch to: ' + mysqlOpt);
  } catch (e) {
    log('flexquery switch fail: ' + e.message.slice(0, 120));
    await shot('m5-flexquery-fail');
  }

  // ── 幕7 预演：数据源页 + 血缘视图 ──
  await page.getByText('接入 MySQL/PostgreSQL/CSV/API').click();
  await page.waitForTimeout(3000);
  await shot('m7-datasources');
  try {
    await page.getByRole('button', { name: /全链路数据血缘视图/ }).click();
    await page.waitForTimeout(6000);
    await shot('m7-lineage');
    log('lineage opened');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  } catch (e) {
    log('lineage fail: ' + e.message.slice(0, 120));
  }

  // ── 幕8 预演：系统管理（子文本精确定位）──
  try {
    await page.getByText('用户角色与 Token 用量管理').click();
    await page.waitForTimeout(5000);
    await shot('m8-admin');
    const adminTexts = await page.evaluate(() => {
      const t = [];
      document.querySelectorAll('button, [role="tab"], h1, h2, h3, th').forEach((el) => {
        const s = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        if (s) t.push(s);
      });
      return [...new Set(t)].slice(0, 60);
    });
    log('admin page elements: ' + JSON.stringify(adminTexts));
  } catch (e) {
    log('admin fail: ' + e.message.slice(0, 120));
    await shot('m8-admin-fail');
  }
} catch (err) {
  log('FATAL: ' + String(err.message || err).slice(0, 300));
  await shot('fatal');
} finally {
  await browser.close();
  log('REHEARSAL_DONE');
}
