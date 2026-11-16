/**
 * 智能问数演示视频 · 精华版（4–5 分钟）分幕录制脚本（Playwright recordVideo）
 *
 * 背景：首轮录制中 m4/m5 出现"CDP 调用被无上限拖住"（视频被拖到 430-490s）。
 * v2 对策：
 *   1) 每幕独立启动/关闭浏览器 —— 彻底隔离幕间状态；
 *   2) 所有页面操作经 bounded() 硬性超时 —— CDP 调用不再可能无限等待；
 *   3) clickLoc 改为「坐标点击」—— 绕过 actionability 等待（遮挡/动画不再卡死）；
 *   4) 每幕输出心跳统计（页面主线程最大卡顿间隙）+ 分步计时日志。
 *
 * 用法：
 *   node scripts/demo-video/record.mjs                        # 全量正式录制
 *   SCENES=m2,m4,m5 node scripts/demo-video/record.mjs        # 只录指定幕
 *   DRY=1 SCENES=m2,m4,m5 node scripts/demo-video/record.mjs  # 彩排（幕末仅补到 8s）
 *   NOREC=1 SCENES=m5 node scripts/demo-video/record.mjs      # 不录屏，仅验证交互
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const VIDEO_DIR = join(__dirname, 'videos-short');
const DOCS_DIR = join(__dirname, '..', '..', 'docs', 'diagrams');
const STATE = join(__dirname, '.auth-state.json');
const DRY = process.env.DRY === '1';
const NOREC = process.env.NOREC === '1';
const ONLY = (process.env.SCENES || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);
mkdirSync(VIDEO_DIR, { recursive: true });

const rawDur = JSON.parse(readFileSync(join(__dirname, 'audio-short', 'durations.json'), 'utf8'));
const DUR = DRY ? Object.fromEntries(Object.keys(rawDur).map((k) => [k, 8000])) : rawDur;

const log = (m) => console.log(`[record] ${m}`);
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${String((e && e.message) || e).slice(0, 140)}`));

// 永不 reject、超时返回 undefined 的硬性护栏
const bounded = (p, ms) =>
  Promise.race([p.then((v) => v, () => undefined), new Promise((r) => setTimeout(() => r(undefined), ms))]);

// 场景时钟（分步计时日志）
let CUR = '';
let T0 = 0;
const el = () => ((Date.now() - T0) / 1000).toFixed(1);
const step = (m) => log(`[${CUR}] t+${el()}s ${m}`);

// ── 仿真光标（headless 录制不含真实光标，注入一个跟随鼠标的圆点）──
const CURSOR_INIT = () => {
  const ensure = () => {
    if (!document.body || document.querySelector('.sq-cursor')) return;
    const s = document.createElement('style');
    s.textContent =
      '.sq-cursor{position:fixed;width:16px;height:16px;border-radius:50%;' +
      'background:rgba(59,130,246,.85);border:2.5px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.6);' +
      'z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);left:960px;top:540px;' +
      'transition:left .15s ease-out,top .15s ease-out,width .1s,height .1s}' +
      '.sq-cursor.click{width:24px;height:24px;background:rgba(37,99,235,.95)}';
    document.head.appendChild(s);
    const d = document.createElement('div');
    d.className = 'sq-cursor';
    document.body.appendChild(d);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  else ensure();
};

// ── 页面主线程心跳（250ms 计数，事后统计最大间隙）──
const HB_INIT = () => {
  window.__hbLog = [];
  setInterval(() => {
    try {
      window.__hbLog.push(Date.now());
      if (window.__hbLog.length > 40000) window.__hbLog.shift();
    } catch (e) {}
  }, 250);
};

async function heartbeat(page) {
  const hb = await bounded(page.evaluate(() => window.__hbLog || []), 4000);
  if (!hb || !hb.length) return 'n/a';
  let max = 0, at = 0;
  for (let i = 1; i < hb.length; i++) {
    const d = hb[i] - hb[i - 1];
    if (d > max) { max = d; at = hb[i - 1]; }
  }
  return `samples=${hb.length} maxGap=${(max / 1000).toFixed(1)}s@end=${new Date(at).toTimeString().slice(0, 8)}`;
}

async function moveMouse(page, x, y) {
  await bounded(page.mouse.move(x, y, { steps: 10 }), 2500);
  await bounded(
    page.evaluate(
      ({ x, y }) => {
        const d = document.querySelector('.sq-cursor');
        if (d) { d.style.left = x + 'px'; d.style.top = y + 'px'; }
      },
      { x, y }
    ),
    2000
  );
}

// 坐标点击：先 boundingBox（带超时），移动仿真光标后直接 mouse.click；永不抛错
async function clickLoc(page, loc, settle = 260, label = '') {
  const bb = await bounded(loc.first().boundingBox(), 3000);
  if (!bb) {
    step(`click[${label}] bbox=null → fallback`);
    await bounded(loc.first().click({ timeout: 3000 }), 4500);
    return false;
  }
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  await moveMouse(page, cx, cy);
  await page.waitForTimeout(settle);
  await bounded(page.evaluate(() => document.querySelector('.sq-cursor')?.classList.add('click')), 1200);
  await bounded(page.mouse.click(cx, cy), 3000);
  await page.waitForTimeout(140);
  await bounded(
    page.evaluate(() => setTimeout(() => document.querySelector('.sq-cursor')?.classList.remove('click'), 180)),
    1200
  );
  step(`click[${label}] ok`);
  return true;
}

async function ensureInView(page, loc) {
  await bounded(loc.first().scrollIntoViewIfNeeded(), 3500);
  await page.waitForTimeout(250);
}

async function scrollAt(page, x, y, totalDy, steps = 6) {
  await moveMouse(page, x, y);
  const d = totalDy / steps;
  for (let i = 0; i < steps; i++) {
    await bounded(page.mouse.wheel(0, d), 1500);
    await page.waitForTimeout(55);
  }
}

// 点击"精确文本元素"左侧 ○ 图标（灵活查询字段行）；side: left/right/any 按 x 坐标过滤列
async function clickCircleOf(page, exactText, side = 'any') {
  const rect = await bounded(
    page.evaluate(
      ({ t, side }) => {
        const els = [...document.querySelectorAll('*')].filter(
          (e) => e.childElementCount === 0 && (e.textContent || '').trim() === t
        );
        for (const e of els) {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (side === 'right' && r.x < 1000) continue;
          if (side === 'left' && r.x > 1000) continue;
          if (r.y < 0 || r.y > 1080) continue;
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return null;
      },
      { t: exactText, side }
    ),
    3000
  );
  if (!rect) { step(`circle[${exactText}] not found`); return false; }
  const cx = rect.x - 19;
  const cy = rect.y + rect.h / 2;
  await moveMouse(page, cx, cy);
  await page.waitForTimeout(220);
  await bounded(page.mouse.click(cx, cy), 2500);
  await page.waitForTimeout(120);
  step(`circle[${exactText}] clicked`);
  return true;
}

// 点击字段面板中的字段行（维度/指标）——直接点击行文本（行 onClick 自带 addField：维度→分组维度、指标→聚合指标）
// 回避“按 x-20 猜测左侧圆点”的误击问题；side 按列过滤（left=维度列, right=指标列），y 限制在字段列表区域
async function clickFieldRow(page, text, side = 'left') {
  const find = async (loose) =>
    bounded(
      page.evaluate(
        ({ t, side, loose }) => {
          const els = [...document.querySelectorAll('span')].filter(
            (e) => e.childElementCount === 0 && (e.textContent || '').trim().startsWith(t)
          );
          for (const e of els) {
            const r = e.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            if (!loose) {
              if (r.y < 640 || r.y > 1060) continue;
              if (side === 'left' && r.x > 970) continue;
              if (side === 'right' && r.x < 970) continue;
            } else if (r.y < 0 || r.y > 1040) continue;
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
          return null;
        },
        { t: text, side, loose }
      ),
      3000
    );
  let rect = await find(false);
  if (!rect) rect = await find(true);
  if (!rect) { step(`fieldRow[${text}] not found`); return false; }
  const cx = rect.x + Math.min(rect.w / 2, 140);
  const cy = rect.y + rect.h / 2;
  await moveMouse(page, cx, cy);
  await page.waitForTimeout(200);
  await bounded(page.mouse.click(cx, cy), 2500);
  await page.waitForTimeout(150);
  step(`fieldRow[${text}] clicked`);
  return true;
}

// 「后台执行（大查询）」checkbox 是否已勾选（label 包裹 input，点文字即切换）
function isBgChecked(page) {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll('label')].filter((l) => (l.innerText || '').includes('后台执行'));
    const input = labels[0]?.querySelector('input[type="checkbox"]');
    return !!input?.checked;
  });
}

// 统一切换数据源为「数据资源」（演示基线：所有幕均使用这套真实 MySQL 业务库）
async function switchToDataResource(page, tag = '', settleMs = 2500) {
  const ds = page.getByTestId('datasource-select');
  const opts = (await bounded(ds.locator('option').allTextContents(), 3000)) || [];
  const target = opts.find((t) => /数据资源/.test(t));
  if (!target) {
    step(`[${tag}] ds option「数据资源」not found (opts=${opts.length})`);
    return false;
  }
  await bounded(ds.selectOption({ label: target }, { timeout: 6000 }), 8000);
  step(`[${tag}] ds switched -> ${target}`);
  await page.waitForTimeout(settleMs);
  return true;
}

// 系统管理子页的「数据源下拉」（语义指标库/铁律规则库：默认选中第一个 CSV 源，演示需切到数据资源）
async function switchPanelDs(page, tag) {
  const sel = page.locator('select:not([data-testid])').first();
  const opts = (await bounded(sel.locator('option').evaluateAll((els) => els.map((e) => ({ t: (e.textContent || '').trim(), v: e.value }))), 3000)) || [];
  const t = opts.find((o) => /数据资源/.test(o.t));
  if (!t) { step(`panel-ds[${tag}] not found (n=${opts.length})`); return false; }
  await bounded(sel.selectOption(t.v, { timeout: 5000 }), 8000);
  step(`panel-ds[${tag}] -> ${t.t}`);
  return true;
}

// 悬停"精确文本"元素：滚动入视 → 移动仿真光标 → 停留
async function hoverText(page, text, pauseMs = 2500) {
  const loc = page.getByText(text, { exact: true }).first();
  await ensureInView(page, loc);
  const bb = await bounded(loc.boundingBox(), 2500);
  if (!bb) { step(`hover[${text}] no bbox`); return false; }
  await moveMouse(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForTimeout(pauseMs);
  step(`hover[${text}] ok`);
  return true;
}

// ── 预登录：保存 storageState（用于 m2-m9 复用登录态）──
async function prepareAuth() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await bounded(page.goto(BASE), 20000);
  await page.getByPlaceholder('请输入用户名').waitFor({ timeout: 20000 });
  await page.getByPlaceholder('请输入用户名').fill('admin');
  await page.getByPlaceholder('请输入密码').fill('admin123');
  await bounded(page.getByRole('button', { name: /登\s*录/ }).click({ timeout: 8000 }), 10000);
  await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
  await ctx.storageState({ path: STATE });
  await bounded(browser.close(), 15000);
  log('auth state saved');
}

// ── 场景录制包装：独立浏览器 + 硬性超时 + 心跳统计 ──
async function scene(name, fn) {
  const durMs = DUR[name] || 60000;
  CUR = name;
  T0 = Date.now();
  if (!NOREC && !DRY) rmSync(join(VIDEO_DIR, `${name}.webm`), { force: true }); // 防止旧文件残留误用
  log(`[${name}] START target=${(durMs / 1000).toFixed(1)}s`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const opts = { viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' };
  if (name !== 'm1' && existsSync(STATE)) opts.storageState = STATE;
  if (!NOREC) opts.recordVideo = { dir: VIDEO_DIR, size: { width: 1920, height: 1080 } };
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(CURSOR_INIT);
  await ctx.addInitScript(HB_INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  // 屏蔽 Vite HMR 全页 reload：仓库内其他进程写 docs/scripts 会触发 reload，录屏中途刷新会毁掉整幕。
  // 应用本身不用 WebSocket（已核实 src 无 new WebSocket），吞掉 ws 不影响功能。
  await ctx.routeWebSocket(/.*/, () => {});
  page.on('pageerror', (e) => log(`[${name}] PAGEERROR ${String(e.message || e).slice(0, 140)}`));
  try {
    await fn(page);
  } catch (e) {
    log(`[${name}] ERROR ${String(e.message || e).slice(0, 220)}`);
  }
  const elapsed = Date.now() - T0;
  log(`[${name}] heartbeat ${await heartbeat(page)}`);
  const remain = durMs - elapsed - 300;
  if (remain > 0) await page.waitForTimeout(remain);
  // 收尾：先关页面（触发视频落盘），再关 context/browser，全部带硬性超时
  await bounded(page.close(), 15000);
  if (!NOREC) {
    const vp = await bounded(page.video().path(), 20000);
    const target = join(VIDEO_DIR, `${name}.webm`);
    if (vp && existsSync(vp)) {
      try { renameSync(vp, target); } catch (e) { log(`[${name}] rename fail: ${String(e.message).slice(0, 100)}`); }
    }
    if (existsSync(target)) {
      try {
        const t = execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', target,
        ]).toString().trim();
        log(`[${name}] audio=${(durMs / 1000).toFixed(1)}s video=${parseFloat(t).toFixed(1)}s`);
      } catch {}
    } else {
      log(`[${name}] VIDEO MISSING!`);
    }
  }
  await bounded(ctx.close(), 30000);
  await bounded(browser.close(), 20000);
  log(`[${name}] DONE total=${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

const main = async () => {
  if (ONLY.length) log(`scenes filter: ${ONLY.join(',')}${DRY ? ' (DRY)' : ''}${NOREC ? ' (NOREC)' : ''}`);


  // 需要登录态的场景：强制刷新登录（避免 token 过期）
  const needAuth = ['s01', 's02', 's03', 's04', 's05', 's06'].some(want);
  if (needAuth) {
    rmSync(STATE, { force: true });
    await prepareAuth();
  }

  // ── 灵活查询预热：同一 SQL 先跑一遍，让 InnoDB 缓冲池热起来 ──
  // s05 旁白给「执行 → 结果」只有约 9.5s，冷缓冲池第一次跑百万行要 12s+。
  // 注意：后台执行走 /execute-sql-async 任务队列，不读 SQL 结果缓存，只能靠热缓冲池提速。
  if (want('s05') && !DRY && !NOREC) {
    log('[warmup] 预热 s05 灵活查询（单次）…');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      storageState: STATE,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    await ctx.routeWebSocket(/.*/, () => {});
    const once = async (tag) => {
      await bounded(page.goto(BASE), 20000);
      await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
      await clickLoc(page, page.getByText('拖拉拽可视化定制固定报表'), 280, `warm-${tag}-nav`);
      await bounded(
        page.getByTestId('datasource-select').selectOption({ label: '数据资源 (MYSQL)' }, { timeout: 8000 }),
        10000
      );
      const tblSel = page.locator('select[data-testid="flexquery-table-select"]').first();
      if (await bounded(tblSel.count(), 2500)) {
        await bounded(tblSel.selectOption({ index: 1 }, { timeout: 6000 }), 8000);
      }
      await page.waitForTimeout(700);
      if (!(await clickFieldRow(page, '数据日期', 'left'))) return;
      await page.waitForTimeout(500);
      if (!(await clickFieldRow(page, '期末-成本余额', 'right'))) return;
      await page.waitForTimeout(500);
      const bg = page.getByText(/后台执行/).first();
      await ensureInView(page, bg);
      await clickLoc(page, bg, 300, `warm-${tag}-bg`);
      const run = page.getByRole('button', { name: /执行查询/ }).first();
      await ensureInView(page, run);
      // 按钮 disabled={!built.ok}：SQL 未构建完时点击会被静默忽略，必须先等 enabled
      await bounded(
        page.waitForFunction(
          () => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('执行查询'));
            return !!b && !b.disabled;
          },
          undefined,
          { timeout: 20000 }
        ),
        21000
      );
      const t = Date.now();
      await clickLoc(page, run, 280, `warm-${tag}-run`);
      await page.locator('.recharts-wrapper').first().waitFor({ timeout: 60000 });
      log(`[warmup] s05 ${tag} 完成 ${((Date.now() - t) / 1000).toFixed(1)}s`);
    };
    try {
      await once('run1');
    } catch (e) {
      log(`[warmup] s05 失败（不影响录制）：${String(e.message || e).slice(0, 140)}`);
    }
    await bounded(ctx.close(), 20000);
    await bounded(browser.close(), 15000);
  }

  // ── s00 片头（8.3s，动画按 s00.vtt 对齐）──
  if (want('s00')) await scene('s00', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-short', 'intro.html')).href, { waitUntil: 'load' }), 15000);
    await bounded(page.locator('.stage').first().waitFor({ timeout: 5000 }), 5200);
    const delta = (Date.now() - t0) / 1000;
    await bounded(
      page.evaluate((d) => {
        document.body.style.setProperty('--delta', d + 's');
        document.body.classList.add('playing');
      }, delta),
      3000
    );
    step(`intro animations armed (delta=${delta.toFixed(2)}s)`);
  });

  // ── s01 总览与治理闭环（28.7s；句1 0-4.2 欢迎 / 句2 4.15-13.6 定位 / 句3 13.6-28.6 四资产）──
  if (want('s01')) await scene('s01', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 's01', 2000);
    await at(2.0); await moveMouse(page, 960, 320);
    await at(9.2); await moveMouse(page, 760, 640);
    // 句3：系统管理 → 规则治理四类资产，按句子节点切换
    await at(13.4);
    await clickLoc(page, page.getByText('用户角色与 Token 用量管理'), 280, 'nav-sys');
    await bounded(page.getByRole('button', { name: '规则治理' }).first().waitFor({ timeout: 3000 }), 3200);
    await at(15.3);
    await clickLoc(page, page.getByRole('button', { name: '规则治理' }).first(), 260, 'tab-rules');
    await at(17.1);
    await switchPanelDs(page, 's01-metrics');
    await at(19.4);
    await clickLoc(page, page.getByRole('button', { name: /铁律规则/ }).first(), 260, 'tab-iron');
    await at(21.2);
    await switchPanelDs(page, 's01-iron');
    await at(23.0);
    await clickLoc(page, page.getByRole('button', { name: /业务知识库/ }).first(), 260, 'tab-kb');
    await at(25.0);
    await clickLoc(page, page.getByRole('button', { name: /SQL 样例库/ }).first(), 260, 'tab-sql');
    await at(26.6);
    await clickLoc(page, page.getByText('智能问答与查询').first(), 280, 'nav-chat');
    await at(27.8); await moveMouse(page, 900, 420);
  });

  // ── s02 智能问数核心链路（76.2s；句1 0-9.9 主界面 / 句2 9.9-21.6 数据资源 / 句3 21.6-29.5 提问 / 句4 29.5-47.9 推导等待 / 句5 47.9-68.2 结果 / 句6 68.2-74.2 全屏导出 / 句7 74.2-76.1）──
  if (want('s02')) await scene('s02', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    // 句1：主界面 + 八套数据源选择器
    await at(3.0); await moveMouse(page, 1300, 33);
    await at(7.0); await moveMouse(page, 1450, 33);
    // 句2：切换为「数据资源」+ Schema 两张宽表
    await at(10.0);
    await switchToDataResource(page, 's02', 2600);
    await at(14.0); await moveMouse(page, 150, 600);
    await at(18.0); await moveMouse(page, 150, 700);
    // 句3：输入业务问题
    const input = page.getByPlaceholder(/用自然语言提问/);
    await at(21.8);
    await clickLoc(page, input, 300, 'input');
    await input.pressSequentially('分析各业务一级类别的累计投放金额与当年已回现情况', { delay: 100 }).catch(() => {});
    // 句4：回车 → 推导等待（硬上限 48s，避免拖垮整片）
    await at(29.5);
    const submitAt = Date.now();
    await bounded(input.press('Enter'), 3000);
    step('query submitted');
    await bounded(page.locator('.recharts-wrapper').first().waitFor({ timeout: 48000 }), 49000);
    step(`recharts appeared (query ${((Date.now() - submitAt) / 1000).toFixed(1)}s)`);
    await page.waitForTimeout(400); // 等图表入场动画落定再滚动
    // 句5：结果——指标卡 → AI 归因 → 可视化图表形态切换
    // 结果区滚动：在 Recharts 上图区会吞掉 wheel，改为直接操作聊天滚动容器
    const chatScroll = async (mode) => {
      await page.evaluate((m) => {
        const el = [...document.querySelectorAll('div')].find(
          (d) => String(d.className || '').includes('overflow-y-auto') && d.querySelector('.recharts-wrapper')
        );
        if (!el) return;
        if (m === 'metrics') {
          const label = [...el.querySelectorAll('*')].find(
            (n) => n.childElementCount === 0 && (n.textContent || '').includes('累计投放总额')
          );
          if (!label) { el.scrollTop = 0; return; }
          const r = label.getBoundingClientRect();
          el.scrollTop += r.top - el.getBoundingClientRect().top - 80;
        } else {
          el.scrollTop += 520;
        }
      }, mode);
      await page.waitForTimeout(260);
    };
    // 结果一出立即滚到指标卡（句5 前半句就在讲指标卡与 AI 归因）
    await chatScroll('metrics');
    await at(55.6);
    await chatScroll('chart');
    const forms = ['折线图', '面积图'];
    for (let i = 0; i < forms.length; i++) {
      const loc = page.getByRole('button', { name: forms[i], exact: true });
      await ensureInView(page, loc);
      await at(61.2 + i * 3.4);
      await clickLoc(page, loc, 240, `form-${forms[i]}`);
    }
    // 句6：全屏聚焦 + 导出按钮悬停
    const fsBtn = page.getByRole('button', { name: '全屏' });
    await ensureInView(page, fsBtn);
    await at(68.5);
    await clickLoc(page, fsBtn, 280, 'fullscreen');
    await at(71.2);
    await clickLoc(page, page.getByRole('button', { name: '退出全屏' }), 280, 'exit-fs');
    const pdfBtn = page.locator('button[title*="导出为 PDF"]').first();
    await ensureInView(page, pdfBtn);
    const bbPdf = await bounded(pdfBtn.boundingBox(), 2500);
    await at(73.0);
    if (bbPdf) await moveMouse(page, bbPdf.x + bbPdf.width / 2, bbPdf.y + bbPdf.height / 2);
    // 句7：收束
    await at(75.0);
    await moveMouse(page, 900, 560);
  });

  // ── s03 决策报表（32.8s；句1 0-3.1 / 句2 3.0-14.9 四模板 / 句3 14.9-26.2 简报与异常 / 句4 26.2-32.7 配色导出）──
  if (want('s03')) await scene('s03', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 's03', 2200);
    await at(2.6);
    await clickLoc(page, page.getByText('一键自动生成高管分析简报'), 280, 'nav-report');
    // 句2：四套模板悬停巡礼
    await at(6.0); await moveMouse(page, 508, 340);
    await at(8.6); await moveMouse(page, 895, 340);
    await at(11.0); await moveMouse(page, 1281, 340);
    await at(13.2); await moveMouse(page, 1668, 340);
    // 句3：打开历史战略决策简报 → 摘要 → 异常扫描
    await at(15.0);
    await clickLoc(page, page.getByText(/2026年企业战略决策简/).first(), 280, 'open-report');
    await at(17.6); await scrollAt(page, 960, 600, 560);
    await at(21.0); await scrollAt(page, 960, 600, 420);
    await at(24.0); await scrollAt(page, 960, 600, -1000);
    // 句4：配色一键切换 → 导出悬停
    await at(26.6);
    await clickLoc(page, page.getByRole('button', { name: '商务暖金' }).first(), 240, 'palette-warm');
    await at(28.6);
    await clickLoc(page, page.getByRole('button', { name: '极客深蓝' }).first(), 240, 'palette-blue');
    const pdfBtn = page.getByRole('button', { name: /导出高清 PDF 文档/ }).first();
    const bb = await bounded(pdfBtn.boundingBox(), 2500);
    await at(30.6);
    if (bb) await moveMouse(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
    await at(31.8); await moveMouse(page, 960, 520);
  });

  // ── s04 决策看板（18.6s，单句贯穿）──
  if (want('s04')) await scene('s04', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 's04', 2200);
    await at(2.2);
    await clickLoc(page, page.getByText('固化指标图表与看板展示'), 280, 'nav-dashboard');
    // 预设版式 → 卡片 → 缩放
    await at(5.4); await hoverText(page, '等分三列', 800);
    await at(7.4); await hoverText(page, '双列网格', 800);
    await at(9.4); await hoverText(page, '主图聚焦', 800);
    await at(11.4); await scrollAt(page, 960, 550, 650);
    await at(12.6); await moveMouse(page, 325, 551);
    const zoom2 = page.getByRole('button', { name: '2x', exact: true }).first();
    await ensureInView(page, zoom2);
    await at(14.2);
    await clickLoc(page, zoom2, 240, 'zoom-2x');
    const zoom1 = page.getByRole('button', { name: '1x', exact: true }).first();
    await ensureInView(page, zoom1);
    await at(16.0);
    await clickLoc(page, zoom1, 240, 'zoom-1x');
    await at(17.2); await hoverText(page, '同比 YoY', 900);
  });

  // ── s05 灵活查询（31.1s；句1 0-4.3 / 句2 4.2-8.4 切源选表 / 句3 8.4-21.5 字段与 SQL / 句4 21.5-31.0 执行与固化）──
  // 异步任务队列实测有 ~8.4s 下限（提交→轮询→出结果），故 bg/run 提前到 17.6/18.8，结果约 27s 出。
  if (want('s05')) await scene('s05', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await at(2.2);
    await clickLoc(page, page.getByText('拖拉拽可视化定制固定报表'), 280, 'nav-flex');
    // 句2：切换数据源 → 选择财务宽表
    await at(4.4);
    await bounded(
      page.getByTestId('datasource-select').selectOption({ label: '数据资源 (MYSQL)' }, { timeout: 8000 }),
      10000
    );
    await at(5.8);
    const tblSel = page.locator('select[data-testid="flexquery-table-select"]').first();
    const tcnt = await bounded(tblSel.count(), 2500);
    if (tcnt) await bounded(tblSel.selectOption({ index: 1 }, { timeout: 6000 }), 8000);
    step(`table-select count=${tcnt}`);
    // 句3：字段面板 → 维度 → 指标 → SQL 预览
    await at(8.6); await moveMouse(page, 420, 800);
    await at(9.6);
    if (!(await clickFieldRow(page, '数据日期', 'left'))) {
      await clickLoc(page, page.getByText('数据日期', { exact: false }).first(), 260, 'dim-fallback');
    }
    await at(12.6);
    if (!(await clickFieldRow(page, '期末-成本余额', 'right'))) {
      await clickLoc(page, page.getByText('期末-成本余额', { exact: false }).first(), 260, 'met-fallback');
    }
    await at(14.4); await scrollAt(page, 960, 600, 620);
    await at(15.4); await scrollAt(page, 960, 600, 560);
    // 句4：后台执行 → 执行（提前，抵消异步任务 ~8.4s 延迟）
    // 预滚动与「按钮就绪」等待全部前置，保证两次点击按绝对时间精确落点
    const bgLabel = page.getByText(/后台执行/).first();
    const runBtn = page.getByRole('button', { name: /执行查询/ }).first();
    await ensureInView(page, runBtn);
    await bounded(
      page.waitForFunction(
        () => {
          const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('执行查询'));
          return !!b && !b.disabled;
        },
        undefined,
        { timeout: 12000 }
      ),
      13000
    );
    await at(16.6);
    await clickLoc(page, bgLabel, 220, 'bg-mode');
    step(`bg checked=${await isBgChecked(page)}`);
    await at(17.6);
    await clickLoc(page, runBtn, 220, 'run-query');
    const tSubmit = Date.now();
    let rechartsN = 0;
    while (Date.now() - tSubmit < 11000) {
      rechartsN = (await bounded(page.locator('.recharts-wrapper').count(), 2500)) || 0;
      if (rechartsN > 0) break;
      await page.waitForTimeout(1200);
    }
    step(`result recharts=${rechartsN} wait=${((Date.now() - tSubmit) / 1000).toFixed(1)}s`);
    // 结果一出立即滚到结果区（不按绝对时间，避免异步抖动时滚在加载中）
    if (rechartsN > 0) {
      await page.waitForTimeout(350);
      await scrollAt(page, 960, 600, 560);
    }
    await at(28.2); await hoverText(page, '固化至看板（自动更新）', 700);
    await at(29.6); await hoverText(page, '保存为固定报表', 500);
  });

  // ── s06 数据源、元数据与血缘（27.2s；句1 0-3.3 / 句2 3.3-12.7 八套数据源 / 句3 12.7-23.4 Schema 字段 / 句4 23.4-27.2 血缘）──
  if (want('s06')) await scene('s06', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 's06', 2200);
    await at(2.4);
    await clickLoc(page, page.getByText('接入 MySQL/PostgreSQL/CSV/API'), 280, 'nav-ds');
    // 句2：八套数据源卡片悬停
    await at(4.2); await moveMouse(page, 450, 385);
    await at(6.6); await moveMouse(page, 450, 492);
    await at(9.0); await moveMouse(page, 450, 600);
    await at(11.4); await moveMouse(page, 450, 707);
    // 句3：选中「数据资源」→ Schema 探测 → 字段标签
    await at(12.8);
    const dsCardRect = await bounded(
      page.evaluate(() => {
        const els = [...document.querySelectorAll('div,span')].filter(
          (e) => e.childElementCount === 0 && (e.textContent || '').trim() === '数据资源'
        );
        for (const e of els) {
          const r = e.getBoundingClientRect();
          if (r.width > 20 && r.height > 10 && r.x > 250) return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return null;
      }),
      3000
    );
    if (dsCardRect) {
      await moveMouse(page, dsCardRect.x + dsCardRect.w / 2, dsCardRect.y + dsCardRect.h / 2);
      await page.waitForTimeout(250);
      await bounded(page.mouse.click(dsCardRect.x + dsCardRect.w / 2, dsCardRect.y + dsCardRect.h / 2), 3000);
      step(`select-data-resource clicked @${Math.round(dsCardRect.x)},${Math.round(dsCardRect.y)}`);
    } else {
      step('select-data-resource rect=null');
    }
    await at(14.6);
    await clickLoc(page, page.getByRole('button', { name: /数据表 Schema 探测/ }), 260, 'schema-tab');
    await at(16.2); await moveMouse(page, 120, 662);
    await at(17.6); await moveMouse(page, 120, 693);
    await at(18.8); await scrollAt(page, 1300, 700, 380);
    await at(20.2); await moveMouse(page, 1400, 265);
    await at(21.4); await moveMouse(page, 1400, 420);
    // 句4：全链路血缘
    await at(22.6); await scrollAt(page, 1300, 700, -380);
    await at(23.8);
    await clickLoc(page, page.getByRole('button', { name: /全链路数据血缘视图/ }), 260, 'lineage');
    await at(25.2); await moveMouse(page, 930, 640);
    await at(26.4); await moveMouse(page, 1120, 660);
  });

  // ── s07 双闭环与统一记忆体（43.8s，动画按 s07.vtt 对齐）──
  if (want('s07')) await scene('s07', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-short', 'loop.html')).href, { waitUntil: 'load' }), 15000);
    await bounded(page.locator('.stage').first().waitFor({ timeout: 5000 }), 5200);
    const delta = (Date.now() - t0) / 1000;
    await bounded(
      page.evaluate((d) => {
        document.body.style.setProperty('--delta', d + 's');
        document.body.classList.add('playing');
      }, delta),
      3000
    );
    step(`loop animations armed (delta=${delta.toFixed(2)}s)`);
  });

  // ── s08 收尾与片尾（29.4s，整幕用片尾页：能力回顾 → 环境技术栈 → 演示数据提示）──
  if (want('s08')) await scene('s08', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-short', 'outro.html')).href, { waitUntil: 'load' }), 15000);
    await bounded(page.locator('.stage').first().waitFor({ timeout: 5000 }), 5200);
    const delta = (Date.now() - t0) / 1000;
    await bounded(
      page.evaluate((d) => {
        document.body.style.setProperty('--delta', d + 's');
        document.body.classList.add('playing');
      }, delta),
      3000
    );
    step(`outro animations armed (delta=${delta.toFixed(2)}s)`);
  });

  log('ALL SCENES DONE');
};

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
