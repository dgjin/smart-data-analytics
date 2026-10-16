#!/usr/bin/env node
/**
 * probe-t3：为 m3（报表模板卡片）/ m7（宽表与字段悬停）/ m8（RBAC 区与需求反馈页）采集精确坐标。
 * 用法：node scripts/demo-video/probe-t3.mjs
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

async function ensureLogin() {
  await page.goto(BASE);
  const ph = page.getByPlaceholder('请输入用户名');
  const ok = await Promise.race([
    ph.waitFor({ timeout: 6000 }).then(() => 'login'),
    page.getByText('当前数据源:').waitFor({ timeout: 6000 }).then(() => 'ready'),
  ]).catch(() => 'ready');
  if (ok === 'login') {
    await ph.fill('admin');
    await page.getByPlaceholder('请输入密码').fill('admin123');
    await page.getByRole('button', { name: /登\s*录/ }).click();
  }
  await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
}

const dump = async (label, xmin, ymin, xmax, ymax, max = 60) => {
  const els = await page.evaluate(
    ({ xmin, ymin, xmax, ymax }) => {
      const out = [];
      for (const e of document.querySelectorAll('div,span,button,p,label,td,th')) {
        if (e.childElementCount > 0) continue;
        const t = (e.textContent || '').trim();
        if (!t || t.length > 40 || t.length < 2) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (cx < xmin || cx > xmax || cy < ymin || cy > ymax) continue;
        out.push({ t, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
      return out;
    },
    { xmin, ymin, xmax, ymax }
  );
  console.log(`[${label}] ${els.length} els:`);
  for (const e of els.slice(0, max)) console.log('  ', JSON.stringify(e));
};

// ── m3：报表模板区（卡片名 + 位置）──
await ensureLogin();
await page.getByText('一键自动生成高管分析简报').click().catch(() => {});
await page.waitForTimeout(5000);
await page.screenshot({ path: join(DIAG, 'probe-t-m3-page.png') });
await dump('m3-templates', 300, 120, 1900, 700, 50);

// ── m7：数据源页 → 数据资源卡片 → 宽表列表 → Schema 字段区 ──
await ensureLogin();
await page.getByText('接入 MySQL/PostgreSQL/CSV/API').click().catch(() => {});
await page.waitForTimeout(6000);
await dump('m7-ds-cards', 200, 100, 1900, 640, 60);
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
console.log('[m7] ds-card rect:', JSON.stringify(rect));
if (rect) {
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.waitForTimeout(3500);
}
await page.screenshot({ path: join(DIAG, 'probe-t-m7-after-card.png') });
await dump('m7-tables-area', 0, 560, 1900, 800, 40);
await page.getByRole('button', { name: /数据表 Schema 探测/ }).first().click().catch(() => {});
await page.waitForTimeout(1800);
await page.mouse.move(1300, 700);
await page.mouse.wheel(0, 380);
await page.waitForTimeout(1400);
await page.screenshot({ path: join(DIAG, 'probe-t-m7-scrolled.png') });
await dump('m7-right-after-scroll', 900, 100, 1900, 1040, 70);
await dump('m7-left-after-scroll', 0, 100, 900, 1040, 30);

// ── m8：系统管理 RBAC 区 + 需求反馈页 ──
await ensureLogin();
await page.getByText('用户角色与 Token 用量管理').click().catch(() => {});
await page.waitForTimeout(6000);
await page.screenshot({ path: join(DIAG, 'probe-t-m8-sys.png') });
await dump('m8-rbac-area', 300, 260, 1900, 800, 70);
await page.locator('button:has-text("需求反馈")').last().click().catch(() => {});
await page.waitForTimeout(3500);
await page.screenshot({ path: join(DIAG, 'probe-t-m8-feedback.png') });
await dump('m8-feedback-page', 200, 120, 1900, 950, 70);

await browser.close();
console.log('PROBE_T3_DONE');
