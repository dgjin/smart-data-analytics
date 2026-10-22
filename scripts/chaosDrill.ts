/**
 * P2-2 混沌工程演练：依赖断连（Redis / MySQL）的降级行为与可观测性验证。
 *
 * 设计要点：
 * - 默认 plan 模式（安全）：只做 preflight + 基线采样，打印注入/恢复命令建议，不触碰任何依赖；
 * - --execute 才真正执行 --inject-cmd / --recover-cmd，执行前需 --yes（非 TTY 时未给 --yes 直接拒绝）；
 * - --assume-injected 用于「人工已停库」的演练：脚本从观察阶段开始，只负责采样、判定与恢复；
 * - 判定矩阵（与单测口径一致）：故障期间 live 恒 200（进程不因依赖故障退出）、ready 503 且被注入
 *   依赖 ok=false、对侧依赖仍 ok、恢复后 ready 200、process_start_time_seconds 全程不变；
 * - 报告落盘 logs/chaos-reports/（logs/ 已 gitignore，运行产物不入库），JSON 供机器读、Markdown 供人看。
 *
 * 用法：
 *   npm run chaos:drill                                      # plan：基线采样 + 打印建议命令
 *   npm run chaos:drill -- --scenario=redis --execute --yes \
 *     --inject-cmd="docker compose -f docker-compose.multi-instance.yml stop redis" \
 *     --recover-cmd="docker compose -f docker-compose.multi-instance.yml start redis"
 *   npm run chaos:drill -- --scenario=mysql --assume-injected --yes \
 *     --recover-cmd="brew services start mysql"
 *
 * 退出码：0 断言全通过（或 plan 模式正常完成）/ 1 存在断言失败 / 2 环境不可达或参数非法
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

type Scenario = 'redis' | 'mysql' | 'both';
type Phase = 'baseline' | 'observe' | 'cooldown';
type DrillMode = 'plan' | 'execute' | 'assume-injected';

interface ReadyCheck {
  ok: boolean;
  ms: number;
  error?: string;
}

interface Probe {
  status: number | null;
  ms: number;
  error?: string;
  checks?: Record<string, ReadyCheck>;
}

interface Sample {
  at: number;
  phase: Phase;
  live: Probe;
  ready: Probe;
  metrics?: Record<string, number>;
  metricsError?: string;
}

interface Assertion {
  id: string;
  expectation: string;
  ok: boolean;
  detail: string;
}

interface CmdResult {
  cmd: string;
  code: number;
  output: string;
  ms: number;
}

interface Recovery {
  recovered: boolean;
  ms: number;
  attempts: number;
}

interface DrillReport {
  version: 1;
  scenario: Scenario;
  mode: DrillMode;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  config: Record<string, number | string | boolean>;
  commands: { inject?: string; recover?: string; injectResult?: CmdResult; recoverResult?: CmdResult };
  recovery: Recovery | null;
  samples: Sample[];
  assertions: Assertion[];
  warnings: string[];
}

// ---------- CLI 参数 ----------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const arg = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const num = (name: string, dft: number, min: number, max: number): number => {
  const n = Number(arg(name));
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

const RAW_SCENARIO = (arg('scenario') || 'both').toLowerCase();
if (RAW_SCENARIO !== 'redis' && RAW_SCENARIO !== 'mysql' && RAW_SCENARIO !== 'both') {
  console.error(`✗ 非法 --scenario=${RAW_SCENARIO}（可选 redis | mysql | both）`);
  process.exit(2);
}
const scenario: Scenario = RAW_SCENARIO;

const mode: DrillMode = flag('assume-injected') ? 'assume-injected' : flag('execute') ? 'execute' : 'plan';
if (flag('assume-injected') && flag('execute')) {
  console.error('✗ --assume-injected 与 --execute 互斥：前者假设故障已在外部注入，后者由脚本执行注入命令');
  process.exit(2);
}

const baseUrl = (arg('base-url') || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, '');
const metricsToken = arg('metrics-token') || process.env.METRICS_TOKEN || '';
const baselineMs = num('baseline-ms', 6000, 0, 10 * 60_000);
const observeMs = num('observe-ms', 12000, 3000, 30 * 60_000);
const cooldownMs = num('cooldown-ms', 4000, 0, 10 * 60_000);
const settleMs = num('settle-ms', 5000, 0, 5 * 60_000);
const intervalMs = num('interval-ms', 2000, 200, 60_000);
const recoverTimeoutMs = num('recover-timeout-ms', 60000, 1000, 30 * 60_000);
const injectCmd = arg('inject-cmd');
const recoverCmd = arg('recover-cmd');
const outDir = path.resolve(ROOT, arg('out-dir') || 'logs/chaos-reports');
const assumeYes = flag('yes');
const allowRemote = flag('allow-remote');

// ---------- 安全护栏 ----------

/** 默认仅允许本机/私网目标，防止误把演练打到生产公网 */
function assertTargetSafe(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`✗ 非法 --base-url=${url}`);
    process.exit(2);
  }
  const privateHost =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!privateHost && !allowRemote) {
    console.error(`✗ 目标 ${host} 非本机/私网地址；确需演练请显式追加 --allow-remote`);
    process.exit(2);
  }
}

/** 注入命令黑名单：演练只允许"停/启依赖"，禁止任何数据破坏或系统级操作 */
const DANGEROUS_CMD = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkillall\b/i,
  /\bpkill\s+-9\b/i,
  /:\(\)\s*\{/,
];

function guardCommand(cmd: string, label: string): void {
  const hit = DANGEROUS_CMD.find((re) => re.test(cmd));
  if (hit) {
    console.error(`✗ ${label}命中危险命令黑名单（${hit}），演练脚本拒绝执行：${cmd}`);
    process.exit(2);
  }
}

async function askConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

// ---------- 探测与采样 ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

function parseReadyBody(body: string): { ok: boolean; checks: Record<string, ReadyCheck> } | null {
  try {
    const json = JSON.parse(body) as { ok?: unknown; checks?: unknown };
    if (typeof json.ok !== 'boolean' || typeof json.checks !== 'object' || json.checks === null) return null;
    const checks: Record<string, ReadyCheck> = {};
    for (const [name, raw] of Object.entries(json.checks as Record<string, unknown>)) {
      const c = raw as { ok?: unknown; ms?: unknown; error?: unknown };
      checks[name] = {
        ok: c.ok === true,
        ms: typeof c.ms === 'number' ? c.ms : 0,
        ...(typeof c.error === 'string' ? { error: c.error } : {}),
      };
    }
    return { ok: json.ok, checks };
  } catch {
    return null;
  }
}

async function probe(pathname: string, timeoutMs = 5000): Promise<Probe> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${pathname}`, { signal: ctrl.signal });
    const body = await res.text();
    const out: Probe = { status: res.status, ms: Date.now() - t0 };
    if (pathname === '/api/health/ready') {
      const parsed = parseReadyBody(body);
      if (parsed) out.checks = parsed.checks;
    }
    return out;
  } catch (err) {
    return { status: null, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 Prometheus 文本中汇总同名指标（含多 label 组合）；找不到返回 undefined */
function metricValue(text: string, name: string): number | undefined {
  let total = 0;
  let found = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const next = line.charAt(name.length);
    if (next !== '{' && next !== ' ') continue;
    const last = line.trim().split(/\s+/).pop();
    const v = Number(last);
    if (Number.isFinite(v)) {
      total += v;
      found = true;
    }
  }
  return found ? total : undefined;
}

const METRIC_KEYS = [
  'process_start_time_seconds',
  'process_resident_memory_bytes',
  'http_request_duration_seconds_count',
  'nl2sql_requests_total',
  'nl2sql_cache_hits_total',
];

async function fetchMetrics(): Promise<{ metrics?: Record<string, number>; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${baseUrl}/metrics`, {
      signal: ctrl.signal,
      headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : {},
    });
    if (res.status !== 200) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    const metrics: Record<string, number> = {};
    for (const key of METRIC_KEYS) {
      const v = metricValue(text, key);
      if (typeof v === 'number') metrics[key] = v;
    }
    return { metrics };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
const samples: Sample[] = [];

async function sampleOnce(phase: Phase): Promise<Sample> {
  const [live, ready, m] = await Promise.all([probe('/api/health/live'), probe('/api/health/ready'), fetchMetrics()]);
  const sample: Sample = { at: elapsed(), phase, live, ready };
  if (m.metrics) sample.metrics = m.metrics;
  if (m.error) sample.metricsError = m.error;
  return sample;
}

async function collect(phase: Phase, durationMs: number): Promise<void> {
  const until = Date.now() + durationMs;
  for (;;) {
    samples.push(await sampleOnce(phase));
    const remain = until - Date.now();
    if (remain <= 0) break;
    await sleep(Math.min(intervalMs, remain));
  }
}

async function waitReady(timeoutMs: number, pollMs = 2000): Promise<Recovery> {
  const t0 = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const r = await probe('/api/health/ready');
    if (r.status === 200) return { recovered: true, ms: Date.now() - t0, attempts };
    const remain = timeoutMs - (Date.now() - t0);
    if (remain <= 0) return { recovered: false, ms: Date.now() - t0, attempts };
    await sleep(Math.min(pollMs, remain));
  }
}

// ---------- 命令执行 ----------

function runShell(cmd: string, timeoutMs: number): Promise<CmdResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    // 守护型命令（mysql.server start 的 mysqld_safe）会 fork 子进程继承 stdio 管道，
    // 'close' 可能永远不触发；改监听 'exit'，并留 300ms 让残留输出写完
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      setTimeout(() => resolve({ cmd, code, output: output.trim(), ms: Date.now() - t0 }), 300);
    };
    const onData = (b: Buffer) => {
      output += b.toString();
      if (output.length > 4000) output = output.slice(-4000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(-1);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      output += String(err);
      finish(-1);
    });
  });
}

// ---------- 断言 ----------

const depNames = (): string[] => (scenario === 'both' ? ['redis', 'mysql'] : [scenario]);

function describeProbe(p: Probe): string {
  if (p.status === null) return `不可达（${p.error || 'unknown'}，${p.ms}ms）`;
  const checks = p.checks
    ? Object.entries(p.checks)
        .map(([k, v]) => `${k}=${v.ok ? 'ok' : `fail${v.error ? `:${v.error.slice(0, 60)}` : ''}`}`)
        .join(', ')
    : '';
  return `HTTP ${p.status}（${p.ms}ms${checks ? `；${checks}` : ''}）`;
}

function buildAssertions(recovery: Recovery | null): Assertion[] {
  const list: Assertion[] = [];
  const of = (phase: Phase) => samples.filter((s) => s.phase === phase);

  const baseline = of('baseline');
  if (baseline.length) {
    const bad = baseline.find((s) => s.live.status !== 200 || s.ready.status !== 200);
    list.push({
      id: 'baseline-healthy',
      expectation: '基线：live 与 ready 均 200',
      ok: !bad,
      detail: bad ? `异常采样：${describeProbe(bad.ready)}` : `${baseline.length} 次采样全部 200`,
    });
  }

  const observe = of('observe');
  if (observe.length) {
    const liveBad = observe.find((s) => s.live.status !== 200);
    list.push({
      id: 'live-always-200',
      expectation: '故障期间 live 恒 200（进程不因依赖故障退出/重启）',
      ok: !liveBad,
      detail: liveBad ? `第 ${liveBad.at}ms 采样：${describeProbe(liveBad.live)}` : `${observe.length} 次采样全部 200`,
    });

    const readyBad = observe.find((s) => s.ready.status !== 503);
    list.push({
      id: 'ready-503',
      expectation: '故障期间 ready 恒 503（上游可摘流量）',
      ok: !readyBad,
      detail: readyBad ? `第 ${readyBad.at}ms 采样：${describeProbe(readyBad.ready)}` : `${observe.length} 次采样全部 503`,
    });

    const deps = depNames();
    const depBad = observe.find((s) => deps.some((d) => s.ready.checks?.[d]?.ok !== false));
    list.push({
      id: 'injected-dependency-failed',
      expectation: `故障期间 ${deps.join('+')} 探测结果为 ok=false`,
      ok: !depBad,
      detail: depBad ? `第 ${depBad.at}ms 采样：${describeProbe(depBad.ready)}` : `${observe.length} 次采样均命中失败项`,
    });

    if (scenario !== 'both') {
      const peer = scenario === 'redis' ? 'mysql' : 'redis';
      const withPeer = observe.filter((s) => s.ready.checks?.[peer] !== undefined);
      if (withPeer.length) {
        const peerBad = withPeer.find((s) => s.ready.checks?.[peer]?.ok !== true);
        list.push({
          id: 'peer-still-healthy',
          expectation: `故障期间对侧依赖 ${peer} 仍 ok=true（故障不扩散）`,
          ok: !peerBad,
          detail: peerBad ? `第 ${peerBad.at}ms 采样：${describeProbe(peerBad.ready)}` : `${withPeer.length} 次采样均 ok`,
        });
      }
    }
  }

  if (recovery) {
    list.push({
      id: 'recovered',
      expectation: `恢复后 ready 在 ${recoverTimeoutMs}ms 内回到 200`,
      ok: recovery.recovered && recovery.ms <= recoverTimeoutMs,
      detail: recovery.recovered
        ? `耗时 ${recovery.ms}ms（${recovery.attempts} 次轮询）`
        : `超时 ${recovery.ms}ms 未恢复（${recovery.attempts} 次轮询）`,
    });
  }

  const cooldown = of('cooldown');
  if (cooldown.length) {
    const bad = cooldown.find((s) => s.ready.status !== 200);
    list.push({
      id: 'cooldown-stable',
      expectation: '恢复后冷却期 ready 稳定 200',
      ok: !bad,
      detail: bad ? `第 ${bad.at}ms 采样：${describeProbe(bad.ready)}` : `${cooldown.length} 次采样全部 200`,
    });
  }

  const starts = samples
    .map((s) => s.metrics?.['process_start_time_seconds'])
    .filter((v): v is number => typeof v === 'number');
  if (starts.length) {
    const spread = Math.max(...starts) - Math.min(...starts);
    list.push({
      id: 'no-process-restart',
      expectation: '演练期间进程未重启（process_start_time_seconds 不变）',
      ok: spread < 0.5,
      detail: `采样 ${starts.length} 次，时间戳跨度 ${spread.toFixed(1)}s`,
    });
  }

  return list;
}

// ---------- 报告 ----------

function mdEscape(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderMarkdown(report: DrillReport): string {
  const lines: string[] = [];
  const passCount = report.assertions.filter((a) => a.ok).length;
  const planMode = report.mode === 'plan';
  const verdict = planMode ? 'PLAN（仅基线采样，未注入故障）' : report.passed ? 'PASS' : 'FAIL';
  lines.push(`# 混沌演练报告：${report.scenario} 断连（${report.mode}）`, '');
  lines.push(`- 结论：**${verdict}**（断言 ${passCount}/${report.assertions.length} 通过）`);
  lines.push(`- 目标：\`${report.baseUrl}\``);
  lines.push(`- 时间：${report.startedAt} → ${report.finishedAt}（${report.durationMs}ms）`);
  lines.push(
    `- 节奏：基线 ${report.config.baselineMs}ms / 观察 ${report.config.observeMs}ms / 冷却 ${report.config.cooldownMs}ms / 采样间隔 ${report.config.intervalMs}ms`,
    '',
  );

  if (report.warnings.length) {
    lines.push('## 提示', '');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('## 断言明细', '', '| 断言 | 期望 | 结果 | 证据 |', '| --- | --- | --- | --- |');
  for (const a of report.assertions) {
    lines.push(`| \`${a.id}\` | ${mdEscape(a.expectation)} | ${a.ok ? 'PASS' : 'FAIL'} | ${mdEscape(a.detail)} |`);
  }
  lines.push('');

  lines.push('## 阶段采样', '', '| 时刻(ms) | 阶段 | live | ready | 依赖探测 |', '| --- | --- | --- | --- | --- |');
  for (const s of report.samples) {
    const checks = s.ready.checks
      ? Object.entries(s.ready.checks)
          .map(([k, v]) => `${k}=${v.ok ? 'ok' : 'fail'}`)
          .join(', ')
      : '—';
    const live = s.live.status === null ? `不可达(${s.live.error || ''})` : String(s.live.status);
    lines.push(`| ${s.at} | ${s.phase} | ${live} | ${s.ready.status ?? '不可达'} | ${checks} |`);
  }
  lines.push('');

  const firstOf = (phase: Phase) => samples.find((s) => s.phase === phase);
  const base = firstOf('baseline')?.metrics;
  const obs = firstOf('observe')?.metrics;
  const cool = firstOf('cooldown')?.metrics;
  if (base || obs || cool) {
    const fmt = (v: number | undefined) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : '—');
    lines.push('## 指标快照（阶段首采）', '', '| 指标 | 基线 | 观察 | 冷却 |', '| --- | --- | --- | --- |');
    for (const key of METRIC_KEYS) {
      if (!base?.[key] && !obs?.[key] && !cool?.[key]) continue;
      lines.push(`| \`${key}\` | ${fmt(base?.[key])} | ${fmt(obs?.[key])} | ${fmt(cool?.[key])} |`);
    }
    lines.push('');
  }

  lines.push('## 注入与恢复', '');
  if (report.commands.inject) {
    lines.push(`- ${planMode ? '建议注入命令' : '注入命令'}：\`${report.commands.inject}\``);
    if (report.commands.injectResult) {
      lines.push(`  - 退出码 ${report.commands.injectResult.code}，耗时 ${report.commands.injectResult.ms}ms`);
    }
  }
  if (report.commands.recover) {
    lines.push(`- ${planMode ? '建议恢复命令' : '恢复命令'}：\`${report.commands.recover}\``);
    if (report.commands.recoverResult) {
      lines.push(`  - 退出码 ${report.commands.recoverResult.code}，耗时 ${report.commands.recoverResult.ms}ms`);
    }
  }
  if (!report.commands.inject && !report.commands.recover) {
    lines.push('- plan 模式未执行命令，建议命令已打印在控制台');
  }
  lines.push('');
  return lines.join('\n');
}

function writeReports(report: DrillReport): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const stem = path.join(outDir, `chaos-${report.scenario}-${stamp}`);
  writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${stem}.md`, renderMarkdown(report));
  return { json: `${stem}.json`, md: `${stem}.md` };
}

// ---------- 主流程 ----------

function suggestCommands(): { inject: string; recover: string } {
  // 默认走「无数据丢失」的卡顿注入：CLIENT PAUSE 让命令挂起（等价于依赖无响应），
  // 不像 stop 服务那样丢弃未持久化的 key；需演练"连接彻底断开"时改用 stop/防火墙，见手册 L2/L3
  const redisInject = 'redis-cli -p 6379 CLIENT PAUSE 20000 ALL';
  const redisRecover = 'redis-cli -p 6379 CLIENT UNPAUSE';
  const mysqlInject = 'brew services stop mysql  # Linux: sudo systemctl stop mysql';
  const mysqlRecover = 'brew services start mysql  # Linux: sudo systemctl start mysql';
  if (scenario === 'redis') return { inject: redisInject, recover: redisRecover };
  if (scenario === 'mysql') return { inject: mysqlInject, recover: mysqlRecover };
  return { inject: `${redisInject} && ${mysqlInject}`, recover: `${redisRecover} && ${mysqlRecover}` };
}

async function main(): Promise<number> {
  assertTargetSafe(baseUrl);
  if (injectCmd) guardCommand(injectCmd, '注入命令');
  if (recoverCmd) guardCommand(recoverCmd, '恢复命令');

  if (mode === 'execute') {
    if (!injectCmd) {
      console.error('✗ --execute 需要配合 --inject-cmd=...（plan 模式无需命令，直接 npm run chaos:drill 即可）');
      return 2;
    }
    const confirmed = assumeYes || (process.stdin.isTTY ? await askConfirm(`将在 ${baseUrl} 执行断连演练，命令：\n  ${injectCmd}\n确认继续？(y/N) `) : false);
    if (!confirmed) {
      console.error('✗ 未确认执行（TTY 下输入 y，或显式追加 --yes）');
      return 2;
    }
  }
  if (mode === 'assume-injected' && recoverCmd) {
    guardCommand(recoverCmd, '恢复命令');
  }

  // preflight：进程必须存活；plan/execute 还要求基线就绪
  const live0 = await probe('/api/health/live');
  if (live0.status !== 200) {
    console.error(`✗ preflight 失败：${baseUrl}/api/health/live 不可达（${describeProbe(live0)}）`);
    console.error('  请先启动服务：npm run dev（或 npm start）');
    return 2;
  }
  const ready0 = await probe('/api/health/ready');
  const warnings: string[] = [];
  if (mode !== 'assume-injected') {
    if (ready0.status !== 200) {
      console.error(`✗ preflight 失败：基线未就绪（${describeProbe(ready0)}）`);
      console.error('  依赖未全绿时演练无法区分"注入导致"与"本就故障"，请先修复环境');
      return 2;
    }
    const missing = depNames().filter((d) => ready0.checks?.[d] === undefined);
    if (missing.length) {
      console.error(`✗ preflight 失败：就绪报告缺少 ${missing.join(', ')} 探测项`);
      if (missing.includes('redis')) console.error('  Redis 场景需配置 REDIS_URL（否则 buildDefaultProbes 不探测 Redis）');
      return 2;
    }
  } else {
    warnings.push('assume-injected 模式：脚本未观测到"故障前基线"，降级断言仅验证当前失败态与恢复能力');
  }

  console.log(`▶ 混沌演练 [${mode}] scenario=${scenario} target=${baseUrl}`);
  console.log(`  基线采样 ${baselineMs}ms → 注入 → 观察 ${observeMs}ms → 恢复 → 冷却 ${cooldownMs}ms`);

  await collect('baseline', baselineMs);

  const commands: DrillReport['commands'] = {};
  let recovery: Recovery | null = null;

  if (mode === 'plan') {
    const suggested = suggestCommands();
    commands.inject = suggested.inject;
    commands.recover = suggested.recover;
    warnings.push('plan 模式未注入故障：以下为建议命令，确认环境与命令后追加 --execute --yes 复跑');
    console.log('\n  建议注入命令：');
    console.log(`    ${suggested.inject}`);
    console.log('  建议恢复命令：');
    console.log(`    ${suggested.recover}`);
    console.log('\n  完整演练示例：');
    console.log(`    npm run chaos:drill -- --scenario=${scenario} --execute --yes \\`);
    console.log(`      --inject-cmd="${suggested.inject}" --recover-cmd="${suggested.recover}"\n`);
  } else {
    commands.inject = injectCmd;
    commands.recover = recoverCmd;

    if (mode === 'execute' && injectCmd) {
      console.log(`\n  ▸ 注入故障：${injectCmd}`);
      commands.injectResult = await runShell(injectCmd, 60_000);
      console.log(`    退出码 ${commands.injectResult.code}，等待 ${settleMs}ms 进入稳态…`);
      await sleep(settleMs);
    } else {
      console.log(`\n  ▸ assume-injected：跳过注入，等待 ${settleMs}ms 让故障态稳定…`);
      await sleep(settleMs);
    }

    await collect('observe', observeMs);

    if (recoverCmd) {
      console.log(`\n  ▸ 恢复依赖：${recoverCmd}`);
      commands.recoverResult = await runShell(recoverCmd, 60_000);
      console.log(`    退出码 ${commands.recoverResult.code}，轮询就绪（上限 ${recoverTimeoutMs}ms）…`);
    } else {
      warnings.push('未提供 --recover-cmd：脚本不执行恢复，环境需人工恢复；恢复类断言已跳过');
    }

    if (commands.recoverResult || recoverCmd) {
      recovery = await waitReady(recoverTimeoutMs);
      console.log(`    ${recovery.recovered ? '✓' : '✗'} ${recovery.recovered ? '已恢复' : '恢复超时'}（${recovery.ms}ms / ${recovery.attempts} 次轮询）`);
    }

    if (cooldownMs > 0) await collect('cooldown', cooldownMs);
  }

  const assertions = buildAssertions(recovery);
  const passed = assertions.every((a) => a.ok);
  const report: DrillReport = {
    version: 1,
    scenario,
    mode,
    baseUrl,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: elapsed(),
    passed,
    config: {
      baselineMs,
      observeMs,
      cooldownMs,
      settleMs,
      intervalMs,
      recoverTimeoutMs,
      execute: mode === 'execute',
      assumeInjected: mode === 'assume-injected',
    },
    commands,
    recovery,
    samples,
    assertions,
    warnings,
  };

  const paths = writeReports(report);
  console.log('\n断言结果：');
  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.id} — ${a.detail}`);
  }
  console.log(`\n${passed ? '✓ 演练通过' : '✗ 演练存在失败断言'}（${assertions.filter((a) => a.ok).length}/${assertions.length}）`);
  console.log(`  报告：${paths.md}`);
  console.log(`        ${paths.json}`);
  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('✗ 演练异常终止：', err);
    process.exit(2);
  });
