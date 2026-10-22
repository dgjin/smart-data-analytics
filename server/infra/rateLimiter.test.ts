/**
 * P2-2 限流降级契约测试（混沌演练的 CI 化部分）：
 * - 内存模式：窗口内超限 429、不同 IP 独立计数
 * - Redis 模式：计数放行 / 超限 429
 * - Redis 异常：fail-closed 一律 429（宁可拒绝也不放行，防止断连期间限流失效被打穿）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { rateLimiter } from './rateLimiter';
import { setStateStoreForTest } from './stateStore';
import type { StateStore } from './stateStore';

/** 最小 Response 桩：只覆盖 rateLimiter 用到的 status/json */
function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const reqOf = (ip: string) => ({ ip }) as unknown as express.Request;

/** 可编排行为的 StateStore 桩（仅限流用的 incrWindow） */
function storeWith(incrWindow: StateStore['incrWindow']): StateStore {
  return {
    incrWindow,
    get: async () => null,
    setEx: async () => undefined,
    getDel: async () => null,
    deleteByPrefix: async () => 0,
    acquireLock: async () => true,
    releaseLock: async () => undefined,
  };
}

let ipSeq = 0;
const uniqueIp = () => `10.0.0.${++ipSeq}`;

beforeEach(() => {
  process.env.RATE_LIMIT_MAX = '2';
  delete process.env.REDIS_URL;
  setStateStoreForTest(null);
});

afterEach(() => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.REDIS_URL;
  setStateStoreForTest(null);
});

describe('内存模式', () => {
  it('窗口内前两次放行、第三次 429', async () => {
    const ip = uniqueIp();
    const next = { calls: 0, fn() { next.calls++; } };
    for (let i = 0; i < 2; i++) {
      const res = mockRes();
      await rateLimiter(reqOf(ip), res as unknown as express.Response, next.fn);
      expect(res.statusCode).toBe(200);
    }
    const res = mockRes();
    await rateLimiter(reqOf(ip), res as unknown as express.Response, next.fn);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error: expect.stringContaining('过于频繁') });
    expect(next.calls).toBe(2); // 超限请求不再进入后续处理链
  });

  it('不同 IP 独立计数', async () => {
    const next = { calls: 0, fn() { next.calls++; } };
    for (let i = 0; i < 3; i++) {
      await rateLimiter(reqOf(uniqueIp()), mockRes() as unknown as express.Response, next.fn);
    }
    expect(next.calls).toBe(3);
  });
});

describe('Redis 模式', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  });

  it('计数未超限 → 放行', async () => {
    setStateStoreForTest(storeWith(async () => 1));
    const next = { calls: 0, fn() { next.calls++; } };
    const res = mockRes();
    await rateLimiter(reqOf(uniqueIp()), res as unknown as express.Response, next.fn);
    expect(res.statusCode).toBe(200);
    expect(next.calls).toBe(1);
  });

  it('计数超限 → 429', async () => {
    setStateStoreForTest(storeWith(async () => 3));
    const next = { calls: 0, fn() { next.calls++; } };
    const res = mockRes();
    await rateLimiter(reqOf(uniqueIp()), res as unknown as express.Response, next.fn);
    expect(res.statusCode).toBe(429);
    expect(next.calls).toBe(0);
  });

  it('存储异常 → fail-closed 429（断连期间不放行）', async () => {
    setStateStoreForTest(storeWith(async () => {
      throw new Error('connect ECONNREFUSED');
    }));
    const next = { calls: 0, fn() { next.calls++; } };
    const res = mockRes();
    await rateLimiter(reqOf(uniqueIp()), res as unknown as express.Response, next.fn);
    expect(res.statusCode).toBe(429);
    expect(next.calls).toBe(0);
  });
});
