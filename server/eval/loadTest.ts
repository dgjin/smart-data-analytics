/**
 * P1-9 连接池与容量规划：SQL 执行层压测脚本。
 * 以 executeSafeSql 全链路（白名单校验 → 行级权限注入 → 数据源池执行）对真实数据源施压，
 * 分并发档位（默认 20/50/100）统计 P50/P95/P99 延迟与错误率，验证池容量公式生效且无连接耗尽。
 *
 * 运行方式：
 *   npx tsx server/eval/loadTest.ts                         # 自动选第一个 mysql 数据源，20/50/100 档
 *   npx tsx server/eval/loadTest.ts --ds <id> --levels 20,50,100 --rounds 5
 *
 * 说明：问数端到端延迟由 LLM 生成主导（本地 27B 模型数十秒/问），数据库侧瓶颈在连接池，
 * 故压测聚焦执行层（轻量聚合查询）而非全链路；报告 JSON 落盘 server/eval/load-report-*.json。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
// 与 server.ts/runEval.ts 同序：先 dotenv（.env.local 优先），再惰性读取 env（含 JWT_SECRET 解密钥）
dotenv.config({ path: join(ROOT, '.env.local') });
dotenv.config({ path: join(ROOT, '.env') });

interface LevelStat {
  concurrency: number;
  totalRequests: number;
  success: number;
  failed: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  throughputQps: number;
  errors: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argOf = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const levels = (argOf('levels') || '20,50,100')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rounds = Math.max(1, Number(argOf('rounds')) || 5);

  const { initSchema, getPool } = await import('../db');
  const { executeSafeSql, loadDataSourceConfig, dsPoolMax, dialectOfDsType, invalidateExecutorPool } = await import('../sqlExecutor');
  await initSchema();

  // 选定数据源：--ds 指定或取第一个 mysql/pg 系数据源
  let dataSourceId = argOf('ds');
  let schema: { name: string; columns?: { name: string }[] }[] = [];
  if (!dataSourceId) {
    const [rows] = await getPool().query(
      "SELECT id, schema_json FROM data_sources WHERE type IN ('mysql','postgresql','greenplum') ORDER BY created_at ASC"
    );
    const list = rows as any[];
    if (list.length === 0) throw new Error('无可用真实数据源（mysql/postgresql/greenplum）');
    dataSourceId = String(list[0].id);
    try {
      schema = JSON.parse(String(list[0].schema_json || '[]'));
    } catch {
      schema = [];
    }
  } else {
    const [rows] = await getPool().query('SELECT schema_json FROM data_sources WHERE id = ?', [dataSourceId]);
    const row = (rows as any[])[0];
    if (!row) throw new Error(`数据源不存在：${dataSourceId}`);
    try {
      schema = JSON.parse(String(row.schema_json || '[]'));
    } catch {
      schema = [];
    }
  }
  const ds = await loadDataSourceConfig(dataSourceId);
  if (!ds || !dialectOfDsType(ds.type)) throw new Error(`数据源 ${dataSourceId} 类型不支持真实执行`);
  const table = schema[0]?.name;
  if (!table) throw new Error(`数据源 ${dataSourceId} schema 为空，无法构造压测 SQL`);
  const probeSql = `SELECT COUNT(*) AS cnt FROM ${table}`;

  const poolMax = dsPoolMax();
  console.log(`[LoadTest] 数据源=${dataSourceId} 表=${table} DS_POOL_MAX(生效)=${poolMax} 并发档=${levels.join('/')} 每 worker ${rounds} 轮`);

  // 预热：建池 + 首轮连接
  for (let i = 0; i < poolMax; i++) {
    await executeSafeSql(dataSourceId!, probeSql, schema, [], undefined, {}, 'chain');
  }

  const stats: LevelStat[] = [];
  for (const c of levels) {
    const latencies: number[] = [];
    const errors: string[] = [];
    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: c }, async () => {
        for (let r = 0; r < rounds; r++) {
          const t0 = Date.now();
          const out = await executeSafeSql(dataSourceId!, probeSql, schema, [], undefined, {}, 'chain');
          latencies.push(Date.now() - t0);
          if (out.ok !== true) errors.push(out.reason);
        }
      })
    );
    const wallMs = Date.now() - startedAt;
    const sorted = [...latencies].sort((a, b) => a - b);
    const total = latencies.length;
    const stat: LevelStat = {
      concurrency: c,
      totalRequests: total,
      success: total - errors.length,
      failed: errors.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      avgMs: total ? Math.round((sorted.reduce((a, b) => a + b, 0) / total) * 100) / 100 : 0,
      throughputQps: Math.round((total / (wallMs / 1000)) * 100) / 100,
      errors: [...new Set(errors)].slice(0, 3),
    };
    stats.push(stat);
    console.log(
      `[LoadTest] 并发 ${c}: ${stat.success}/${total} 成功, P50=${stat.p50Ms}ms P95=${stat.p95Ms}ms P99=${stat.p99Ms}ms max=${stat.maxMs}ms, ${stat.throughputQps} qps${stat.errors.length ? ` 错误样本: ${stat.errors.join(';')}` : ''}`
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dataSourceId,
    probeSql,
    dsPoolMax: poolMax,
    expectedConcurrentUsers: Number(process.env.EXPECTED_CONCURRENT_USERS) || 20,
    roundsPerWorker: rounds,
    levels: stats,
  };
  const outPath = join(__dirname, `load-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[LoadTest] 报告已写入 ${outPath}`);

  invalidateExecutorPool();
  process.exit(0);
}

main().catch((err) => {
  console.error('[LoadTest] 失败:', err?.message || err);
  process.exit(1);
});
