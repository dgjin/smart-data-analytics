/**
 * P1-3 健康检查分级：
 * - liveness（GET /api/health/live）：浅探测，进程能响应即 200，供编排系统判"要不要重启"；
 * - readiness（GET /api/health/ready）：深探测，逐个 ping 关键依赖（MySQL 必检，Redis 仅在
 *   REDIS_URL 外置时必检），任一失败聚合为 503 让上游摘流量；停机 drain 期间由路由层直接 503。
 *
 * 探测彼此并行且各自限时（默认单探测 2s），慢依赖不会互相拖累；
 * 超时/异常统一收敛为 { ok:false, error }，不向调用方抛错。
 *
 * 另有 GET /api/health/persistence 单项巡检（Redis 落盘陈旧/保存失败），独立于 ready 判定，
 * 避免落盘告警触发上游摘流量。
 */
import { getPool } from './db';
import { getRedisClient, getStateStore, isRedisEnabled } from './stateStore';
import { getErrorMessage } from './errorUtils';

export interface HealthProbe {
  name: string;
  /** 探测逻辑：resolve=健康；reject/超时=不健康 */
  run: () => Promise<unknown>;
}

export interface ReadinessCheck {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface ReadinessReport {
  ok: boolean;
  status: 'ok' | 'down';
  checks: Record<string, ReadinessCheck>;
  timestamp: string;
}

/** 单探测限时：超时 reject（原 promise 的落定结果被忽略，不产生未处理拒绝） */
function withTimeout(promise: Promise<unknown>, ms: number, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe "${name}" timeout ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 并行执行探测并聚合为就绪报告（不抛错） */
export async function runReadiness(probes: HealthProbe[], timeoutMs = 2000): Promise<ReadinessReport> {
  const checks: Record<string, ReadinessCheck> = {};
  await Promise.all(
    probes.map(async (p) => {
      const started = Date.now();
      try {
        await withTimeout(p.run(), timeoutMs, p.name);
        checks[p.name] = { ok: true, ms: Date.now() - started };
      } catch (err) {
        checks[p.name] = { ok: false, ms: Date.now() - started, error: getErrorMessage(err) || String(err) };
      }
    }),
  );
  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, status: ok ? 'ok' : 'down', checks, timestamp: new Date().toISOString() };
}

/** 默认探测集：MySQL 应用库必检；Redis 仅在外置配置（REDIS_URL）时探测 */
export function buildDefaultProbes(): HealthProbe[] {
  const probes: HealthProbe[] = [
    {
      name: 'mysql',
      run: async () => {
        await getPool().query('SELECT 1');
      },
    },
  ];
  if (isRedisEnabled()) {
    probes.push({
      name: 'redis',
      run: async () => {
        await getStateStore().get('__healthz__');
      },
    });
  }
  return probes;
}

// ---------- Redis 落盘巡检（GET /api/health/persistence） ----------
//
// 背景（2026-10-22 复盘）：Redis 自动保存规则在运行期被 CONFIG SET save "" 清空时不写任何
// 日志，进程照常服务，只能靠 rdb_last_save_time 的年龄 + 未落盘写入数发现。该巡检属观测类，
// 读取失败一律 fail-open（Redis 宕机由 /ready 报），仅"超阈值仍有未落盘写入"或"连续保存失败"判 503。

export interface RedisPersistenceSnapshot {
  /** 最近一次成功落盘时间（Unix 秒） */
  lastSaveAt: number;
  /** 距上次落盘的写命令累计数（>0 表示有未落盘数据） */
  changesSinceLastSave: number;
  /** 连续 BGSAVE 失败次数 */
  savesConsecutiveFailures: number;
  /** 最近一次 BGSAVE 结果：ok / err */
  lastBgsaveStatus: string;
}

export interface RedisPersistenceReport extends Partial<RedisPersistenceSnapshot> {
  enabled: boolean;
  ok: boolean;
  /** Redis 未启用（内存模式）时为 true */
  skipped?: boolean;
  stale: boolean;
  failed: boolean;
  thresholdSec: number;
  lastSaveAgeSec?: number;
  error?: string;
  timestamp: string;
}

/** 陈旧阈值惰性读取（分钟，默认 120）：环境变量热更即时生效 */
export function redisPersistenceStaleSec(): number {
  const minutes = Number(process.env.REDIS_RDB_STALE_MINUTES);
  return Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60);
}

/** 解析 INFO persistence；缺少有效 rdb_last_save_time 视为不可判定（返回 null） */
export function parseInfoPersistence(raw: string): RedisPersistenceSnapshot | null {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0 || line.startsWith('#')) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const lastSave = Number(fields.get('rdb_last_save_time'));
  if (!Number.isFinite(lastSave) || lastSave <= 0) return null;
  return {
    lastSaveAt: lastSave,
    changesSinceLastSave: Math.max(0, Number(fields.get('rdb_changes_since_last_save')) || 0),
    savesConsecutiveFailures: Math.max(0, Number(fields.get('rdb_saves_consecutive_failures')) || 0),
    lastBgsaveStatus: fields.get('rdb_last_bgsave_status') || 'unknown',
  };
}

/** 纯判定：超阈值且仍有未落盘写入才算陈旧；保存失败单独计 */
export function evaluateRedisPersistence(
  snapshot: RedisPersistenceSnapshot,
  nowSec: number,
  thresholdSec: number,
): { ok: boolean; stale: boolean; failed: boolean; lastSaveAgeSec: number } {
  const lastSaveAgeSec = Math.max(0, nowSec - snapshot.lastSaveAt);
  const stale = snapshot.changesSinceLastSave > 0 && lastSaveAgeSec > thresholdSec;
  const failed = snapshot.savesConsecutiveFailures > 0 || snapshot.lastBgsaveStatus === 'err';
  return { ok: !stale && !failed, stale, failed, lastSaveAgeSec };
}

/** 读取 Redis INFO persistence（未启用 Redis 返回 null） */
async function readInfoPersistence(): Promise<string | null> {
  const client = getRedisClient();
  return client ? client.info('persistence') : null;
}

export async function probeRedisPersistence(
  opts: { nowSec?: number; thresholdSec?: number; readInfo?: () => Promise<string | null> } = {},
): Promise<RedisPersistenceReport> {
  const timestamp = new Date().toISOString();
  const thresholdSec = opts.thresholdSec ?? redisPersistenceStaleSec();
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!isRedisEnabled()) {
    return { enabled: false, ok: true, skipped: true, stale: false, failed: false, thresholdSec, timestamp };
  }
  const base = { enabled: true, stale: false, failed: false, thresholdSec, timestamp };
  let snapshot: RedisPersistenceSnapshot | null;
  try {
    const raw = await (opts.readInfo ?? readInfoPersistence)();
    snapshot = raw ? parseInfoPersistence(raw) : null;
  } catch (err) {
    // 观测类 fail-open：读取失败不判故障（Redis 不可用由 /ready 报），仅回传原因
    return { ...base, ok: true, error: getErrorMessage(err) || String(err) };
  }
  if (!snapshot) return { ...base, ok: true, error: 'INFO persistence 缺少 rdb_last_save_time' };
  return { ...base, ...snapshot, ...evaluateRedisPersistence(snapshot, nowSec, thresholdSec) };
}
