/**
 * 日志域 P2-14：Prometheus 运维事件计数器 vs ops_events 表对账校验。
 * 口径推导（dedup 合并语义下的严格下界 L）：
 *   - Prometheus 侧 P：sum(increase(ops_events_recorded_total[窗口]))——每次 recordOpsEvent
 *     （新插入或被 15 分钟窗口去重合并）均 inc 一次；
 *   - DB 侧可观测记录次数下界：L = SUM(dedup_count) WHERE created_at >= 窗口起点
 *       （窗口内新建行的全部记录次数）
 *     + COUNT(*) WHERE created_at < 起点 AND last_seen_at >= 起点
 *       （窗口外创建、窗口内被合并过的行：每行至少贡献 1 次）
 *   - 差额 P - L >= 0 恒成立，其含义为「旧行在窗口内二次以上合并」的余量：空闲期接近 0，
 *     事件风暴时显著上升属 dedup 设计预期，仅展示不判败。
 *   - 判败条件：P 显著小于 L（inc 埋点缺失或 DB 超预期写入），容差 max(2, ceil(L×5%))
 *     容忍 increase() 外推取整与「先查 Prom 后查 DB」的秒级摆动。
 * 窗口自动钳制到应用进程启动之后（process_start_time_seconds），避免重启前事件无对应计数器。
 * 用法：npm run logs:reconcile [-- --window=120]（需 Prometheus 运行中，PROMETHEUS_URL 可覆盖）
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
  } catch (err) {
    console.error(`[reconcile] Prometheus 不可达（${PROM}）：${err instanceof Error ? err.message : String(err)}`);
    console.error('  请先启动监控栈：docker compose -f docker-compose.monitoring.yml up -d');
    return 2;
  }

  // 2. Prometheus 侧：窗口内事件记录总次数（含去重合并）
  const promRows = await promQuery(`sum(increase(ops_events_recorded_total[${winSec}s]))`);
  const promCount = Math.round(Number(promRows[0]?.value?.[1] || 0));

  // 3. DB 侧：下界三元组（新插入 / 新行含合并 / 旧行窗口内被合并过）
  const sinceEpoch = Math.floor(Date.now() / 1000) - winSec;
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'smart_analytics',
  });
  interface CntRow extends mysql.RowDataPacket { c: number; s?: number }
  // 无初始值：查询失败会直接从 try 传播（无 catch），后续代码不可达，初值永不生效
  let freshRows: number;
  let freshSum: number;
  let oldTouched: number;
  try {
    const [fresh] = await conn.query<CntRow[]>(
      'SELECT COUNT(*) AS c, COALESCE(SUM(dedup_count), 0) AS s FROM ops_events WHERE created_at >= FROM_UNIXTIME(?)',
      [sinceEpoch]
    );
    freshRows = Number(fresh[0]?.c || 0);
    freshSum = Number(fresh[0]?.s || 0);
    const [old] = await conn.query<CntRow[]>(
      'SELECT COUNT(*) AS c FROM ops_events WHERE created_at < FROM_UNIXTIME(?) AND last_seen_at >= FROM_UNIXTIME(?)',
      [sinceEpoch, sinceEpoch]
    );
    oldTouched = Number(old[0]?.c || 0);
  } finally {
    await conn.end();
  }

  // 4. 对账：P >= L（严格下界），差额即旧行多次合并余量
  const lowerBound = freshSum + oldTouched;
  const tolerance = Math.max(2, Math.ceil(lowerBound * 0.05));
  const shortfall = lowerBound - promCount; // > 0 表示 Prometheus 少于下界（异常方向）
  const surplus = promCount - lowerBound; // >= 0 为合法余量（旧行二次以上合并）
  const pass = shortfall <= tolerance;
  const winMin = (winSec / 60).toFixed(1);

  console.log(`\n[reconcile] 对账窗口：近 ${winMin} 分钟（Prometheus increase vs ops_events 表）`);
  console.log('metric                      Prometheus   DB下界  差值   判定');
  console.log('--------------------------- ------------ ------- ------ ----');
  console.log(
    `${'ops_events_recorded'.padEnd(27)} ${String(promCount).padStart(10)} ${String(lowerBound).padStart(7)} ${String(surplus).padStart(6)} ${pass ? 'OK' : '❌ 不符'}`
  );
  console.log(
    `  （含 15 分钟窗口去重合并；下界构成：窗口内新建 ${freshRows} 行计 ${freshSum} 次 + 旧行窗口内被合并 ${oldTouched} 行）`
  );
  if (surplus > 0) {
    console.log(`  差值 ${surplus} = 旧行在窗口内二次以上合并（dedup 合并语义下合法，事件风暴时上升属预期）`);
  }

  if (!pass) {
    console.error(
      `\n[reconcile] ❌ Prometheus 记录数（${promCount}）低于 DB 下界（${lowerBound}）且超出容差（${tolerance}）——检查 recordOpsEvent → observeOpsEvent 埋点旁路是否被跳过或 Prometheus 抓取异常`
    );
    return 1;
  }
  if (promCount === 0 && lowerBound === 0) {
    console.log('\n[reconcile] 窗口内两侧均无事件（空闲期），对账通过（无可对账项）');
    return 0;
  }
  console.log('\n[reconcile] ✅ 事件计数与 ops_events 表吻合（下界成立，无埋点缺失）');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[reconcile] 执行失败：', err?.message || err);
  process.exit(2);
});
