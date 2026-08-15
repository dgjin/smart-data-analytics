/**
 * P0-2 状态存储抽象：计划/缓存/限流/配额等进程内状态统一经 StateStore 访问。
 * - REDIS_URL 未配置（默认）→ MemoryStateStore，行为与历史内存实现一致，单机零依赖
 * - REDIS_URL 已配置 → RedisStateStore，多实例共享 + TTL 自动过期，支持水平扩展
 * 键命名约定：qp:（问数计划）rqp:（报表计划）qc:（问数缓存）uql:（用户配额）uqs:（并发槽）rl:（IP限流）
 */
import Redis from 'ioredis';

export interface StateStore {
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSec: number): Promise<void>;
  /** 原子读取并删除（计划一次性消费） */
  getDel(key: string): Promise<string | null>;
  /** 删除指定前缀的全部键（缓存按数据源失效、测试清理） */
  deleteByPrefix(prefix: string): Promise<number>;
  /** 固定窗口计数器：原子自增并在首次写入时设置 TTL，返回自增后的值 */
  incrWindow(key: string, ttlSec: number): Promise<number>;
  /** 分布式锁抢占：不存在时写入 token，成功返回 true */
  acquireLock(key: string, token: string, ttlSec: number): Promise<boolean>;
  /** 释放锁：仅当 token 匹配时删除（Lua 原子比对，防误删他人持有的锁） */
  releaseLock(key: string, token: string): Promise<void>;
}

// ---------- 内存实现（默认） ----------

interface MemEntry {
  value: string;
  exp: number;
}

export class MemoryStateStore implements StateStore {
  private map = new Map<string, MemEntry>();
  private counters = new Map<string, { count: number; exp: number }>();

  private read(key: string, now: number): string | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp <= now) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key, Date.now());
  }

  async setEx(key: string, value: string, ttlSec: number): Promise<void> {
    this.map.set(key, { value, exp: Date.now() + ttlSec * 1000 });
  }

  async getDel(key: string): Promise<string | null> {
    const v = this.read(key, Date.now());
    this.map.delete(key);
    return v;
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }

  async incrWindow(key: string, ttlSec: number): Promise<number> {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.exp <= now) {
      this.counters.set(key, { count: 1, exp: now + ttlSec * 1000 });
      return 1;
    }
    c.count += 1;
    return c.count;
  }

  async acquireLock(key: string, token: string, ttlSec: number): Promise<boolean> {
    const existing = this.read(key, Date.now());
    if (existing !== null) return false;
    this.map.set(key, { value: token, exp: Date.now() + ttlSec * 1000 });
    return true;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (this.read(key, Date.now()) === token) this.map.delete(key);
  }

  /** 仅供测试 */
  clear(): void {
    this.map.clear();
    this.counters.clear();
  }
}

// ---------- Redis 实现（REDIS_URL 配置时启用） ----------

/** Lua：token 匹配才删除（GET+DEL 两步有竞态，必须原子执行） */
const RELEASE_LOCK_LUA = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

export class RedisStateStore implements StateStore {
  constructor(private client: Redis) {}

  async get(key: string): Promise<string | null> {
    const v = await this.client.get(key);
    return v === null ? null : v;
  }

  async setEx(key: string, value: string, ttlSec: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSec);
  }

  async getDel(key: string): Promise<string | null> {
    // GETDEL 需 Redis 6.2+；老版本回退 GET+DEL（并发重复消费窗口极小，可接受）
    try {
      const v = await this.client.call('GETDEL', key);
      return typeof v === 'string' ? v : null;
    } catch {
      const v = await this.client.get(key);
      if (v !== null) await this.client.del(key);
      return v;
    }
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) removed += await this.client.del(...keys);
    } while (cursor !== '0');
    return removed;
  }

  async incrWindow(key: string, ttlSec: number): Promise<number> {
    const n = await this.client.incr(key);
    // 首次写入才设置 TTL；INCR 与 EXPIRE 之间的宕机窗口由 key 自然过期兜底不可接受，
    // 故 EXPIRE 失败时主动删除，避免永久键绕过窗口
    if (n === 1) {
      try {
        await this.client.expire(key, ttlSec);
      } catch {
        await this.client.del(key).catch(() => undefined);
        throw new Error('Redis 窗口计数器 TTL 设置失败');
      }
    }
    return n;
  }

  async acquireLock(key: string, token: string, ttlSec: number): Promise<boolean> {
    const r = await this.client.set(key, token, 'EX', ttlSec, 'NX');
    return r === 'OK';
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.client.eval(RELEASE_LOCK_LUA, 1, key, token);
  }
}

// ---------- 工厂（惰性单例，dotenv 时序安全） ----------

let current: StateStore | null = null;

export function getStateStore(): StateStore {
  if (!current) {
    const url = process.env.REDIS_URL;
    if (url && url.trim()) {
      const client = new Redis(url.trim(), {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 200, 3000),
      });
      client.on('error', (err) => {
        console.warn('[stateStore] Redis 连接异常:', err?.message || err);
      });
      current = new RedisStateStore(client);
    } else {
      current = new MemoryStateStore();
    }
  }
  return current;
}

/** 仅供测试：注入/重置存储实现 */
export function setStateStoreForTest(store: StateStore | null): void {
  current = store;
}

/** 当前是否启用 Redis 外置（供健康检查/文档展示） */
export function isRedisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());
}
