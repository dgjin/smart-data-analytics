#!/usr/bin/env node
/**
 * probe-m7：诊断数据源管理页中「数据资源」卡片的可点击元素（DRY 中 exact 文本 bbox=null）。
 * 用法：node scripts/demo-video/probe-m7.mjs
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const STATE = join(__dirname, '.auth-state.json');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const opts = { viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' };
if (existsSync(STATE)) opts.storageState = STATE;
const ctx = await browser.newContext(opts);
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

await page.goto(BASE);
await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
// 顶栏切换数据资源
const ds = page.getByTestId('datasource-select');
const dsOpts = await ds.locator('option').allTextContents();
console.log('topbar options:', JSON.stringify(dsOpts));
await ds.selectOption({ label: dsOpts.find((t) => /数据资源/.test(t)) });
await page.waitForTimeout(2000);
// 导航到数据源页
await page.getByText('接入 MySQL/PostgreSQL/CSV/API').click();
await page.waitForTimeout(9000);

// dump 所有含「数据资源」的元素
const els = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('*').forEach((e) => {
    const t = (e.textContent || '').trim();
    if (!t.includes('数据资源')) return;
    // 只看"较小"元素（避免顶层容器全命中）
    if (t.length > 60) return;
    const r = e.getBoundingClientRect();
    out.push({
      tag: e.tagName,
      cls: String(e.className || '').slice(0, 60),
      text: t.slice(0, 50),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      leaf: e.childElementCount === 0,
    });
  });
  return out.slice(0, 40);
});
console.log('elements containing 数据资源:');
for (const e of els) console.log(' ', JSON.stringify(e));

// 找卡片候选：文字含「数据资源」且可见（w>50,h>20）且 y>150（列表区域）
const card = await page.evaluate(() => {
  const cands = [];
  document.querySelectorAll('*').forEach((e) => {
    const t = (e.textContent || '').trim();
    if (!t.startsWith('数据资源')) return;
    if (t.length > 80) return;
    const r = e.getBoundingClientRect();
    if (r.width < 100 || r.height < 40) return;
    cands.push({ tag: e.tagName, text: t.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: String(e.className||'').slice(0,50) });
  });
  return cands;
});
console.log('card candidates:');
for (const c of card) console.log(' ', JSON.stringify(c));

// 测试点击最小候选卡片
if (card.length) {
  const c = card[card.length - 1];
  console.log(`clicking candidate at (${c.x + c.w / 2}, ${c.y + c.h / 2}) text=${c.text}`);
  await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(__dirname, 'diag', 'probe-m7-after-click.png') });
  console.log('screenshot -> diag/probe-m7-after-click.png');
  // 检查右侧 Schema 面板内容
  const schema = await page.evaluate(() => {
    const t = document.body.innerText;
    const has1 = t.includes('fct_jc_financial_stat') || t.includes('财务宽表');
    const has2 = t.includes('fct_jc_main_biz_stat') || t.includes('主营业务');
    return { 财务宽表: has1, 主营业务: has2 };
  });
  console.log('schema panel check:', JSON.stringify(schema));
}
await browser.close();
console.log('PROBE_M7_DONE');
