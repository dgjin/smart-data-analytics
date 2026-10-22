/**
 * P1-3 健康检查单测：就绪聚合（全通过/单失败/超时/并行）、默认探测集构建按配置分流；
 * v0.9.116 追加 Redis 落盘巡检（INFO 解析、陈旧/失败判定、未启用跳过、读取失败 fail-open）。
 * v0.9.117 追加 AOF 巡检（写盘/重写失败判定，未开启时不参与）。
 */
import { describe, it, expect } from 'vitest';
import {
  runReadiness,
  buildDefaultProbes,
  parseInfoPersistence,
  evaluateRedisPersistence,
  probeRedisPersistence,
  redisPersistenceStaleSec,
  type HealthProbe,
  type RedisPersistenceSnapshot,
} from './health';

const okProbe = (name: string, ms = 0): HealthProbe => ({
  name,
  run: () => new Promise((r) => setTimeout(r, ms)),
});

describe('runReadiness 就绪聚合', () => {
  it('全部探测通过 → ok=true / status=ok / 各项检查通过', async () => {
    const report = await runReadiness([okProbe('mysql'), okProbe('redis')]);
    expect(report.ok).toBe(true);
    expect(report.status).toBe('ok');
    expect(report.checks.mysql.ok).toBe(true);
    expect(report.checks.redis.ok).toBe(true);
    expect(report.checks.mysql.ms).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeTruthy();
  });

  it('任一探测失败 → status=down 且携带错误信息（其余仍如实记录）', async () => {
    const report = await runReadiness([
      okProbe('mysql'),
      {
        name: 'redis',
        run: () => Promise.reject(new Error('connection refused')),
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.status).toBe('down');
    expect(report.checks.mysql.ok).toBe(true);
    expect(report.checks.redis.ok).toBe(false);
    expect(report.checks.redis.error).toContain('connection refused');
  });

  it('探测超时按失败计，不阻断其他探测', async () => {
    const report = await runReadiness(
      [
        okProbe('mysql'),
        { name: 'redis', run: () => new Promise(() => {}) }, // 永不落定
      ],
      30,
    );
    expect(report.ok).toBe(false);
    expect(report.checks.mysql.ok).toBe(true);
    expect(report.checks.redis.ok).toBe(false);
    expect(report.checks.redis.error).toContain('timeout');
  });

  it('慢探测并行执行：总耗时接近单探测时长而非累加', async () => {
    const started = Date.now();
    const report = await runReadiness([okProbe('a', 50), okProbe('b', 50), okProbe('c', 50)], 1000);
    const elapsed = Date.now() - started;
    expect(report.ok).toBe(true);
    expect(elapsed).toBeLessThan(120); // 并行 ≈50ms；串行将 ≥150ms
  });
});

describe('buildDefaultProbes 默认探测集', () => {
  it('无 REDIS_URL 时仅 MySQL；配置 REDIS_URL 后追加 Redis', () => {
    const saved = process.env.REDIS_URL;
    try {
      delete process.env.REDIS_URL;
      expect(buildDefaultProbes().map((p) => p.name)).toEqual(['mysql']);
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      expect(buildDefaultProbes().map((p) => p.name)).toEqual(['mysql', 'redis']);
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});

describe('Redis 落盘巡检', () => {
  const snapshot = (over: Partial<RedisPersistenceSnapshot> = {}): RedisPersistenceSnapshot => ({
    lastSaveAt: 1_000_000,
    changesSinceLastSave: 10,
    savesConsecutiveFailures: 0,
    lastBgsaveStatus: 'ok',
    aofEnabled: true,
    aofLastWriteStatus: 'ok',
    aofRewritesConsecutiveFailures: 0,
    aofLastBgrewriteStatus: 'ok',
    ...over,
  });
  const HOUR = 3600;

  it('阈值内落盘 → ok，不判陈旧', () => {
    const r = evaluateRedisPersistence(snapshot(), 1_000_000 + HOUR, 2 * HOUR);
    expect(r).toMatchObject({ ok: true, stale: false, failed: false, lastSaveAgeSec: HOUR });
  });

  it('超阈值且仍有未落盘写入 → stale 且 ok=false（停摆场景）', () => {
    const r = evaluateRedisPersistence(snapshot(), 1_000_000 + 8 * 24 * HOUR, 2 * HOUR);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.failed).toBe(false);
  });

  it('超阈值但无未落盘写入 → 不算陈旧（空库静默期合法）', () => {
    const r = evaluateRedisPersistence(snapshot({ changesSinceLastSave: 0 }), 1_000_000 + 8 * 24 * HOUR, 2 * HOUR);
    expect(r.ok).toBe(true);
    expect(r.stale).toBe(false);
  });

  it('连续 BGSAVE 失败或最近结果为 err → failed', () => {
    expect(evaluateRedisPersistence(snapshot({ savesConsecutiveFailures: 2 }), 1_000_000, 2 * HOUR).failed).toBe(true);
    expect(evaluateRedisPersistence(snapshot({ lastBgsaveStatus: 'err' }), 1_000_000, 2 * HOUR).failed).toBe(true);
  });

  it('INFO 文本解析：取持久化字段（含 AOF），忽略注释与其他段', () => {
    const raw = [
      '# Persistence',
      'loading:0',
      'rdb_changes_since_last_save:60',
      'rdb_bgsave_in_progress:0',
      'rdb_last_save_time:1792639541',
      'rdb_last_bgsave_status:ok',
      'rdb_saves:2',
      'rdb_saves_consecutive_failures:0',
      'aof_enabled:1',
      'aof_last_write_status:ok',
      'aof_rewrites_consecutive_failures:0',
      'aof_last_bgrewrite_status:ok',
      '',
    ].join('\r\n');
    expect(parseInfoPersistence(raw)).toEqual({
      lastSaveAt: 1792639541,
      changesSinceLastSave: 60,
      savesConsecutiveFailures: 0,
      lastBgsaveStatus: 'ok',
      aofEnabled: true,
      aofLastWriteStatus: 'ok',
      aofRewritesConsecutiveFailures: 0,
      aofLastBgrewriteStatus: 'ok',
    });
  });

  it('未开启 AOF 的 INFO（无 aof_* 行）→ aofEnabled=false 且其余字段取默认', () => {
    const parsed = parseInfoPersistence('rdb_last_save_time:1000\n');
    expect(parsed).toMatchObject({
      aofEnabled: false,
      aofLastWriteStatus: 'unknown',
      aofRewritesConsecutiveFailures: 0,
      aofLastBgrewriteStatus: 'unknown',
    });
  });

  it('AOF 写盘 err 或重写连续失败 → failed 且 aofFailed=true', () => {
    const writeErr = evaluateRedisPersistence(snapshot({ aofLastWriteStatus: 'err' }), 1_000_000, 2 * HOUR);
    expect(writeErr).toMatchObject({ ok: false, failed: true, aofFailed: true, stale: false });
    const rewriteErr = evaluateRedisPersistence(snapshot({ aofRewritesConsecutiveFailures: 2 }), 1_000_000, 2 * HOUR);
    expect(rewriteErr.failed).toBe(true);
    expect(rewriteErr.aofFailed).toBe(true);
  });

  it('AOF 未开启时忽略其失败字段（不因历史 err 误判）', () => {
    const r = evaluateRedisPersistence(
      snapshot({ aofEnabled: false, aofLastWriteStatus: 'err', aofLastBgrewriteStatus: 'err', aofRewritesConsecutiveFailures: 3 }),
      1_000_000,
      2 * HOUR,
    );
    expect(r).toMatchObject({ ok: true, failed: false, aofFailed: false });
  });

  it('缺少 rdb_last_save_time 或为 0 → 不可判定（null）', () => {
    expect(parseInfoPersistence('rdb_changes_since_last_save:1\n')).toBeNull();
    expect(parseInfoPersistence('rdb_last_save_time:0\n')).toBeNull();
  });

  it('阈值惰性读取：默认 7200s，环境变量可覆盖', () => {
    const saved = process.env.REDIS_RDB_STALE_MINUTES;
    try {
      delete process.env.REDIS_RDB_STALE_MINUTES;
      expect(redisPersistenceStaleSec()).toBe(7200);
      process.env.REDIS_RDB_STALE_MINUTES = '30';
      expect(redisPersistenceStaleSec()).toBe(1800);
      process.env.REDIS_RDB_STALE_MINUTES = '0';
      expect(redisPersistenceStaleSec()).toBe(7200); // 非法值回退默认
    } finally {
      if (saved === undefined) delete process.env.REDIS_RDB_STALE_MINUTES;
      else process.env.REDIS_RDB_STALE_MINUTES = saved;
    }
  });

  it('未启用 Redis → skipped 且 ok（内存模式不巡检）', async () => {
    const saved = process.env.REDIS_URL;
    try {
      delete process.env.REDIS_URL;
      const r = await probeRedisPersistence();
      expect(r).toMatchObject({ enabled: false, ok: true, skipped: true, stale: false, failed: false });
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });

  it('INFO 读取异常 → fail-open（ok=true 且回传错误，不重复判故障）', async () => {
    const saved = process.env.REDIS_URL;
    try {
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      const r = await probeRedisPersistence({
        nowSec: 1_000_000,
        readInfo: () => Promise.reject(new Error('connect ECONNREFUSED')),
      });
      expect(r.enabled).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.error).toContain('ECONNREFUSED');
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });

  it('正常读取 → 判定结果与快照字段透传', async () => {
    const saved = process.env.REDIS_URL;
    try {
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      const r = await probeRedisPersistence({
        nowSec: 1_000_000 + 3 * HOUR,
        thresholdSec: 2 * HOUR,
        readInfo: async () =>
          'rdb_last_save_time:1000000\nrdb_changes_since_last_save:5\nrdb_saves_consecutive_failures:0\nrdb_last_bgsave_status:ok\naof_enabled:1\naof_last_write_status:ok\n',
      });
      expect(r).toMatchObject({
        enabled: true,
        ok: false,
        stale: true,
        failed: false,
        lastSaveAt: 1_000_000,
        changesSinceLastSave: 5,
        lastSaveAgeSec: 3 * HOUR,
        thresholdSec: 2 * HOUR,
        aofEnabled: true,
        aofLastWriteStatus: 'ok',
      });
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});
