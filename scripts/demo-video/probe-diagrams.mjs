#!/usr/bin/env node
/**
 * probe-diagrams：探测 docs/diagrams 下三张 Archify HTML（架构图/功能流程图/推导过程图）
 * 在 1920x1080 headless Chrome + file:// 下的渲染、缩放与「引导视图」交互效果。
 * 用法：node scripts/demo-video/probe-diagrams.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIAG = join(__dirname, 'diag');
mkdirSync(DIAG, { recursive: true });
const DOCS = join(__dirname, '..', '..', 'docs', 'diagrams');

const FILES = [
  ['arch', '完整系统架构图.html'],
  ['flow', '系统功能流程图.html'],
  ['deriv', '智能问数推导过程图.html'],
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

for (const [tag, file] of FILES) {
  const url = 'file://' + join(DOCS, file);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // 页面尺寸与主图区域
  const info = await page.evaluate(() => {
    const surface = document.querySelector('.diagram-surface, svg, .diagram-root');
    const r = surface ? surface.getBoundingClientRect() : null;
    const zoom = document.querySelector('[data-zoom-label], .zoom-label, #zoom-level');
    return {
      title: (document.querySelector('h1, .diagram-title') || {}).textContent || '',
      bodyScrollW: document.body.scrollWidth,
      bodyScrollH: document.body.scrollHeight,
      surface: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      zoomText: zoom ? zoom.textContent : 'n/a',
    };
  });
  console.log(`[${tag}]`, JSON.stringify(info));

  // 引导视图标签
  const chapters = await page.evaluate(() => {
    const wrap = document.querySelector('.guided-view-chapters');
    if (!wrap) return [];
    return [...wrap.querySelectorAll('button, a, [role="tab"], .guided-view-beat-link')].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
  });
  console.log(`[${tag}] chapters:`, JSON.stringify(chapters));

  await page.screenshot({ path: join(DIAG, `diagram-${tag}-initial.png`) });

  // 依次点击每个视图标签并截图
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (!c.w) continue;
    await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(DIAG, `diagram-${tag}-view${i + 1}.png`) });
    console.log(`[${tag}] clicked view${i + 1} "${c.text}"`);
  }

  // 回到「显示全部」状态并检查 note 文本
  const allBtn = page.locator('#guided-view-all');
  if (await allBtn.count()) {
    await allBtn.first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  const note = await page.evaluate(() => {
    const n = document.querySelector('.guided-view-copy, .guided-view-meta, [class*="view-note"]');
    return n ? (n.textContent || '').trim().slice(0, 140) : 'n/a';
  });
  console.log(`[${tag}] note: ${note}`);
  await page.screenshot({ path: join(DIAG, `diagram-${tag}-all.png`) });
}

await browser.close();
console.log('PROBE_DIAGRAMS_DONE');
