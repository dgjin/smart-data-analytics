/**
 * 探针 C：m5 灵活查询 - 选表后的字段交互细节
 * 输出：diag/c1..c5 截图 + 关键 DOM 信息（按钮/字段 chip 文本）
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:3000';
const STATE = join(__dirname, '.auth-state.json');
const OUT = join(__dirname, 'diag');
mkdirSync(OUT, { recursive: true });

const bounded = (p, ms) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
let T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1);
const st = (m) => console.log(`[probe-c] t=${el()}s ${m}`);
async function timeIt(label, fn) {
  const s = Date.now();
  let err = '';
  await fn().catch((e) => { err = ' ERR:' + String(e.message || e).slice(0, 120); });
  console.log(`[probe-c] t=${el()}s CLK ${label}: ${((Date.now() - s) / 1000).toFixed(2)}s${err}`);
}

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    storageState: STATE,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[probe-c] PAGEERROR: ${String(e.message || e).slice(0, 160)}`));
  T0 = Date.now();
  await bounded(page.goto(BASE), 20000);
  await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
  st('loaded');

  await timeIt('nav 灵活查询', () => bounded(page.getByText('拖拉拽可视化定制固定报表').click({ timeout: 6000 }), 8000));
  await page.waitForTimeout(2000);
  await timeIt('select ds 数据资源', () => page.getByTestId('datasource-select').selectOption({ label: '数据资源 (MYSQL)' }, { timeout: 8000 }).catch(() => {}));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT, 'c1-builder-mysql.png') });

  // 数据表选择
  const tblSel = page.locator('select').filter({ hasText: '请选择数据表' }).first();
  const cnt = await bounded(tblSel.count(), 2500);
  console.log('[probe-c] tblSel count=', cnt);
  const topts = await bounded(tblSel.locator('option').allTextContents(), 2500);
  console.log('[probe-c] table options=', JSON.stringify(topts));
  if (topts && topts.length > 1) {
    await timeIt('select table idx1', () => tblSel.selectOption({ index: 1 }, { timeout: 6000 }).catch(() => {}));
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(OUT, 'c2-table-selected.png') });
    // 局部截图：左侧 schema 面板 + 数据表与字段面板
    await bounded(page.screenshot({ path: join(OUT, 'c2-left.png'), clip: { x: 0, y: 550, width: 270, height: 460 } }), 5000);
    await bounded(page.screenshot({ path: join(OUT, 'c2-fieldpanel.png'), clip: { x: 270, y: 140, width: 1640, height: 260 } }), 5000);
  }

  // 点击左侧表名试试展开字段
  await timeIt('click 财务宽表(左面板)', () => bounded(page.getByText('财务宽表', { exact: false }).first().click({ timeout: 4000 }), 6000));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT, 'c3-after-table-click.png') });
  await bounded(page.screenshot({ path: join(OUT, 'c3-left.png'), clip: { x: 0, y: 550, width: 270, height: 460 } }), 5000);

  // DOM 信息：可见按钮文本
  const btnTexts = await bounded(
    page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter((b) => b.offsetParent !== null)
        .map((b) => (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30))
        .filter(Boolean)
        .slice(0, 80)
    ),
    3000
  );
  console.log('[probe-c] visible buttons=', JSON.stringify(btnTexts));

  // 左侧面板内的可点击元素（可能为维度/指标 chip）
  const leftTexts = await bounded(
    page.evaluate(() => {
      const root = document.querySelector('aside, [class*=sidebar], [class*=Schema], [class*=schema]') || document.body;
      return Array.from(root.querySelectorAll('button, [role=button], [class*=chip], [class*=tag], li'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => (e.innerText || '').trim().replace(/\s+/g, '|').slice(0, 50))
        .filter(Boolean)
        .slice(0, 60);
    }),
    3000
  );
  console.log('[probe-c] left clickables=', JSON.stringify(leftTexts));

  await timeIt('ctx.close', () => ctx.close());
  await browser.close();
  st('DONE');
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
