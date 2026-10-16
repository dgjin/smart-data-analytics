#!/usr/bin/env node
/**
 * probe-m7m8：探测 m7 数据源详情页（默认 tab / lineage 与 schema 按钮）与 m8 系统管理页 tab 结构。
 * 用法：node scripts/demo-video/probe-m7m8.mjs
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIAG = join(__dirname, 'diag');
mkdirSync(DIAG, { recursive: true });
const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const STATE = join(__dirname, '.auth-state.json');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const opts = { viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' };
if (existsSync(STATE)) opts.storageState = STATE;
const ctx = await browser.newContext(opts);
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const dumpButtons = async (label) => {
  const btns = await page.evaluate(() => {
    return [...document.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { t: (b.textContent || '').trim().slice(0, 24), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    }).filter((b) => b.w > 0);
  });
  console.log(`[${label}] buttons(${btns.length}):`);
  for (const b of btns.slice(0, 40)) console.log('  ', JSON.stringify(b));
};

// ── m7：数据源页 ──
await page.goto(BASE);
await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
await page.getByText('接入 MySQL/PostgreSQL/CSV/API').click();
await page.waitForTimeout(6000);
await dumpButtons('m7-ds-page');

// 点击「数据资源」卡片
const rect = await page.evaluate(() => {
  const els = [...document.querySelectorAll('div,span')].filter(
    (e) => e.childElementCount === 0 && (e.textContent || '').trim() === '数据资源'
  );
  for (const e of els) {
    const r = e.getBoundingClientRect();
    if (r.width > 20 && r.height > 10 && r.x > 250) return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return null;
});
if (rect) {
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.waitForTimeout(3000);
  console.log('clicked 数据资源 card');
  await page.screenshot({ path: join(DIAG, 'probe-m7-after-card.png') });
  await dumpButtons('m7-after-card');
  // 页面文本采样（判断默认 tab）
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 900).replace(/\n+/g, ' | '));
  console.log('[m7-after-card] text:', txt.slice(0, 600));
  // 检查 schema 字段区（维度/指标标签）
  const fieldInfo = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      hasDimension: t.includes('分组维度') || t.includes('维度'),
      hasMetric: t.includes('数值指标') || t.includes('指标'),
      hasLineage: t.includes('血缘'),
    };
  });
  console.log('[m7-after-card] fields:', JSON.stringify(fieldInfo));
} else {
  console.log('数据资源 card NOT found');
}

// ── m8：系统管理页 ──
await page.goto(BASE);
await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
await page.getByText('用户角色与 Token 用量管理').click();
await page.waitForTimeout(6000);
await dumpButtons('m8-sys-page');
const tabs = await page.evaluate(() => {
  return [...document.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { t: (b.textContent || '').trim().slice(0, 20), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((b) => b.w > 0 && b.h > 0 && b.y < 250);
});
console.log('[m8] top-area buttons:', JSON.stringify(tabs));
const txt8 = await page.evaluate(() => document.body.innerText.slice(0, 1200).replace(/\n+/g, ' | '));
console.log('[m8] text:', txt8.slice(0, 700));

await browser.close();
console.log('PROBE_M7M8_DONE');
