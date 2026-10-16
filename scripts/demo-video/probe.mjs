/**
 * 探针脚本：复现 m2/m4/m5 流程并精细计时
 *   - 心跳监测：页面 setInterval 250ms，事后统计主线程最大空闲间隙
 *   - 每步计时：所有页面操作 bounded 硬性超时，探测哪个操作被拖住
 *   - 截图：关键状态存 diag/probe-*.png
 * 用法：
 *   node scripts/demo-video/probe.mjs           # 无录屏
 *   VIDEO=1 node scripts/demo-video/probe.mjs   # 带 recordVideo（复现录制条件）
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:3000';
const STATE = join(__dirname, '.auth-state.json');
const VIDEO = process.env.VIDEO === '1';
const OUT = join(__dirname, 'diag');
mkdirSync(OUT, { recursive: true });

const bounded = (p, ms) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
let T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1);
const st = (m) => console.log(`[probe] t=${el()}s ${m}`);
async function timeIt(label, fn) {
  const s = Date.now();
  let err = '';
  await fn().catch((e) => { err = ' ERR:' + String(e.message || e).slice(0, 100); });
  console.log(`[probe] t=${el()}s CLK ${label}: ${((Date.now() - s) / 1000).toFixed(2)}s${err}`);
}

const HB = () => {
  window.__hbLog = [];
  setInterval(() => {
    try {
      window.__hbLog.push(Date.now());
      if (window.__hbLog.length > 9000) window.__hbLog.shift();
    } catch (e) {}
  }, 250);
};

async function heartbeat(page) {
  const log = await bounded(page.evaluate(() => window.__hbLog || []), 4000);
  if (!log || !log.length) return 'n/a';
  let max = 0, at = 0;
  for (let i = 1; i < log.length; i++) {
    const d = log[i] - log[i - 1];
    if (d > max) { max = d; at = log[i - 1]; }
  }
  const span = ((log[log.length - 1] - log[0]) / 1000).toFixed(0);
  return `span=${span}s samples=${log.length} maxGap=${(max / 1000).toFixed(1)}s@end=${new Date(at).toTimeString().slice(0, 8)}`;
}

async function newPage(browser, withVideo) {
  const opts = {
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    storageState: STATE,
  };
  if (withVideo) opts.recordVideo = { dir: join(OUT, 'probe-video'), size: { width: 1920, height: 1080 } };
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(HB);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[probe] PAGEERROR: ${String(e.message || e).slice(0, 160)}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[probe] CONSOLE-ERR: ${msg.text().slice(0, 160)}`);
  });
  return { ctx, page };
}

const mClick = (page, bb) =>
  timeIt('mouse.click', async () => {
    await bounded(page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 5 }), 2000);
    await page.waitForTimeout(300);
    await bounded(page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2), 2500);
  });

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  st(`start VIDEO=${VIDEO}`);

  // ===== m2 flow =====
  {
    const { ctx, page } = await newPage(browser, VIDEO);
    T0 = Date.now();
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    st('m2 loaded');
    const ds = page.getByTestId('datasource-select');
    const opts = await ds.locator('option').allTextContents();
    const demoOpt = opts.find((t) => /demo|演示/i.test(t));
    await timeIt('m2 select demo ds', () => ds.selectOption({ label: demoOpt }));
    await page.waitForTimeout(1500);
    const input = page.getByPlaceholder(/用自然语言提问/);
    await timeIt('m2 type question', async () => {
      await bounded(input.click({ timeout: 5000 }), 6000);
      await input.pressSequentially('对比各渠道的广告消耗与转化ROI', { delay: 60 });
    });
    await input.press('Enter');
    st('m2 query submitted');
    await timeIt('m2 wait recharts', () => page.locator('.recharts-wrapper').first().waitFor({ timeout: 150000 }));
    await page.waitForTimeout(2500);
    st('m2 result shown');
    for (const f of ['折线图', '面积图', '柱状图', '饼图', '环形图']) {
      const loc = page.getByRole('button', { name: f, exact: true }).first();
      const cnt = await bounded(loc.count(), 2000);
      let vis = 'n/a', en = 'n/a', bbx = null;
      if (cnt) {
        vis = String(await bounded(loc.isVisible(), 2000));
        en = String(await bounded(loc.isEnabled(), 2000));
        bbx = await bounded(loc.boundingBox(), 2000);
      }
      console.log(`[probe] m2 formBtn ${f}: count=${cnt} visible=${vis} enabled=${en} bbox=${bbx ? `${Math.round(bbx.x)},${Math.round(bbx.y)} ${Math.round(bbx.width)}x${Math.round(bbx.height)}` : 'null'}`);
    }
    // 滚动到图表卡片工具条（结果页需滚动后按钮才进入视口）
    await timeIt('m2 scroll chart into view', () =>
      bounded(page.getByRole('button', { name: '折线图', exact: true }).first().scrollIntoViewIfNeeded(), 4000));
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, 'probe-m2-card.png') });
    const zh = page.getByRole('button', { name: '折线图', exact: true }).first();
    const bb = await bounded(zh.boundingBox(), 3000);
    console.log('[probe] m2 折线图 in-view bbox=', JSON.stringify(bb));
    if (bb && bb.y > 0) {
      await bounded(page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 5 }), 2000);
      await page.waitForTimeout(400);
      await timeIt('m2 click 折线图(card, mouse)', () => bounded(page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2), 2500));
      await page.waitForTimeout(1800);
      await page.screenshot({ path: join(OUT, 'probe-m2-after-line.png') });
      const mj = page.getByRole('button', { name: '面积图', exact: true }).first();
      const bm = await bounded(mj.boundingBox(), 2000);
      if (bm && bm.y > 0) {
        await bounded(page.mouse.move(bm.x + bm.width / 2, bm.y + bm.height / 2, { steps: 5 }), 1500);
        await bounded(page.mouse.click(bm.x + bm.width / 2, bm.y + bm.height / 2), 2500);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(OUT, 'probe-m2-after-area.png') });
      }
    }
    const fs = page.getByRole('button', { name: '全屏' }).first();
    await timeIt('m2 scroll 全屏 into view', () => bounded(fs.scrollIntoViewIfNeeded(), 4000));
    const fbb = await bounded(fs.boundingBox(), 3000);
    console.log('[probe] m2 全屏 in-view bbox=', JSON.stringify(fbb));
    if (fbb && fbb.y > 0) {
      await bounded(page.mouse.move(fbb.x + fbb.width / 2, fbb.y + fbb.height / 2, { steps: 5 }), 2000);
      await page.waitForTimeout(400);
      await timeIt('m2 click 全屏', () => bounded(page.mouse.click(fbb.x + fbb.width / 2, fbb.y + fbb.height / 2), 2500));
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(OUT, 'probe-m2-fullscreen.png') });
      for (const f of ['折线图', '面积图', '柱状图', '退出全屏', '关闭']) {
        const loc = page.getByRole('button', { name: f, exact: true }).first();
        const cnt = await bounded(loc.count(), 2000);
        let vis = 'n/a', en = 'n/a', bbx = null;
        if (cnt) {
          vis = String(await bounded(loc.isVisible(), 2000));
          en = String(await bounded(loc.isEnabled(), 2000));
          bbx = await bounded(loc.boundingBox(), 2000);
        }
        console.log(`[probe] m2 FS ${f}: count=${cnt} visible=${vis} enabled=${en} bbox=${bbx ? `${Math.round(bbx.x)},${Math.round(bbx.y)} ${Math.round(bbx.width)}x${Math.round(bbx.height)}` : 'null'}`);
      }
      const fsf = page.getByRole('button', { name: '面积图', exact: true }).last();
      const fbb2 = await bounded(fsf.boundingBox(), 2000);
      console.log('[probe] m2 FS 面积图(last) bbox=', JSON.stringify(fbb2));
      if (fbb2 && fbb2.y > 0 && fbb2.y < 1050) {
        await timeIt('m2 click FS 面积图', async () => {
          await bounded(page.mouse.move(fbb2.x + fbb2.width / 2, fbb2.y + fbb2.height / 2, { steps: 5 }), 1500);
          await bounded(page.mouse.click(fbb2.x + fbb2.width / 2, fbb2.y + fbb2.height / 2), 2500);
        });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(OUT, 'probe-m2-fs-area.png') });
      }
      await timeIt('m2 press Escape', () => bounded(page.keyboard.press('Escape'), 2000));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT, 'probe-m2-exit.png') });
    }
    console.log('[probe] m2 heartbeat:', await heartbeat(page));
    await timeIt('m2 ctx.close', () => ctx.close());
  }

  // ===== m4 flow =====
  {
    const { ctx, page } = await newPage(browser, VIDEO);
    T0 = Date.now();
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    st('m4 loaded');
    await timeIt('m4 nav 看板', () => bounded(page.getByText('固化指标图表与看板展示').click({ timeout: 8000 }), 10000));
    await page.waitForTimeout(6500);
    await timeIt('m4 wheel steps', async () => {
      for (let i = 0; i < 7; i++) {
        await bounded(page.mouse.wheel(0, 93), 1500);
        await page.waitForTimeout(60);
      }
    });
    await page.waitForTimeout(9000);
    await bounded(page.mouse.move(960, 640, { steps: 12 }), 2000);
    await page.waitForTimeout(1500);
    st('m4 dashboard view');
    await page.screenshot({ path: join(OUT, 'probe-m4-view.png') });
    const z2 = page.getByRole('button', { name: '2x', exact: true }).first();
    const b2 = await bounded(z2.boundingBox(), 3000);
    console.log('[probe] m4 2x bbox=', JSON.stringify(b2));
    if (b2) await mClick(page, b2);
    else console.log('[probe] m4 2x bbox null');
    await page.waitForTimeout(1500);
    const z1 = page.getByRole('button', { name: '1x', exact: true }).first();
    const b1 = await bounded(z1.boundingBox(), 3000);
    console.log('[probe] m4 1x bbox=', JSON.stringify(b1));
    if (b1) await mClick(page, b1);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT, 'probe-m4.png') });
    for (const f of ['等分三列', '双列网格', '主图聚焦']) {
      const loc = page.getByRole('button', { name: f, exact: true }).first();
      const cnt = await bounded(loc.count(), 2000);
      console.log(`[probe] m4 preset ${f}: count=${cnt}`);
    }
    console.log('[probe] m4 heartbeat:', await heartbeat(page));
    await timeIt('m4 ctx.close', () => ctx.close());
  }

  // ===== m5 flow =====
  {
    const { ctx, page } = await newPage(browser, VIDEO);
    T0 = Date.now();
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    st('m5 loaded');
    const nav = page.getByText('拖拉拽可视化定制固定报表');
    console.log('[probe] m5 nav count=', await bounded(nav.count(), 2500));
    const nbb = await bounded(nav.first().boundingBox(), 3000);
    console.log('[probe] m5 nav bbox=', JSON.stringify(nbb));
    await timeIt('m5 nav click', async () => {
      if (nbb) {
        await bounded(page.mouse.move(nbb.x + nbb.width / 2, nbb.y + nbb.height / 2, { steps: 5 }), 2000);
        await page.waitForTimeout(300);
        await bounded(page.mouse.click(nbb.x + nbb.width / 2, nbb.y + nbb.height / 2), 2500);
      } else {
        await bounded(nav.first().click({ timeout: 5000 }), 6000);
      }
    });
    await page.waitForTimeout(2500);
    st('m5 after nav');
    await page.screenshot({ path: join(OUT, 'probe-m5-builder.png') });
    const ds = page.getByTestId('datasource-select');
    const opts = await bounded(ds.locator('option').allTextContents(), 3000);
    console.log('[probe] m5 ds options:', JSON.stringify(opts));
    const mysqlOpt = (opts || []).find((t) => /数据资源|客户拜访|MYSQL|MySQL/i.test(t));
    console.log('[probe] m5 mysqlOpt=', mysqlOpt);
    if (mysqlOpt) {
      await timeIt('m5 select mysql', () => ds.selectOption({ label: mysqlOpt }, { timeout: 8000 }).catch(() => {}));
      await page.waitForTimeout(3500);
      await page.screenshot({ path: join(OUT, 'probe-m5-after-ds.png') });
    }
    const selCount = await bounded(page.locator('select').count(), 2000);
    console.log('[probe] m5 select count=', selCount);
    if (selCount) {
      const o = await bounded(page.locator('select').first().locator('option').allTextContents(), 2500);
      console.log('[probe] m5 first select options:', JSON.stringify(o && o.slice(0, 10)));
    }
    console.log('[probe] m5 heartbeat:', await heartbeat(page));
    await timeIt('m5 ctx.close', () => ctx.close());
  }

  await browser.close();
  st('PROBE DONE');
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
