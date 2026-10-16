#!/usr/bin/env node
/**
 * probe-m8：诊断系统管理「规则治理」页「语义指标库」下拉（默认选中第一个数据源 CSV），
 * 测试切换到「数据资源」是否正确，并检查其指标定义展示。
 * 用法：node scripts/demo-video/probe-m8.mjs
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

// 导航到系统管理 → 规则治理
await page.getByText('用户角色与 Token 用量管理').click();
await page.waitForTimeout(6000);
await page.getByRole('button', { name: '规则治理' }).first().click();
await page.waitForTimeout(4000);

// dump 页面上所有 select：位置、值、选项文本
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
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
  });
  return out;
});
console.log('selects on page:');
for (const s of sels) console.log(' ', JSON.stringify({ ...s, options: s.options.slice(0, 10) }));

// 找「语义指标库」下拉：visible 且 options 数量>1 且非顶栏 testid=datasource-select
const target = sels.find((s) => s.visible && !s.testid && s.options.length > 1 && s.options.some((o) => /运营财报|CSV/i.test(o)));
if (target) {
  console.log(`metrics select found @${target.x},${target.y} value=${target.value}`);
  const dsOpt = target.options.find((o) => /数据资源/.test(o));
  if (dsOpt) {
    const val = dsOpt.split('|')[1];
    const handle = page.locator('select').nth(target.i);
    await handle.selectOption(val);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(__dirname, 'diag', 'probe-m8-after-click.png') });
    console.log('selected 数据资源, screenshot -> diag/probe-m8-after-click.png');
    // 检查指标列表区域文本
    const bodyText = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        noMetric: t.includes('该数据源暂无指标定义'),
        hasResourceSelect: true,
      };
    });
    console.log('page check:', JSON.stringify(bodyText));
  } else {
    console.log('option 数据资源 not found in metrics select');
  }
} else {
  console.log('metrics select NOT found');
}

// 另外：直接查 API —— 数据资源的指标定义数量
const apiCheck = await page.evaluate(async () => {
  const res = await fetch('/api/metrics?dataSourceId=ds_1786620486498', { credentials: 'include' });
  const data = await res.json().catch(() => null);
  return { status: res.status, count: Array.isArray(data) ? data.length : data && data.items ? data.items.length : 'n/a', sample: Array.isArray(data) ? data.slice(0, 3).map((m) => m.name) : null };
});
console.log('API /api/metrics?ds_1786620486498:', JSON.stringify(apiCheck));

await browser.close();
console.log('PROBE_M8_DONE');
