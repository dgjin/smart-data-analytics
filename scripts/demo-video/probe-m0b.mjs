#!/usr/bin/env node
/**
 * probe-m0b：探测「铁律规则」下拉切到「数据资源」后的规则内容（m0 画面脚本需要）。
 * 用法：node scripts/demo-video/probe-m0b.mjs
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

await page.goto(BASE);
await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
const ds = page.getByTestId('datasource-select');
const dsOpts = await ds.locator('option').allTextContents();
await ds.selectOption({ label: dsOpts.find((t) => /数据资源/.test(t)) });
await page.waitForTimeout(2000);

// 系统管理 → 规则治理 → 铁律规则
await page.getByText('用户角色与 Token 用量管理').click();
await page.waitForTimeout(5500);
await page.getByRole('button', { name: '规则治理' }).first().click();
await page.waitForTimeout(3500);
const ironTab = page.getByRole('button', { name: /铁律规则/ }).first();
const bb = await ironTab.boundingBox();
await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.waitForTimeout(3000);

// dump 铁律规则页所有 select
const sels = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('select').forEach((s, i) => {
    const r = s.getBoundingClientRect();
    out.push({
      i,
      testid: s.getAttribute('data-testid') || '',
      value: s.value,
      options: [...s.options].map((o) => `${o.text}|${o.value}`),
      visible: r.width > 0 && r.height > 0,
      x: Math.round(r.x), y: Math.round(r.y),
    });
  });
  return out;
});
console.log('selects:', JSON.stringify(sels.filter((s) => s.visible && !s.testid), null, 1).slice(0, 900));

// 切到数据资源
const target = sels.find((s) => s.visible && !s.testid && s.options.some((o) => /数据资源/.test(o)));
if (target) {
  const v = target.options.find((o) => /数据资源/.test(o)).split('|')[1];
  await page.locator('select').nth(target.i).selectOption(v);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(DIAG, 'probe-m0b-iron-ds.png') });
  const brief = await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const idx = t.indexOf('铁律规则库');
    return t.slice(idx, idx + 500);
  });
  console.log('iron-ds text:', brief.slice(0, 400));
} else {
  console.log('iron select not found');
}

await browser.close();
console.log('PROBE_M0B_DONE');
