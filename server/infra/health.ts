/**
 * P1-3 健康检查分级：
 * - liveness（GET /api/health/live）：浅探测，进程能响应即 200，供编排系统判"要不要重启"；
 * - readiness（GET /api/health/ready）：深探测，逐个 ping 关键依赖（MySQL 必检，Redis 仅在
 *   REDIS_URL 外置时必检），任一失败聚合为 503 让上游摘流量；停机 drain 期间由路由层直接 503。
 *
 * 探测彼此并行且各自限时（默认单探测 2s），慢依赖不会互相拖累；
 * 超时/异常统一收敛为 { ok:false, error }，不向调用方抛错。
 */
import { getPool } from './db';
import { getStateStore, isRedisEnabled } from './stateStore';

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
      } catch (err: any) {
        checks[p.name] = { ok: false, ms: Date.now() - started, error: err?.message || String(err) };
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
