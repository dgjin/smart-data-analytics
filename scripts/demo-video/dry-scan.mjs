/**
 * 演示视频 Dry Run 扫描脚本（一次性调研工具）：
 * 登录 → 逐个点击 Sidebar 导航 → 每页截图 + 采集可交互元素清单，
 * 输出到 scripts/demo-video/scan/，用于校正演示脚本的选择器与展示内容。
 *
 * 运行：node scripts/demo-video/dry-scan.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'scan');
mkdirSync(OUT, { recursive: true });

const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const report = {};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

async function collectInteractive(label) {
  const data = await page.evaluate(() => {
    const items = [];
    document
      .querySelectorAll('button, [role="button"], a, input, select, [data-testid]')
      .forEach((el) => {
        const txt = (
          el.innerText ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('data-testid') ||
          el.getAttribute('title') ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 70);
        if (txt) items.push(txt);
      });
    return [...new Set(items)];
  });
  report[label] = data;
  return data;
}

// ── 1. 登录页 ──
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.screenshot({ path: join(OUT, '00-login.png') });
await collectInteractive('login');

// ── 2. 登录 → 主界面 ──
await page.getByPlaceholder('请输入用户名').fill('admin');
await page.getByPlaceholder('请输入密码').fill('admin123');
await page.getByRole('button', { name: /登\s*录/ }).click();
await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, '01-main.png') });
await collectInteractive('main');

// ── 3. 逐模块巡查 ──
const tabs = [
  ['query', /智能问答与查询/],
  ['reports', /可视化决策报表/],
  ['query-reports', /问数报告中心/],
  ['dashboard', /决策数据看板/],
  ['flexquery', /灵活查询/],
  ['datasources', /数据源与 Schema/],
  ['admin', /系统管理/],
];
let i = 2;
for (const [id, re] of tabs) {
  try {
    await page.getByRole('button', { name: re }).first().click();
    await page.waitForTimeout(3800);
    await page.screenshot({ path: join(OUT, `${String(i).padStart(2, '0')}-${id}.png`) });
    await collectInteractive(id);
  } catch (err) {
    report[id] = ['ERROR: ' + String(err.message || err).slice(0, 140)];
    try {
      await page.screenshot({ path: join(OUT, `${String(i).padStart(2, '0')}-${id}-error.png`) });
    } catch {}
  }
  i++;
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log('SCAN_DONE');
console.log(
  JSON.stringify(
    Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.length])),
    null,
    1
  )
);
