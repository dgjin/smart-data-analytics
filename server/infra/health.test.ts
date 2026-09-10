/**
 * P1-3 健康检查单测：就绪聚合（全通过/单失败/超时/并行）、默认探测集构建按配置分流。
 */
import { describe, it, expect } from 'vitest';
import { runReadiness, buildDefaultProbes, type HealthProbe } from './health';

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
