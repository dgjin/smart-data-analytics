/**
 * 监控 P2：Prometheus 指标 vs query_audit_log 审计表对账校验。
 * 口径一致性验证——同一 writeAudit 路径应使两侧计数一致（increase() 天然处理进程重启计数器清零）：
 *   - Prometheus 侧：sum by (status) (increase(nl2sql_requests_total{endpoint="query"}[窗口]))
 *   - 审计表侧：SELECT status, COUNT(*) FROM query_audit_log WHERE endpoint='query' AND created_at >= 窗口起点
 * 窗口自动钳制到应用进程启动之后（process_start_time_seconds），避免重启前审计记录无对应计数器。
 * 容差：|差值| <= max(2, 审计值×5%)——increase() 为外推估值，低计数下允许 ±2 的取整误差。
 * 用法：npm run metrics:reconcile [-- --window=120]（需 Prometheus 运行中，PROMETHEUS_URL 可覆盖）
 * 退出码：0 一致 / 1 对账不符 / 2 基础设施不可达
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

const PROM = (process.env.PROMETHEUS_URL || 'http://localhost:9090').replace(/\/+$/, '');
const argWin = Number(process.argv.find((a) => a.startsWith('--window='))?.split('=')[1]);
const requestedWinMin = Number.isFinite(argWin) && argWin > 0 ? Math.floor(argWin) : 60;

interface PromResp { status: string; data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] } }

async function promQuery(expr: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as PromResp;
    if (json.status !== 'success') throw new Error(`Prometheus 返回 status=${json.status}`);
    return json.data?.result || [];
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  // 1. 应用进程启动时间 → 有效对账窗口（秒）
  let winSec = requestedWinMin * 60;
  try {
    const startRows = await promQuery('min(process_start_time_seconds{job="nl2sql-app"})');
    const startAt = Number(startRows[0]?.value?.[1] || 0);
    if (startAt > 0) {
      const uptimeSec = Date.now() / 1000 - startAt;
      if (uptimeSec < winSec) {
        console.log(`[reconcile] 应用进程存活 ${(uptimeSec / 60).toFixed(1)} 分钟 < 请求窗口 ${requestedWinMin} 分钟，窗口自动钳制到进程启动后`);
        winSec = Math.max(60, Math.floor(uptimeSec) - 5); // 留 5s 余量防边界抖动
      }
    } else {
      console.warn('[reconcile] 未取到 process_start_time_seconds{job="nl2sql-app"}（应用未被抓取？），按请求窗口对账');
    }
  } catch (err: any) {
    console.error(`[reconcile] Prometheus 不可达（${PROM}）：${err?.message || err}`);
    console.error('  请先启动监控栈：docker compose -f docker-compose.monitoring.yml up -d');
    return 2;
  }

  // 2. Prometheus 侧计数
  const promRows = await promQuery(`sum by (status) (increase(nl2sql_requests_total{endpoint="query"}[${winSec}s]))`);
  const promMap = new Map<string, number>();
  for (const r of promRows) promMap.set(r.metric.status || '?', Number(r.value[1]));

  // 3. 审计表侧计数
  const sinceEpoch = Math.floor(Date.now() / 1000) - winSec;
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'smart_analytics',
  });
  let auditMap = new Map<string, number>();
  try {
    const [rows] = await conn.query(
      "SELECT status, COUNT(*) AS c FROM query_audit_log WHERE endpoint='query' AND created_at >= FROM_UNIXTIME(?) GROUP BY status",
      [sinceEpoch]
    );
    auditMap = new Map((rows as any[]).map((r) => [String(r.status), Number(r.c)]));
  } finally {
    await conn.end();
  }

  // 4. 对账（状态并集逐行比对）
  const statuses = [...new Set([...promMap.keys(), ...auditMap.keys()])].sort();
  const winMin = (winSec / 60).toFixed(1);
  console.log(`\n[reconcile] 对账窗口：近 ${winMin} 分钟（Prometheus increase vs query_audit_log）`);
  console.log('status          Prometheus   审计表   差值   判定');
  console.log('---------------- ------------ -------- ------ ----');
  let mismatches = 0;
  for (const st of statuses) {
    const p = promMap.get(st) ?? 0;
    const a = auditMap.get(st) ?? 0;
    const diff = Math.round(p) - a;
    const tolerance = Math.max(2, Math.ceil(a * 0.05));
    const pass = Math.abs(diff) <= tolerance;
    if (!pass) mismatches += 1;
    console.log(`${st.padEnd(16)} ${String(Math.round(p)).padStart(10)} ${String(a).padStart(9)} ${String(diff).padStart(6)} ${pass ? 'OK' : '❌ 不符'}`);
  }

  if (statuses.length === 0) {
    console.log('\n[reconcile] 窗口内两侧均无数据（空闲期），对账通过（无可对账项）');
    return 0;
  }
  if (mismatches > 0) {
    console.error(`\n[reconcile] ❌ ${mismatches} 个状态对账不符——检查埋点旁路（writeAudit→observeAudit）是否被跳过或重复`);
    return 1;
  }
  console.log('\n[reconcile] ✅ 全部状态对账一致，Prometheus 口径与审计表吻合');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[reconcile] 执行失败：', err?.message || err);
  process.exit(2);
});
