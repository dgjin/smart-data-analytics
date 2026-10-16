/**
 * 探针 D：m5 灵活查询 - 点击字段（维度/指标）→ 落入分组维度/聚合指标 → SQL 预览
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
async function timeIt(label, fn) {
  const s = Date.now();
  let err = '';
  await fn().catch((e) => { err = ' ERR:' + String(e.message || e).slice(0, 120); });
  console.log(`[probe-d] t=${el()}s CLK ${label}: ${((Date.now() - s) / 1000).toFixed(2)}s${err}`);
}
const dumpZone = async (page, tag) => {
  const t = await bounded(
    page.evaluate(() => {
      const hit = [...document.querySelectorAll('div')].filter((e) => {
        const s = e.innerText || '';
        return s.includes('分组维度') && s.length < 900 && s.includes('聚合指标');
      });
      return hit.length ? hit[hit.length - 1].innerText.replace(/\n+/g, ' | ').slice(0, 500) : 'n/a';
    }),
    3000
  );
  console.log(`[probe-d] ${tag} configArea=`, t);
};

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN', storageState: STATE });
  const page = await ctx.newPage();
  T0 = Date.now();
  await bounded(page.goto(BASE), 20000);
  await page.getByText('当前数据源:').waitFor({ timeout: 30000 });

  await timeIt('nav 灵活查询', () => bounded(page.getByText('拖拉拽可视化定制固定报表').click({ timeout: 6000 }), 8000));
  await page.waitForTimeout(1500);
  await timeIt('select ds 数据资源', () => page.getByTestId('datasource-select').selectOption({ label: '数据资源 (MYSQL)' }, { timeout: 8000 }).catch(() => {}));
  await page.waitForTimeout(2500);
  const tblSel = page.locator('select').filter({ hasText: '请选择数据表' }).first();
  await timeIt('select table 财务宽表', () => tblSel.selectOption({ index: 1 }, { timeout: 6000 }).catch(() => {}));
  await page.waitForTimeout(3000);

  // 点击维度字段「数据日期」左侧 ○ 图标
  const dim = page.getByText('数据日期', { exact: false }).first();
  const dimBB = await bounded(dim.boundingBox(), 3000);
  console.log('[probe-d] dim bbox=', JSON.stringify(dimBB));
  if (dimBB) {
    await timeIt('click dim circle', () => bounded(page.mouse.click(dimBB.x - 20, dimBB.y + dimBB.height / 2), 2500));
    await page.waitForTimeout(1500);
    await bounded(page.screenshot({ path: join(OUT, 'd1-after-dim-click.png') }), 5000);
    await dumpZone(page, 'd1');
  }

  // 点击指标字段「期末-成本余额」左侧 ○ 图标
  const met = page.getByText('期末-成本余额', { exact: false }).first();
  const metBB = await bounded(met.boundingBox(), 3000);
  console.log('[probe-d] met bbox=', JSON.stringify(metBB));
  if (metBB) {
    await timeIt('click metric circle', () => bounded(page.mouse.click(metBB.x - 20, metBB.y + metBB.height / 2), 2500));
    await page.waitForTimeout(1500);
    await bounded(page.screenshot({ path: join(OUT, 'd2-after-met-click.png') }), 5000);
    await dumpZone(page, 'd2');
  }

  // 向下滚动查看查询配置区 / SQL 预览 / 执行查询
  await timeIt('scroll down 800', async () => {
    for (let i = 0; i < 8; i++) {
      await bounded(page.mouse.wheel(0, 100), 1200);
      await page.waitForTimeout(50);
    }
  });
  await page.waitForTimeout(800);
  await bounded(page.screenshot({ path: join(OUT, 'd3-config-area.png') }), 5000);
  await dumpZone(page, 'd3');

  await timeIt('scroll down 800 more', async () => {
    for (let i = 0; i < 8; i++) {
      await bounded(page.mouse.wheel(0, 100), 1200);
      await page.waitForTimeout(50);
    }
  });
  await page.waitForTimeout(800);
  await bounded(page.screenshot({ path: join(OUT, 'd4-sql-area.png') }), 5000);
  const sqlText = await bounded(
    page.evaluate(() => {
      const hit = [...document.querySelectorAll('div, pre, code')].filter((e) => {
        const s = e.innerText || '';
        return /SELECT|select/i.test(s) && s.length < 800 && /FROM|from/.test(s);
      });
      return hit.length ? hit[hit.length - 1].innerText.replace(/\n+/g, ' ').slice(0, 400) : 'n/a';
    }),
    3000
  );
  console.log('[probe-d] SQL preview=', sqlText);
  // 执行查询按钮是否存在
  const runBtn = page.getByText('执行查询', { exact: false }).first();
  console.log('[probe-d] 执行查询 count=', await bounded(page.getByText('执行查询（真实数据库）', { exact: false }).count(), 2500));

  await timeIt('ctx.close', () => ctx.close());
  await browser.close();
  console.log('[probe-d] DONE');
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
