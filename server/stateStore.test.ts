import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MemoryStateStore,
  RedisStateStore,
  getStateStore,
  setStateStoreForTest,
  isRedisEnabled,
} from './stateStore';

describe('MemoryStateStore（默认内存实现）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setEx/get 读写与 TTL 过期', async () => {
    const s = new MemoryStateStore();
    await s.setEx('qp:1', '{"a":1}', 600);
    expect(await s.get('qp:1')).toBe('{"a":1}');
    vi.advanceTimersByTime(600 * 1000 + 1);
    expect(await s.get('qp:1')).toBeNull();
  });

  it('getDel 读取后立即删除（一次性消费）', async () => {
    const s = new MemoryStateStore();
    await s.setEx('qp:2', 'v', 60);
    expect(await s.getDel('qp:2')).toBe('v');
    expect(await s.getDel('qp:2')).toBeNull();
    expect(await s.get('qp:2')).toBeNull();
  });

  it('deleteByPrefix 仅删除匹配前缀的键', async () => {
    const s = new MemoryStateStore();
    await s.setEx('qc:ds1:a', '1', 60);
    await s.setEx('qc:ds1:b', '2', 60);
    await s.setEx('qc:ds2:a', '3', 60);
    expect(await s.deleteByPrefix('qc:ds1:')).toBe(2);
    expect(await s.get('qc:ds2:a')).toBe('3');
    expect(await s.deleteByPrefix('qc:ds1:')).toBe(0);
  });

  it('incrWindow 窗口内累加，窗口过期后重置为 1', async () => {
    const s = new MemoryStateStore();
    expect(await s.incrWindow('uql:1:bucket', 3600)).toBe(1);
    expect(await s.incrWindow('uql:1:bucket', 3600)).toBe(2);
    vi.advanceTimersByTime(3600 * 1000 + 1);
    expect(await s.incrWindow('uql:1:bucket', 3600)).toBe(1);
  });

  it('acquireLock 互斥 + releaseLock 仅 token 匹配才释放', async () => {
    const s = new MemoryStateStore();
    expect(await s.acquireLock('uqs:1', 'tokA', 900)).toBe(true);
    expect(await s.acquireLock('uqs:1', 'tokB', 900)).toBe(false);
    // 错误 token 不能释放他人持有的锁
    await s.releaseLock('uqs:1', 'tokB');
    expect(await s.acquireLock('uqs:1', 'tokC', 900)).toBe(false);
    await s.releaseLock('uqs:1', 'tokA');
    expect(await s.acquireLock('uqs:1', 'tokC', 900)).toBe(true);
  });

  it('锁 TTL 到期后自动可抢占（崩溃兜底）', async () => {
    const s = new MemoryStateStore();
    expect(await s.acquireLock('uqs:2', 'tokA', 900)).toBe(true);
    vi.advanceTimersByTime(900 * 1000 + 1);
    expect(await s.acquireLock('uqs:2', 'tokB', 900)).toBe(true);
  });
});

describe('RedisStateStore（命令参数校验，fake client 注入）', () => {
  function makeFakeClient(overrides: Record<string, (...args: any[]) => any> = {}) {
    const calls: Array<{ method: string; args: any[] }> = [];
    // override 也统一经过记录层，便于断言命令参数
    const wrap = (method: string, fn: (...args: any[]) => any) => (...args: any[]) => {
      calls.push({ method, args });
      return fn(...args);
    };
    const defaults: Record<string, (...args: any[]) => any> = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
      del: (...keys: any[]) => Promise.resolve(keys.length),
      call: () => Promise.resolve(null),
      scan: () => Promise.resolve(['0', []]),
      incr: () => Promise.resolve(1),
      expire: () => Promise.resolve(1),
      eval: () => Promise.resolve(0),
    };
    const client: Record<string, any> = {};
    for (const method of Object.keys(defaults)) {
      client[method] = wrap(method, overrides[method] ?? defaults[method]);
    }
    return { calls, client: client as any };
  }

  it('setEx → SET key value EX ttl', async () => {
    const { client, calls } = makeFakeClient();
    await new RedisStateStore(client).setEx('qp:1', '{}', 610);
    expect(calls).toEqual([{ method: 'set', args: ['qp:1', '{}', 'EX', 610] }]);
  });

  it('getDel 优先 GETDEL，失败回退 GET+DEL', async () => {
    const ok = makeFakeClient({ call: (...args: any[]) => Promise.resolve('v1') });
    expect(await new RedisStateStore(ok.client).getDel('qp:1')).toBe('v1');
    expect(ok.calls[0]).toEqual({ method: 'call', args: ['GETDEL', 'qp:1'] });

    const fallback = makeFakeClient({
      call: () => Promise.reject(new Error('unknown command')),
      get: () => Promise.resolve('v2'),
    });
    expect(await new RedisStateStore(fallback.client).getDel('qp:2')).toBe('v2');
    expect(fallback.calls.map((c) => c.method)).toEqual(['call', 'get', 'del']);
  });

  it('incrWindow 首次自增设置 TTL，后续不再 EXPIRE', async () => {
    const { client, calls } = makeFakeClient({
      incr: (() => {
        let n = 0;
        return () => Promise.resolve(++n);
      })(),
    });
    const s = new RedisStateStore(client);
    expect(await s.incrWindow('uql:1:b', 3700)).toBe(1);
    expect(await s.incrWindow('uql:1:b', 3700)).toBe(2);
    expect(calls.filter((c) => c.method === 'expire')).toEqual([
      { method: 'expire', args: ['uql:1:b', 3700] },
    ]);
  });

  it('incrWindow EXPIRE 失败时删除键并抛错（防永久键绕过窗口）', async () => {
    const { client, calls } = makeFakeClient({
      incr: () => Promise.resolve(1),
      expire: () => Promise.reject(new Error('conn lost')),
    });
    await expect(new RedisStateStore(client).incrWindow('k', 60)).rejects.toThrow('TTL');
    expect(calls.some((c) => c.method === 'del' && c.args[0] === 'k')).toBe(true);
  });

  it('acquireLock → SET NX EX，OK 视为抢占成功', async () => {
    const won = makeFakeClient({ set: () => Promise.resolve('OK') });
    expect(await new RedisStateStore(won.client).acquireLock('uqs:1', 'tok', 900)).toBe(true);
    expect(won.calls[0].args).toEqual(['uqs:1', 'tok', 'EX', 900, 'NX']);

    const lost = makeFakeClient({ set: () => Promise.resolve(null) });
    expect(await new RedisStateStore(lost.client).acquireLock('uqs:1', 'tok', 900)).toBe(false);
  });

  it('releaseLock → Lua compare-and-del（传 key 与 token）', async () => {
    const { client, calls } = makeFakeClient();
    await new RedisStateStore(client).releaseLock('uqs:1', 'tokA');
    expect(calls[0].method).toBe('eval');
    const [lua, numKeys, key, token] = calls[0].args;
    expect(lua).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
    expect([numKeys, key, token]).toEqual([1, 'uqs:1', 'tokA']);
  });

  it('deleteByPrefix → SCAN MATCH 循环 + DEL 汇总删除数', async () => {
    const scanResults: Array<[string, string[]]> = [
      ['7', ['qc:ds1:a', 'qc:ds1:b']],
      ['0', ['qc:ds1:c']],
    ];
    const { client, calls } = makeFakeClient({
      scan: () => Promise.resolve(scanResults.shift() ?? ['0', []]),
      del: (...keys: any[]) => Promise.resolve(keys.length),
    });
    expect(await new RedisStateStore(client).deleteByPrefix('qc:ds1:')).toBe(3);
    expect(calls.filter((c) => c.method === 'scan')).toHaveLength(2);
    expect(calls[0].args.slice(0, 3)).toEqual(['0', 'MATCH', 'qc:ds1:*']);
  });
});

describe('工厂与开关', () => {
  afterEach(() => {
    setStateStoreForTest(null);
    delete process.env.REDIS_URL;
  });

  it('未配置 REDIS_URL 时默认内存实现且 isRedisEnabled=false', () => {
    delete process.env.REDIS_URL;
    setStateStoreForTest(null);
    expect(isRedisEnabled()).toBe(false);
    expect(getStateStore()).toBeInstanceOf(MemoryStateStore);
  });

  it('setStateStoreForTest 可注入替身并在重置后重建', () => {
    const fake = new MemoryStateStore();
    setStateStoreForTest(fake);
    expect(getStateStore()).toBe(fake);
    setStateStoreForTest(null);
    expect(getStateStore()).not.toBe(fake);
  });

  it('isRedisEnabled 仅认非空 REDIS_URL', () => {
    process.env.REDIS_URL = '   ';
    expect(isRedisEnabled()).toBe(false);
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    expect(isRedisEnabled()).toBe(true);
  });
});
