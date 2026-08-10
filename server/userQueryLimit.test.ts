import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkUserQueryLimit,
  acquireQuerySlot,
  releaseQuerySlot,
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

  it('窗口内前 20 次通过，第 21 次拒绝并给出重试提示', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect(checkUserQueryLimit(1, t0 + i).ok).toBe(true);
    }
    const denied = checkUserQueryLimit(1, t0 + 20);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('20');
    expect(denied.reason).toContain('分钟后再试');
  });

  it('拒绝时不额外计数', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) checkUserQueryLimit(1, t0);
    expect(checkUserQueryLimit(1, t0).ok).toBe(false);
    expect(checkUserQueryLimit(1, t0).ok).toBe(false);
    // 窗口滑过后即可恢复（若拒绝被计数，恢复时间会被推迟）
    const t1 = t0 + 60 * 60 * 1000 + 1;
    expect(checkUserQueryLimit(1, t1).ok).toBe(true);
  });

  it('滑动窗口：一小时前的记录不再计入', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) checkUserQueryLimit(1, t0 + i * 1000);
    const t1 = t0 + 60 * 60 * 1000 + 1;
    expect(checkUserQueryLimit(1, t1).ok).toBe(true);
  });

  it('不同用户配额互相独立', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) checkUserQueryLimit(1, t0);
    expect(checkUserQueryLimit(1, t0).ok).toBe(false);
    expect(checkUserQueryLimit(2, t0).ok).toBe(true);
  });

  it('USER_QUERY_RATE_MAX 环境变量可调整上限', () => {
    process.env.USER_QUERY_RATE_MAX = '3';
    const t0 = 1_000_000;
    expect(checkUserQueryLimit(1, t0).ok).toBe(true);
    expect(checkUserQueryLimit(1, t0 + 1).ok).toBe(true);
    expect(checkUserQueryLimit(1, t0 + 2).ok).toBe(true);
    expect(checkUserQueryLimit(1, t0 + 3).ok).toBe(false);
  });
});

describe('acquireQuerySlot / releaseQuerySlot（L5 频率层：同用户并发限 1）', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('同用户并发第二次获取失败，释放后恢复', () => {
    expect(acquireQuerySlot(1)).toBe(true);
    expect(acquireQuerySlot(1)).toBe(false);
    releaseQuerySlot(1);
    expect(acquireQuerySlot(1)).toBe(true);
  });

  it('不同用户并发互不影响', () => {
    expect(acquireQuerySlot(1)).toBe(true);
    expect(acquireQuerySlot(2)).toBe(true);
    releaseQuerySlot(1);
    releaseQuerySlot(2);
  });

  it('重复释放不产生副作用', () => {
    expect(acquireQuerySlot(1)).toBe(true);
    releaseQuerySlot(1);
    releaseQuerySlot(1);
    expect(acquireQuerySlot(1)).toBe(true);
  });
});
