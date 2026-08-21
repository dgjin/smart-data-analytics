/**
 * P0-3 LLM 调用韧性单测：退避重试、引擎级熔断、并发信号量、自适应超时。
 * 全部注入时钟/随机/睡眠，不依赖真实网络与时间流逝。
 */
import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  LatencyWindow,
  Semaphore,
  adaptiveTimeoutMs,
  extractStatus,
  isRetryable,
  makeLlmError,
  withRetry,
} from './llmResilience';

const noSleep = () => Promise.resolve();

describe('isRetryable 可重试错误分类', () => {
  it('超时 / AbortError 可重试', () => {
    expect(isRetryable(makeLlmError('超时', { code: 'TIMEOUT' }))).toBe(true);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isRetryable(abort)).toBe(true);
  });

  it('5xx 与 429 可重试', () => {
    expect(isRetryable(makeLlmError('srv', { status: 500 }))).toBe(true);
    expect(isRetryable(makeLlmError('srv', { status: 503 }))).toBe(true);
    expect(isRetryable(makeLlmError('限流', { status: 429 }))).toBe(true);
  });

  it('4xx（除 429）不可重试；熔断开路不重试', () => {
    expect(isRetryable(makeLlmError('鉴权失败', { status: 401 }))).toBe(false);
    expect(isRetryable(makeLlmError('参数错误', { status: 400 }))).toBe(false);
    expect(isRetryable(makeLlmError('开路', { code: 'CIRCUIT_OPEN' }))).toBe(false);
  });

  it('网络层错误（无状态码）可重试；message 中状态码可兜底提取', () => {
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
    expect(extractStatus(new Error('Qwen API error: 502 bad gateway'))).toBe(502);
    expect(isRetryable(new Error('Qwen API error: 403 forbidden'))).toBe(false);
  });
});

describe('withRetry 指数退避重试', () => {
  it('首次成功不重试', async () => {
    let calls = 0;
    const r = await withRetry(() => { calls++; return Promise.resolve('ok'); }, { sleep: noSleep });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('可重试错误按次数重试至成功', async () => {
    let calls = 0;
    const r = await withRetry(
      () => {
        calls++;
        if (calls < 3) return Promise.reject(makeLlmError('srv', { status: 500 }));
        return Promise.resolve('ok');
      },
      { maxRetries: 2, sleep: noSleep, random: () => 0.5 }
    );
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('超过最大重试次数抛错；4xx 不重试直接抛', async () => {
    let calls = 0;
    await expect(
      withRetry(() => { calls++; return Promise.reject(makeLlmError('srv', { status: 500 })); }, { maxRetries: 2, sleep: noSleep })
    ).rejects.toThrow('srv');
    expect(calls).toBe(3); // 1 + 2 次重试

    calls = 0;
    await expect(
      withRetry(() => { calls++; return Promise.reject(makeLlmError('鉴权', { status: 401 })); }, { maxRetries: 2, sleep: noSleep })
    ).rejects.toThrow('鉴权');
    expect(calls).toBe(1);
  });

  it('退避间隔指数增长（base*2^(n-1)，含抖动区间）', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      () => { calls++; return calls <= 2 ? Promise.reject(makeLlmError('t', { code: 'TIMEOUT' })) : Promise.resolve('ok'); },
      { maxRetries: 2, baseDelayMs: 1000, sleep: (ms) => { delays.push(ms); return noSleep(); }, random: () => 0 }
    );
    expect(delays.length).toBe(2);
    expect(delays[0]).toBe(750); // 1000 * 1 * 0.75
    expect(delays[1]).toBe(1500); // 1000 * 2 * 0.75
  });
});

describe('CircuitBreaker 引擎级熔断', () => {
  function makeBreaker(nowRef: { t: number }) {
    return new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => nowRef.t });
  }

  it('连续失败达阈值开路；冷却期内拒绝请求', () => {
    const nowRef = { t: 0 };
    const b = makeBreaker(nowRef);
    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe('closed');
    b.onFailure();
    expect(b.state()).toBe('open');
    expect(b.canRequest()).toBe(false);
  });

  it('冷却期后进入半开，单探测成功则恢复 closed', () => {
    const nowRef = { t: 0 };
    const b = makeBreaker(nowRef);
    b.onFailure(); b.onFailure(); b.onFailure();
    expect(b.state()).toBe('open');
    nowRef.t = 1001; // 过冷却期
    expect(b.state()).toBe('half-open');
    expect(b.canRequest()).toBe(true);
    // 半开仅允许单探测
    expect(b.canRequest()).toBe(false);
    b.onSuccess();
    expect(b.state()).toBe('closed');
    expect(b.consecutiveFailures).toBe(0);
  });

  it('半开探测失败重新进入开路并重新计时', () => {
    const nowRef = { t: 0 };
    const b = makeBreaker(nowRef);
    b.onFailure(); b.onFailure(); b.onFailure();
    nowRef.t = 1001;
    expect(b.canRequest()).toBe(true);
    b.onFailure(); // 探测失败
    expect(b.state()).toBe('open');
    nowRef.t = 1500; // 冷却期内
    expect(b.canRequest()).toBe(false);
    nowRef.t = 2002;
    expect(b.state()).toBe('half-open');
  });

  it('成功调用清零连续失败计数', () => {
    const nowRef = { t: 0 };
    const b = makeBreaker(nowRef);
    b.onFailure(); b.onFailure();
    b.onSuccess();
    b.onFailure(); b.onFailure();
    expect(b.state()).toBe('closed');
  });
});

describe('Semaphore 并发排队上限', () => {
  it('满员时后续 acquire 排队，释放后按序唤醒', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.active).toBe(2);
    let thirdDone = false;
    const p3 = sem.acquire().then((r) => { thirdDone = true; return r; });
    expect(sem.queued).toBe(1);
    await Promise.resolve();
    expect(thirdDone).toBe(false);
    r1();
    const r3 = await p3;
    expect(thirdDone).toBe(true);
    expect(sem.active).toBe(2);
    r2(); r3();
    expect(sem.active).toBe(0);
  });

  it('并发上限不被突破（模拟 10 个并发任务）', async () => {
    const sem = new Semaphore(3);
    let peak = 0;
    let running = 0;
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const release = await sem.acquire();
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        release();
      })
    );
    expect(peak).toBe(3);
  });
});

describe('LatencyWindow + adaptiveTimeoutMs 自适应超时', () => {
  it('样本不足 10 条不做自适应，返回配置上限', () => {
    const w = new LatencyWindow();
    w.record(1000);
    expect(adaptiveTimeoutMs(w, 180_000)).toBe(180_000);
  });

  it('P95×3 收紧超时，且不低于下限、不高于配置上限', () => {
    const w = new LatencyWindow();
    for (let i = 0; i < 50; i++) w.record(10_000); // P95 = 10s
    // 10s*3 = 30s，夹在 [15s, 180s] → 30s
    expect(adaptiveTimeoutMs(w, 180_000)).toBe(30_000);
  });

  it('慢引擎 P95 高时不放大超过配置上限', () => {
    const w = new LatencyWindow();
    for (let i = 0; i < 50; i++) w.record(100_000);
    expect(adaptiveTimeoutMs(w, 180_000)).toBe(180_000);
  });

  it('快引擎超时收紧但不低于下限 floorMs', () => {
    const w = new LatencyWindow();
    for (let i = 0; i < 50; i++) w.record(1_000);
    expect(adaptiveTimeoutMs(w, 180_000)).toBe(15_000);
  });
});
