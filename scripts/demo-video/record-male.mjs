/**
 * 智能问数演示视频 · 分幕录制脚本 v2 · 男声版（Playwright recordVideo）
 *
 * 【自动生成】由 make-male-version.mjs 从 record.mjs 按 audio-male/ 句级时间轴映射而来。
 *   - at() 已重映射到男声时间轴；行内注释中的秒数沿用女声原值，仅作语义参考；
 *   - 产物写入 videos-male/，配音读取 audio-male/，overlay 读取 overlay-male/。
 *   - 女声版 record.mjs / audio/ / videos/ / overlay/ 不受影响。
 *
 * 背景：首轮录制中 m4/m5 出现"CDP 调用被无上限拖住"（视频被拖到 430-490s）。
 * v2 对策：
 *   1) 每幕独立启动/关闭浏览器 —— 彻底隔离幕间状态；
 *   2) 所有页面操作经 bounded() 硬性超时 —— CDP 调用不再可能无限等待；
 *   3) clickLoc 改为「坐标点击」—— 绕过 actionability 等待（遮挡/动画不再卡死）；
 *   4) 每幕输出心跳统计（页面主线程最大卡顿间隙）+ 分步计时日志。
 *
 * 用法：
 *   node scripts/demo-video/record-male.mjs                        # 全量正式录制
 *   SCENES=m2,m4,m5 node scripts/demo-video/record-male.mjs        # 只录指定幕
 *   DRY=1 SCENES=m2,m4,m5 node scripts/demo-video/record-male.mjs  # 彩排（幕末仅补到 8s）
 *   NOREC=1 SCENES=m5 node scripts/demo-video/record-male.mjs      # 不录屏，仅验证交互
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const VIDEO_DIR = join(__dirname, 'videos-male');
const DOCS_DIR = join(__dirname, '..', '..', 'docs', 'diagrams');
const STATE = join(__dirname, '.auth-state.json');
const DRY = process.env.DRY === '1';
const NOREC = process.env.NOREC === '1';
const ONLY = (process.env.SCENES || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);
mkdirSync(VIDEO_DIR, { recursive: true });

const rawDur = JSON.parse(readFileSync(join(__dirname, 'audio-male', 'durations.json'), 'utf8'));
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
  const needAuth = ['m0', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'].some(want);
  if (needAuth) {
    rmSync(STATE, { force: true });
    await prepareAuth();
  }

  // ── m00 片头：项目组名单、全片时长与倍速提示（时长与动画按 m00.vtt 对齐）──
  if (want('m00')) await scene('m00', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-male', 'intro.html')).href, { waitUntil: 'load' }), 15000);
    await bounded(page.locator('.stage').first().waitFor({ timeout: 5000 }), 5200);
    // 动画原点校准：以本幕开始为 0 点，抵消页面加载耗时后启动 CSS 动画（body.playing + --delta）
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

  // ── m0 开场总览：问数入口 → 治理四大资产闭环（67.3s，时间点按 m0.vtt 对齐）──
  if (want('m0')) await scene('m0', async (page) => {
    const t0 = Date.now();
    // 绝对时间线：动作精确落在旁白句子节点上（m0.vtt：0-4.96 欢迎 / 4.91-15.9 定位 / 15.9-27.75 理念 / 27.75-54.27 四大资产 / 54.27-67.23 闭环）
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 'm0', 2000);
    // 句1-3（0-27.7s）：主界面欢迎语 + 平台理念
    await moveMouse(page, 960, 300);
    await at(11.66);
    await moveMouse(page, 820, 690);
    // 句4（27.7-54.3s）：系统管理 → 规则治理四大核心资产，按句子节点切换
    await at(24.7); // 「打开系统管理」（clickLoc 有 ~1s 准备开销，落地≈28.3s）
    await clickLoc(page, page.getByText('用户角色与 Token 用量管理'), 280, 'nav-sys');
    await bounded(page.getByRole('button', { name: '规则治理' }).first().waitFor({ timeout: 2500 }), 2600);
    await at(28.31); // 「语义指标库统一全站口径」(31.95s)
    await clickLoc(page, page.getByRole('button', { name: '规则治理' }).first(), 260, 'tab-rules');
    await at(30.35);
    await switchPanelDs(page, 'm0-metrics');
    await at(33.42); // 「铁律规则守住数据红线」(37.47s)
    await clickLoc(page, page.getByRole('button', { name: /铁律规则/ }).first(), 260, 'tab-iron');
    await at(35.46);
    await switchPanelDs(page, 'm0-iron');
    await at(37.78); // 「业务知识库沉淀企业术语」(42.11s)
    await clickLoc(page, page.getByRole('button', { name: /业务知识库/ }).first(), 260, 'tab-kb');
    await at(43.35); // 「SQL 样例库积累高质量查询范式」(48.08s)
    await clickLoc(page, page.getByRole('button', { name: /SQL 样例库/ }).first(), 260, 'tab-sql');
    // 句5（54.3-67.2s）：治理闭环反哺问数，回主界面收尾
    await at(51.63); // 「这四大模块与问数过程构成治理闭环」（落地≈57.3s）
    await clickLoc(page, page.getByText('智能问答与查询').first(), 280, 'nav-chat');
    await at(53.41);
    await moveMouse(page, 960, 500);
  });

  // ── m01 系统架构与问数原理导览：三张 Archify 图 + 引导视图分镜（109.1s，时间点按 m01.vtt 对齐）──
  if (want('m01')) await scene('m01', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    const openDiagram = async (file) => {
      await bounded(page.goto(pathToFileURL(join(DOCS_DIR, file)).href, { waitUntil: 'load' }), 15000);
      await bounded(page.locator('.guided-view-chapters').first().waitFor({ timeout: 5000 }), 5200);
    };
    const viewBtn = (text) => page.locator('.guided-view-chapters button').filter({ hasText: text }).first();

    // 句1（0-4.8s）：完整架构图全景
    await openDiagram('完整系统架构图.html');
    // 句2（4.7-22.5s）：引导视图·一次问数请求
    await at(4.51);
    await clickLoc(page, viewBtn('一次问数请求'), 240, 'arch-view1');
    // 句3（22.5-34.9s）：引导视图·模型与知识
    await at(20.66);
    await clickLoc(page, viewBtn('模型与知识'), 240, 'arch-view2');
    // 句4（34.9-45.2s）：引导视图·状态与运维
    await at(32.3);
    await clickLoc(page, viewBtn('状态与运维'), 240, 'arch-view3');
    // 句5（45.2-59.6s）：系统功能流程图 · 一条功能主链
    await at(41.87);
    await openDiagram('系统功能流程图.html');
    await at(43.08);
    await clickLoc(page, viewBtn('一条功能主链'), 240, 'flow-view1');
    // 句6（59.6-67.1s）：引导视图·防护与运维
    await at(55.19);
    await clickLoc(page, viewBtn('防护与运维'), 240, 'flow-view2');
    // 句7（67.1-76.7s）：引导视图·质量闭环
    await at(62.38);
    await clickLoc(page, viewBtn('质量闭环'), 240, 'flow-view3');
    // 句8（76.7-86.1s）：智能问数推导过程图 · 入口与防护（「先过净化、鉴权、ACL 与限流配额」≈81.1s 起）
    await at(71.41);
    await openDiagram('智能问数推导过程图.html');
    await at(75.31);
    await clickLoc(page, viewBtn('入口与防护'), 240, 'deriv-view1');
    // 句9（86.1-94.6s）：引导视图·上下文与候选
    await at(79.8);
    await clickLoc(page, viewBtn('上下文与候选'), 240, 'deriv-view2');
    // 句10（94.6-108.9s）：引导视图·契约与执行
    await at(87.77);
    await clickLoc(page, viewBtn('契约与执行'), 240, 'deriv-view3');
  });

  // ── m1 登录与主界面（18.8s，时间点按 m1.vtt 对齐：登录动作对齐句2「现在，输入管理员账号密码」14.09s）──
  if (want('m1')) await scene('m1', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByPlaceholder('请输入用户名').waitFor({ timeout: 20000 });
    // 句1（0.1-14.1s）：登录页展示（光标微移点缀）
    await at(5.78);
    await moveMouse(page, 960, 480);
    await at(9.78);
    await moveMouse(page, 960, 560);
    // 句2（14.09-18.7s）：输入账号密码并登录
    const user = page.getByPlaceholder('请输入用户名');
    await at(12.09);
    await clickLoc(page, user, 300, 'user');
    await user.pressSequentially('admin', { delay: 90 }).catch(() => {});
    const pwd = page.getByPlaceholder('请输入密码');
    await at(12.91);
    await clickLoc(page, pwd, 300, 'pwd');
    await pwd.pressSequentially('admin123', { delay: 85 }).catch(() => {});
    await at(14.29);
    await clickLoc(page, page.getByRole('button', { name: /登\s*录/ }), 300, 'login');
    await bounded(page.getByText('当前数据源:').waitFor({ timeout: 6000 }), 6500);
    await moveMouse(page, 960, 420);
  });

  // ── m2 智能问数：核心链路（152.8s，时间点按 m2.vtt 对齐）──
  if (want('m2')) await scene('m2', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    // 句1-2（0.1-21.9s）：主界面 + 数据源选择器（八套数据源、实时连接状态）
    await at(6.75);
    await moveMouse(page, 1260, 33);
    await at(12.7);
    await moveMouse(page, 1420, 33);
    // 句3（21.9-42.1s）：切换为「数据资源」+ Schema 面板（两张业务宽表）
    await at(20.38);
    await switchToDataResource(page, 'm2', 3000);
    await at(25.18);
    await moveMouse(page, 150, 620);
    await at(30.42);
    await moveMouse(page, 150, 720);
    await at(35.4);
    await moveMouse(page, 700, 900);
    // 句4（42.1-50.8s）：输入业务问题（点击落地≈42.9s，打字≈43.1-46.0s）
    const input = page.getByPlaceholder(/用自然语言提问/);
    await at(38.03);
    await clickLoc(page, input, 350, 'input');
    await input.pressSequentially('分析各业务一级类别的累计投放金额与当年已回现情况', { delay: 120 }).catch(() => {});
    // 句5（50.8-53.8s）：回车之后（Enter 落地≈50.9s）
    await at(46.06);
    const submitAt = Date.now();
    await bounded(input.press('Enter'), 3000);
    step('query submitted, waiting stream...');
    await bounded(page.locator('.recharts-wrapper').first().waitFor({ timeout: 150000 }), 152000);
    step(`recharts appeared (query ${((Date.now() - submitAt) / 1000).toFixed(1)}s)`);
    // 结果对齐句8「结果出来了」（76.9s）：冷缓存天然对齐；热缓存补足 26s 兜底
    const sinceSubmit = Date.now() - submitAt;
    if (sinceSubmit < 26000) await page.waitForTimeout(26000 - sinceSubmit);
    // 句9（78.5-102.4s）：核心指标卡 → AI 归因（分段浏览）
    await at(71.63);
    await scrollAt(page, 960, 500, -1500);
    await at(81.51);
    await scrollAt(page, 960, 500, 650);
    // 句10（102.4-115.4s）：可视化图表——滚到图表区 + 形态切换
    await at(93.59);
    await scrollAt(page, 960, 500, 700);
    const forms = ['折线图', '面积图', '柱状图'];
    for (let i = 0; i < forms.length; i++) {
      const loc = page.getByRole('button', { name: forms[i], exact: true });
      await ensureInView(page, loc);
      await at(106.0 + i * 3.6); // 落地≈107.0/110.6/114.2s
      await clickLoc(page, loc, 260, `form-${forms[i]}`);
    }
    // 句11（115.4-123.2s）：明细数据表 + 推荐追问
    await at(107.44);
    await scrollAt(page, 960, 500, 650);
    // 句12（123.2-130.9s）：全屏聚焦 + 全屏内形态切换
    const fsBtn = page.getByRole('button', { name: '全屏' });
    await ensureInView(page, fsBtn);
    await at(112.95); // 落地≈124.4s
    await clickLoc(page, fsBtn, 300, 'fullscreen');
    const fsArea = page.getByRole('button', { name: '面积图', exact: true }).last();
    await ensureInView(page, fsArea);
    await at(117.45); // 落地≈129.2s
    await clickLoc(page, fsArea, 260, 'fs-area');
    const fsLine = page.getByRole('button', { name: '折线图', exact: true }).last();
    await ensureInView(page, fsLine);
    await at(119.52); // 落地≈131.4s
    await clickLoc(page, fsLine, 260, 'fs-line');
    // 退出全屏（失败则 Escape 兜底 + 复核确认已退出）
    await at(121.77); // 落地≈133.8s
    await clickLoc(page, page.getByRole('button', { name: '退出全屏' }), 300, 'exit-fs');
    let fsStill = await bounded(page.getByRole('button', { name: '退出全屏' }).count(), 2500);
    if (fsStill) {
      await bounded(page.keyboard.press('Escape'), 1500);
      await page.waitForTimeout(900);
      fsStill = await bounded(page.getByRole('button', { name: '退出全屏' }).count(), 2500);
    }
    step(`fullscreen exited=${!fsStill}`);
    // 句13（130.9-147.1s）：导出按钮组展示（hover 不点击，避免真实下载）
    const pdfBtn = page.locator('button[title*="导出为 PDF"]').first();
    await ensureInView(page, pdfBtn);
    const bbPdf = await bounded(pdfBtn.boundingBox(), 2500);
    await at(124.95);
    if (bbPdf) await moveMouse(page, bbPdf.x + bbPdf.width / 2, bbPdf.y + bbPdf.height / 2);
    const mdBtn = page.locator('button[title*="导出为 MD"]').first();
    await ensureInView(page, mdBtn);
    const bbMd = await bounded(mdBtn.boundingBox(), 2500);
    await at(129.45);
    if (bbMd) await moveMouse(page, bbMd.x + bbMd.width / 2, bbMd.y + bbMd.height / 2);
    // 句14（147.1-152.7s）：收尾——回到结果区域停留
    await at(133.19);
    await scrollAt(page, 960, 500, -420);
    await at(137.02);
    await moveMouse(page, 720, 640);
  });

  // ── m3 可视化决策报表（85.4s，时间点按 m3.vtt 对齐）──
  if (want('m3')) await scene('m3', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 'm3', 2200);
    // 句1（0.1-3.0s）：进入「可视化决策报表」
    await at(3.13); // 落地≈4.4s
    await clickLoc(page, page.getByText('一键自动生成高管分析简报'), 280, 'nav-report');
    // 句2-3（3.0-25.4s）：四套模板卡片悬停巡礼（经营分析/资产质量/投资收益/战略决策）
    await at(6.76); await moveMouse(page, 508, 340);
    await at(9.42); await moveMouse(page, 895, 340);
    await at(13.48); await moveMouse(page, 1281, 340);
    await at(16.72); await moveMouse(page, 1668, 340);
    // 句4（25.4-30.5s）：打开历史报表「2026年企业战略决策简…」
    await at(23.47); // 落地≈26.8s
    await clickLoc(page, page.getByText(/2026年企业战略决策简/).first(), 280, 'open-report');
    // 句5（30.5-51.7s）：简报浏览（顶部口径 → 高管摘要 → 异常扫描）
    await at(28.06); await scrollAt(page, 960, 600, 520);
    await at(35.03); await scrollAt(page, 960, 600, 380);
    await at(43.97); await scrollAt(page, 960, 600, -900);
    // 句6（51.7-70.9s）：配色一键切换（商务暖金 → 翡翠生态 → 极客深蓝）
    await at(53.06); // 落地≈58.5s
    await clickLoc(page, page.getByRole('button', { name: '商务暖金' }).first(), 260, 'palette-warm');
    await at(57.01); // 落地≈62.8s
    await clickLoc(page, page.getByRole('button', { name: '翡翠生态' }).first(), 260, 'palette-green');
    await at(59.58); // 落地≈65.6s
    await clickLoc(page, page.getByRole('button', { name: '极客深蓝' }).first(), 260, 'palette-blue');
    // 句7（70.9-80.8s）：导出按钮组悬停（PDF → PPT）
    const pdfBtn = page.getByRole('button', { name: /导出高清 PDF 文档/ }).first();
    const bb = await bounded(pdfBtn.boundingBox(), 2500);
    await at(67.76); // 落地≈74.1s
    if (bb) await moveMouse(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
    const pptBtn = page.getByRole('button', { name: /下载 PPT 简报/ }).first();
    const bb2 = await bounded(pptBtn.boundingBox(), 2500);
    await at(71.31); // 落地≈78.1s
    if (bb2) await moveMouse(page, bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
    // 句8（80.8-85.3s）：收尾
    await at(75.32);
    await moveMouse(page, 960, 540);
  });

  // ── m4 决策数据看板（42.2s，时间点按 m4.vtt 对齐）──
  if (want('m4')) await scene('m4', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 'm4', 2200);
    await at(2.41); // 落地≈3.6s（句1：决策数据看板）
    await clickLoc(page, page.getByText('固化指标图表与看板展示'), 280, 'nav-dashboard');
    // 句2（4.1-15.7s）：预设版式 hover（等分三列 / 双列网格 / 主图聚焦）
    await at(9.71); await hoverText(page, '等分三列', 900);
    await at(11.56); await hoverText(page, '双列网格', 900);
    await at(13.22); await hoverText(page, '主图聚焦', 900);
    // 句3（15.7-23.5s）：滚到图表区 → 卡片悬停 → 缩放 → 同环比
    await at(14.97); await scrollAt(page, 960, 550, 650);
    await at(16.34); await moveMouse(page, 325, 551);  // 卡片1：拖拽柄
    await at(17.81); await moveMouse(page, 1215, 551); // 卡片2：工具条
    const zoom2 = page.getByRole('button', { name: '2x', exact: true }).first();
    await ensureInView(page, zoom2);
    await at(18.91); // 落地≈21.5s（「一到三倍缩放」段）
    await clickLoc(page, zoom2, 260, 'zoom-2x');
    const zoom1 = page.getByRole('button', { name: '1x', exact: true }).first();
    await ensureInView(page, zoom1);
    await at(21.65); // 落地≈24.5s
    await clickLoc(page, zoom1, 260, 'zoom-1x');
    // 同比/环比视角（hover 展示对比切换）
    await at(23.03); await hoverText(page, '同比 YoY', 1200); // 落地≈26.0s
    await at(24.88); await hoverText(page, '环比 MoM', 1200); // 落地≈28.0s
    // 句4-5（23.5-42.1s）：回到顶部——监测状态行 + 语义指标直查
    await at(27.64); await scrollAt(page, 960, 450, -700);
    await at(29.48); await moveMouse(page, 560, 197);
    await at(32.22); await moveMouse(page, 500, 461);
    await at(34.5); await moveMouse(page, 1180, 461);
  });

  // ── m5 灵活查询（76.6s，时间点按 m5.vtt 对齐）──
  if (want('m5')) await scene('m5', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    // 句1（0.1-4.3s）：进入「灵活查询」
    await at(2.05); // 落地≈3.3s
    await clickLoc(page, page.getByText('拖拉拽可视化定制固定报表'), 280, 'nav-flex');
    // 句2（4.2-14.5s）：切换数据源 → 选择财务宽表
    await at(4.07);
    await bounded(
      page.getByTestId('datasource-select').selectOption({ label: '数据资源 (MYSQL)' }, { timeout: 8000 }),
      10000
    );
    step('ds switched to mysql');
    await at(10.43);
    const tblSel = page.locator('select[data-testid="flexquery-table-select"]').first();
    const tcnt = await bounded(tblSel.count(), 2500);
    step(`table-select count=${tcnt}`);
    if (tcnt) {
      await bounded(tblSel.selectOption({ index: 1 }, { timeout: 6000 }), 8000);
      step('table selected');
    }
    // 句3（14.5-19.4s）：字段面板浏览（维度列 / 指标列）
    await at(14.17);
    await moveMouse(page, 420, 800);
    await at(15.52);
    await moveMouse(page, 1500, 800);
    // 句4（19.4-28.8s）：点「数据日期」→ 分组维度；点「期末-成本余额」→ 聚合指标
    await at(18.38); // 落地≈21.3s（「我们先点击数据日期」）
    if (!(await clickFieldRow(page, '数据日期', 'left'))) {
      await clickLoc(page, page.getByText('数据日期', { exact: false }).first(), 260, 'dim-fallback');
    }
    await at(22.35); // 落地≈25.5s（「再点击期末-成本余额」）
    if (!(await clickFieldRow(page, '期末-成本余额', 'right'))) {
      await clickLoc(page, page.getByText('期末-成本余额', { exact: false }).first(), 260, 'met-fallback');
    }
    // 校验：查询配置区 chips（分组维度 / 聚合指标 均已填充）
    const cfg = await bounded(
      page.evaluate(() => {
        const zones = [...document.querySelectorAll('div')].filter((e) => {
          const t = e.innerText || '';
          return t.includes('分组维度') && t.includes('聚合指标') && t.length < 1600;
        });
        return zones.length ? zones[zones.length - 1].innerText.replace(/\n+/g, ' | ').slice(0, 320) : 'n/a';
      }),
      3000
    );
    step(`config zones: ${cfg}`);
    // 句5（28.8-34.1s）：滚动到查询配置区（chips + 实时预览 SQL）
    await at(28.03);
    await scrollAt(page, 960, 600, 620);
    // 句6（34.1-46.0s）：滚动到 SQL 预览 → 高级配置区巡游（WHERE/HAVING、行数上限、时间衍生列）
    await at(34.3);
    await scrollAt(page, 960, 600, 560);
    await at(40.35);
    await moveMouse(page, 960, 720);
    await at(42.87);
    await moveMouse(page, 1460, 620);
    // 句7-8（46.0-62.1s）：勾选「后台执行（大查询）」→ 点击「执行查询（真实数据库）」
    const bgLabel = page.getByText('后台执行（大查询）').first();
    await ensureInView(page, bgLabel);
    await at(46.17); // 落地≈51.2s
    await clickLoc(page, bgLabel, 350, 'bg-mode');
    let bgChecked = await bounded(isBgChecked(page), 2500);
    if (!bgChecked) {
      await clickLoc(page, bgLabel, 350, 'bg-mode-retry');
      bgChecked = await bounded(isBgChecked(page), 2500);
    }
    step(`backgroundMode checked=${bgChecked}`);
    const runBtn = page.getByText('执行查询（真实数据库）').first();
    await ensureInView(page, runBtn);
    await at(48.37); // 落地≈53.6s
    await clickLoc(page, runBtn, 300, 'run-query');
    step('query submitted');
    // 等待异步任务结果（轮询进度文案 + 结果图表出现，硬性上限 100s）
    const tSubmit = Date.now();
    let rechartsN = 0;
    let lastProg = '';
    while (Date.now() - tSubmit < 100000) {
      rechartsN = (await bounded(page.locator('.recharts-wrapper').count(), 2500)) || 0;
      if (rechartsN > 0) break;
      const prog = (await bounded(
        page.evaluate(() => {
          const els = [...document.querySelectorAll('p')].filter((e) => /后台任务|排队中|执行中/.test(e.innerText || ''));
          return els.length ? els[0].innerText.trim() : '';
        }),
        2500
      )) || '';
      if (prog && prog !== lastProg) {
        step(`async-progress[${((Date.now() - tSubmit) / 1000).toFixed(0)}s]: ${prog}`);
        lastProg = prog;
      }
      await page.waitForTimeout(2000);
    }
    step(`result recharts count=${rechartsN} wait=${((Date.now() - tSubmit) / 1000).toFixed(1)}s`);
    // 结果对齐句9「稍等片刻，图表与明细就返回了」（62.1-65.8s）：早到则补足至 62.5s 左右
    const sinceRun = Date.now() - tSubmit;
    if (sinceRun < 8000) await page.waitForTimeout(8000 - sinceRun);
    // 查看查询结果（图表 → 明细）
    await at(58.71);
    await scrollAt(page, 960, 600, 550);
    // 句10（65.8-72.1s）：固化至看板 / 保存为固定报表（悬停展示，不点击避免写入）
    await at(61.91); // 落地≈68.5s
    await hoverText(page, '固化至看板（自动更新）', 2000);
    await at(64.9);
    await scrollAt(page, 960, 600, 500);
    await at(67.71); // 落地≈74.8s
    await hoverText(page, '保存为固定报表', 1500);
    await at(70.02);
    await moveMouse(page, 960, 700);
  });

  // ── m6 问数报告中心（21.3s）──
  if (want('m6')) await scene('m6', async (page) => {
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 'm6', 2200);
    await clickLoc(page, page.getByText('智能问数报告模式生成的报告'), 280, 'nav-center');
    await page.waitForTimeout(4000);
    await page.waitForTimeout(6000);
    await moveMouse(page, 960, 400);
    await page.waitForTimeout(4000);
  });

  // ── m7 数据源与 Schema（68.7s，时间点按 m7.vtt 对齐）──
  if (want('m7')) await scene('m7', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 'm7', 2200);
    // 句1（0.1-4.8s）：进入「数据源与 Schema」
    await at(3.18); // 落地≈4.6s
    await clickLoc(page, page.getByText('接入 MySQL/PostgreSQL/CSV/API'), 280, 'nav-ds');
    // 句2（4.7-27.6s）：八套数据源卡片悬停巡礼
    await at(6.73); await moveMouse(page, 450, 385);
    await at(10.88); await moveMouse(page, 450, 492);
    await at(15.04); await moveMouse(page, 450, 600);
    await at(18.73); await moveMouse(page, 450, 707);
    // 句3（27.6-40.2s）：选中「数据资源」卡片 → Schema 探测结果
    await at(25.29); // 卡片点击落地≈28.7s
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
      await page.waitForTimeout(300);
      await bounded(page.mouse.click(dsCardRect.x + dsCardRect.w / 2, dsCardRect.y + dsCardRect.h / 2), 3000);
      step(`select-data-resource clicked @${Math.round(dsCardRect.x)},${Math.round(dsCardRect.y)}`);
    } else {
      step('select-data-resource rect=null');
    }
    await at(27.09); // Schema 探测 tab 落地≈30.6s
    await clickLoc(page, page.getByRole('button', { name: /数据表 Schema 探测/ }), 280, 'schema-tab');
    // 左侧导航「数据源表结构」两张业务宽表悬停
    await at(28.8); await moveMouse(page, 120, 662);  // 财务宽表（1,039,404 行）
    await at(30.61); await moveMouse(page, 120, 693);  // 主营业务-业务粒度宽表（120,119 行）
    // 句4（40.2-50.0s）：滚动到字段区 → 悬停字段行（识别分组维度与数值指标）
    await at(33.31); await scrollAt(page, 1300, 700, 380);
    await at(39.75); await moveMouse(page, 1400, 265);
    await at(42.11); await moveMouse(page, 1400, 420);
    await at(43.53); await moveMouse(page, 1400, 575);
    // 句5（50.0-68.6s）：全链路数据血缘视图（先滚回顶部再切换 tab）
    await at(45.88); await scrollAt(page, 1300, 700, -380);
    await at(46.81); // 落地≈52.0s
    await clickLoc(page, page.getByRole('button', { name: /全链路数据血缘视图/ }), 280, 'lineage');
    // 血缘图谱节点悬停（高亮上下游链路）
    await at(49.6); await moveMouse(page, 930, 640);
    await at(51.93); await moveMouse(page, 1120, 660);
    await at(54.25); await moveMouse(page, 780, 600);
    await at(57.04); await moveMouse(page, 960, 560);
  });

  // ── m8 系统管理（64.4s，时间点按 m8.vtt 对齐）──
  if (want('m8')) await scene('m8', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    await switchToDataResource(page, 'm8', 2200);
    // 句1（0.1-2.3s）：进入「系统管理」
    await at(3.19); // 落地≈4.5s
    await clickLoc(page, page.getByText('用户角色与 Token 用量管理'), 280, 'nav-sys');
    // 句2（2.2-19.1s）：账号维护（账号行 → 部门列 → 创建账号 → 操作列）
    await at(6.82); await moveMouse(page, 561, 306);   // admin 账号行
    await at(10); await moveMouse(page, 773, 314);  // 部门 / 组织归属列
    await at(12.73); await moveMouse(page, 1780, 190); // 创建账号按钮
    await at(15); await moveMouse(page, 1660, 316); // 操作列（编辑 / 禁用 / 重置）
    // 句3（19.1-33.0s）：RBAC 三角色徽章悬停（管理员 / 分析师 / 只读用户）
    await at(19.08); await moveMouse(page, 977, 314);
    await at(22.69); await moveMouse(page, 977, 383);
    await at(25.86); await moveMouse(page, 977, 452);
    // 句4（33.0-47.2s）：模块巡礼（规则治理 → AI 审核 → 系统体检 → 质量监控 → 异常巡检）
    await at(31.98); // 落地≈36.2s
    await clickLoc(page, page.getByRole('button', { name: '规则治理' }).first(), 260, 'tab-rules');
    await at(33.94);
    await switchPanelDs(page, 'm8-metrics'); // 语义指标库下拉切到「数据资源」
    await at(35.33); // 落地≈39.8s
    await clickLoc(page, page.getByRole('button', { name: 'AI 审核' }).first(), 260, 'tab-audit');
    await at(37.57); // 落地≈42.2s
    await clickLoc(page, page.getByRole('button', { name: '系统体检' }).first(), 260, 'tab-check');
    await at(39.81); // 落地≈44.6s
    await clickLoc(page, page.getByRole('button', { name: '质量监控' }).first(), 260, 'tab-quality');
    await at(42.05); // 落地≈47.0s
    await clickLoc(page, page.getByRole('button', { name: '异常巡检' }).first(), 260, 'tab-inspect');
    // 句5（47.2-64.3s）：需求反馈闭环
    await at(44.63); // 落地≈49.8s
    await clickLoc(page, page.locator('button:has-text("需求反馈")').last(), 260, 'tab-feedback');
    // 若误开提交弹窗则关闭
    const modal = page.getByText('提交需求');
    if (await bounded(modal.isVisible(), 2000)) await bounded(page.keyboard.press('Escape'), 1500);
    // 浏览闭环（已纳入基线统计 → 条目列表 → 状态列）
    await at(49.4); await moveMouse(page, 1020, 270);
    await at(52.61); await moveMouse(page, 800, 418);
    await at(55.82); await moveMouse(page, 1250, 420);
  });

  // ── m8b 双闭环：自我修复 · 自我完善（62.7s，画面动画按 m8b.vtt 校准）──
  if (want('m8b')) await scene('m8b', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-male', 'loop.html')).href, { waitUntil: 'load' }), 15000);
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

  // ── m8c 统一记忆体：八通道召回 · 纠错闭环 · 安全灰度（时长按 m8c.vtt）──
  if (want('m8c')) await scene('m8c', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-male', 'memory.html')).href, { waitUntil: 'load' }), 15000);
    await bounded(page.locator('.stage').first().waitFor({ timeout: 5000 }), 5200);
    const delta = (Date.now() - t0) / 1000;
    await bounded(
      page.evaluate((d) => {
        document.body.style.setProperty('--delta', d + 's');
        document.body.classList.add('playing');
      }, delta),
      3000
    );
    step(`memory animations armed (delta=${delta.toFixed(2)}s)`);
  });

  // ── m9 收尾（17.6s，时间点按 m9.vtt 对齐）──
  if (want('m9')) await scene('m9', async (page) => {
    const t0 = Date.now();
    const at = async (s) => { const d = t0 + s * 1000 - Date.now(); if (d > 0) await page.waitForTimeout(d); };
    await bounded(page.goto(BASE), 20000);
    await page.getByText('当前数据源:').waitFor({ timeout: 30000 });
    // 收尾镜头停留在切换为「数据资源」后的主界面（欢迎语按真实表结构刷新）
    await switchToDataResource(page, 'm9', 2500);
    await at(6.16);
    await moveMouse(page, 960, 700);
    await at(12.73);
    await moveMouse(page, 700, 500);
  });

  // ── m10 片尾：核心优势、演示环境与技术栈（87.1s，画面动画按 m10.vtt 对齐）──
  if (want('m10')) await scene('m10', async (page) => {
    const t0 = Date.now();
    await bounded(page.goto(pathToFileURL(join(__dirname, 'overlay-male', 'outro.html')).href, { waitUntil: 'load' }), 15000);
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
