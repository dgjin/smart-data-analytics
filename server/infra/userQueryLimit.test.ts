import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkUserQueryLimit,
  acquireQuerySlot,
  releaseQuerySlot,
  SLOT_TTL_SEC,
  _resetForTest,
} from './userQueryLimit';

describe('checkUserQueryLimit（L5 频率层：20 次/小时滑动窗口）', () => {
  beforeEach(() => {
    _resetForTest();
    delete process.env.USER_QUERY_RATE_MAX;
  });

  afterEach(() => {
    delete process.env.USER_QUERY_RATE_MAX;
  });

  it('窗口内前 20 次通过，第 21 次拒绝并给出重试提示', async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect((await checkUserQueryLimit(1, t0 + i)).ok).toBe(true);
    }
    const denied = await checkUserQueryLimit(1, t0 + 20);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('20');
    expect(denied.reason).toContain('分钟后再试');
  });

  it('拒绝时不额外计数', async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) await checkUserQueryLimit(1, t0);
    expect((await checkUserQueryLimit(1, t0)).ok).toBe(false);
    expect((await checkUserQueryLimit(1, t0)).ok).toBe(false);
    // 窗口滑过后即可恢复（若拒绝被计数，恢复时间会被推迟）
    const t1 = t0 + 60 * 60 * 1000 + 1;
    expect((await checkUserQueryLimit(1, t1)).ok).toBe(true);
  });

  it('滑动窗口：一小时前的记录不再计入', async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) await checkUserQueryLimit(1, t0 + i * 1000);
    const t1 = t0 + 60 * 60 * 1000 + 1;
    expect((await checkUserQueryLimit(1, t1)).ok).toBe(true);
  });

  it('不同用户配额互相独立', async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) await checkUserQueryLimit(1, t0);
    expect((await checkUserQueryLimit(1, t0)).ok).toBe(false);
    expect((await checkUserQueryLimit(2, t0)).ok).toBe(true);
  });

  it('USER_QUERY_RATE_MAX 环境变量可调整上限', async () => {
    process.env.USER_QUERY_RATE_MAX = '3';
    const t0 = 1_000_000;
    expect((await checkUserQueryLimit(1, t0)).ok).toBe(true);
    expect((await checkUserQueryLimit(1, t0 + 1)).ok).toBe(true);
    expect((await checkUserQueryLimit(1, t0 + 2)).ok).toBe(true);
    expect((await checkUserQueryLimit(1, t0 + 3)).ok).toBe(false);
  });
});

describe('acquireQuerySlot / releaseQuerySlot（L5 频率层：同用户并发限 1）', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('同用户并发第二次获取失败，释放后恢复', async () => {
    expect(await acquireQuerySlot(1)).toBe(true);
    expect(await acquireQuerySlot(1)).toBe(false);
    await releaseQuerySlot(1);
    expect(await acquireQuerySlot(1)).toBe(true);
  });

  it('不同用户并发互不影响', async () => {
    expect(await acquireQuerySlot(1)).toBe(true);
    expect(await acquireQuerySlot(2)).toBe(true);
    await releaseQuerySlot(1);
    await releaseQuerySlot(2);
  });

  it('重复释放不产生副作用', async () => {
    expect(await acquireQuerySlot(1)).toBe(true);
    await releaseQuerySlot(1);
    await releaseQuerySlot(1);
    expect(await acquireQuerySlot(1)).toBe(true);
  });
});

describe('并发槽 token 化与 TTL 兜底（客户端断开提前释放场景）', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('释放时 token 不匹配则不生效（防旧请求误删新请求的槽）', async () => {
    expect(await acquireQuerySlot(1, 'tokenA')).toBe(true);
    await releaseQuerySlot(1, 'tokenB'); // 错误 token：无效
    expect(await acquireQuerySlot(1, 'tokenC')).toBe(false); // 槽仍被 tokenA 占用
    await releaseQuerySlot(1, 'tokenA'); // 正确 token：生效
    expect(await acquireQuerySlot(1, 'tokenC')).toBe(true);
  });

  it('槽超过 TTL 视为过期，新请求可重入（对齐 Redis 模式兜底）', async () => {
    const t0 = 1_000_000_000;
    expect(await acquireQuerySlot(1, 'old', t0)).toBe(true);
    // 未过期：拒绝重入
    expect(await acquireQuerySlot(1, 'new', t0 + SLOT_TTL_SEC * 1000 - 1)).toBe(false);
    // 已过期：视为空闲，允许重入
    expect(await acquireQuerySlot(1, 'new', t0 + SLOT_TTL_SEC * 1000)).toBe(true);
  });

  it('旧请求断开提前释放后跑完 finally，不会误删新请求的槽', async () => {
    expect(await acquireQuerySlot(1, 'old')).toBe(true);
    await releaseQuerySlot(1, 'old'); // 模拟 res.on('close') 客户端断开提前释放
    expect(await acquireQuerySlot(1, 'new')).toBe(true); // 用户立即重试成功
    await releaseQuerySlot(1, 'old'); // 旧链路跑完 finally 再释放：token 不匹配 → no-op
    expect(await acquireQuerySlot(1, 'third')).toBe(false); // 新请求的槽仍被正确占用
  });
});
