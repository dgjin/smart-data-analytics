#!/usr/bin/env node
/**
 * probe-m0：探测系统管理「规则治理」下四个子 tab（语义指标/铁律规则/业务知识库/SQL样例库）
 * 的内容展示效果，为新增开场介绍幕（m0）的画面脚本提供依据。
 * 用法：node scripts/demo-video/probe-m0.mjs
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

// 系统管理 → 规则治理
await page.getByText('用户角色与 Token 用量管理').click();
await page.waitForTimeout(5500);
await page.getByRole('button', { name: '规则治理' }).first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: join(DIAG, 'probe-m0-metrics.png') });
console.log('shot probe-m0-metrics.png (语义指标)');

const tabs = [
  [/铁律规则/, 'probe-m0-iron'],
  [/业务知识库/, 'probe-m0-kb'],
  [/SQL 样例库/, 'probe-m0-sql'],
];
for (const [re, file] of tabs) {
  try {
    const btn = page.getByRole('button', { name: re }).first();
    const bb = await btn.boundingBox();
    if (!bb) { console.log(`tab ${re} bbox=null`); continue; }
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(DIAG, `${file}.png`) });
    // dump 主区域文本概要（判断是否有内容）
    const brief = await page.evaluate(() => {
      const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      return t.slice(0, 260);
    });
    console.log(`shot ${file}.png | text: ${brief.slice(0, 180)}`);
  } catch (e) {
    console.log(`tab ${re} fail: ${String(e.message).slice(0, 100)}`);
  }
}

await browser.close();
console.log('PROBE_M0_DONE');
