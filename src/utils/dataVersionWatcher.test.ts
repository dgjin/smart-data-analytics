import { describe, expect, it } from 'vitest';
import { DataVersionWatcher } from './dataVersionWatcher';

describe('DataVersionWatcher: 数据版本变化检测状态机（v0.4.8 自主更新）', () => {
  it('首次 feed 仅建立基线不触发', () => {
    const w = new DataVersionWatcher();
    expect(w.feed('v1')).toBe(false);
    expect(w.current).toBe('v1');
  });

  it('版本相同不触发', () => {
    const w = new DataVersionWatcher();
    w.feed('v1');
    expect(w.feed('v1')).toBe(false);
  });

  it('版本不同触发变化并把基线推进到新版本', () => {
    const w = new DataVersionWatcher();
    w.feed('v1');
    expect(w.feed('v2')).toBe(true);
    expect(w.current).toBe('v2');
    // 推进后同版本再次 feed 不再触发
    expect(w.feed('v2')).toBe(false);
  });

  it('探测失败（null）不更新基线也不触发', () => {
    const w = new DataVersionWatcher();
    w.feed('v1');
    expect(w.feed(null)).toBe(false);
    expect(w.current).toBe('v1');
    // 失败轮之后的真实变化仍能检测到
    expect(w.feed('v2')).toBe(true);
  });

  it('基线未建立时连续 null 始终不触发', () => {
    const w = new DataVersionWatcher();
    expect(w.feed(null)).toBe(false);
    expect(w.feed(null)).toBe(false);
    expect(w.current).toBeNull();
  });

  it('reset 清空基线（数据源切换/手动刷新后重建基线）', () => {
    const w = new DataVersionWatcher();
    w.feed('v1');
    w.reset();
    expect(w.current).toBeNull();
    expect(w.feed('v2')).toBe(false); // 重新建基线而非触发变化
  });
});
