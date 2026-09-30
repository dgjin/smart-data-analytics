/**
 * v0.9.94 前端错误上报路由契约测试：必填校验（400）、事件归集（recordOpsEvent 参数）、
 * 页面实体归一（page 优先 / URL pathname 兜底 / 相对路径不炸）、字段截断、
 * 限流（独立键前缀 / 429 / 存储异常 fail-open）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, buildApp } from './routeTestKit';

/** 限流桩（用例可替换行为）；默认放行 */
let incrImpl: (key: string, ttl: number) => Promise<number>;

vi.mock('../infra/stateStore', () => ({
  getStateStore: () => ({ incrWindow: (k: string, t: number) => incrImpl(k, t) }),
}));

const recordSpy = vi.fn();
vi.mock('../infra/opsEvents', () => ({
  recordOpsEvent: (input: unknown) => recordSpy(input),
}));

import clientErrorsRoutes from './clientErrors';

applyTestEnv();

const app = buildApp('/api/ops/client-errors', clientErrorsRoutes);

/** 最近一次 recordOpsEvent 入参 */
function lastRecord(): Record<string, unknown> {
  const calls = recordSpy.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  recordSpy.mockReset();
  incrImpl = async () => 1;
});

describe('入参校验', () => {
  it('message 缺失 → 400', async () => {
    const res = await request(app).post('/api/ops/client-errors').send({ url: '/x' });
    expect(res.status).toBe(400);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('message 全空白 → 400', async () => {
    const res = await request(app).post('/api/ops/client-errors').send({ message: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('事件归集', () => {
  it('正常上报 → 200 且归集 source=client（page 实体优先）', async () => {
    const res = await request(app).post('/api/ops/client-errors').send({
      message: 'TypeError: x is not a function',
      page: 'flex-query',
      url: 'http://localhost:3000/?sso_error=1',
      source: 'assets/index-abc.js',
      lineno: 10,
      colno: 5,
      stack: 'at foo (app.js:1)',
      userAgent: 'test-UA',
      version: '0.9.94',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const arg = lastRecord();
    expect(arg.source).toBe('client');
    expect(arg.category).toBe('FRONTEND');
    expect(arg.severity).toBe('ERROR');
    expect(arg.entityType).toBe('page');
    expect(arg.entityId).toBe('flex-query');
    expect(arg.message).toBe('TypeError: x is not a function');
    const detail = arg.detail as Record<string, unknown>;
    expect(detail.stack).toBe('at foo (app.js:1)');
    expect(detail.lineno).toBe(10);
    expect(detail.version).toBe('0.9.94');
  });

  it('无 page 时实体回退 URL pathname（去 query/hash）', async () => {
    await request(app)
      .post('/api/ops/client-errors')
      .send({ message: 'e', url: 'http://localhost:3000/foo?x=1#h' });
    expect(lastRecord().entityId).toBe('/foo');
  });

  it('相对路径 URL 不炸且保留原文', async () => {
    await request(app).post('/api/ops/client-errors').send({ message: 'e', url: '/relative/path' });
    expect(lastRecord().entityId).toBe('/relative/path');
  });

  it('超长字段截断（message 500 / stack 2000）', async () => {
    await request(app)
      .post('/api/ops/client-errors')
      .send({ message: 'x'.repeat(1000), stack: 's'.repeat(5000) });
    const arg = lastRecord();
    expect((arg.message as string).length).toBe(500);
    expect(((arg.detail as Record<string, unknown>).stack as string).length).toBe(2000);
  });
});

describe('限流（独立固定分钟窗口）', () => {
  it('限流键使用独立前缀 ce:（不挤占全局 RATE_LIMIT 桶）', async () => {
    const keys: string[] = [];
    incrImpl = async (k) => {
      keys.push(k);
      return 1;
    };
    await request(app).post('/api/ops/client-errors').send({ message: 'e' });
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith('ce:')).toBe(true);
  });

  it('超过 20 次/分钟 → 429 且不再归集', async () => {
    incrImpl = async () => 21;
    const res = await request(app).post('/api/ops/client-errors').send({ message: 'e' });
    expect(res.status).toBe(429);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('限流存储异常 → fail-open 放行且正常归集', async () => {
    incrImpl = async () => {
      throw new Error('state store down');
    };
    const res = await request(app).post('/api/ops/client-errors').send({ message: 'e' });
    expect(res.status).toBe(200);
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});
