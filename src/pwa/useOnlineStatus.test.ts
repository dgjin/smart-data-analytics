/**
 * 在线状态 Hook 单测：online/offline 事件切换与卸载清理。
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useOnlineStatus } from './useOnlineStatus';

afterEach(cleanup);

describe('useOnlineStatus', () => {
  it('初始状态取 navigator.onLine（jsdom 默认在线）', () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it('offline / online 事件驱动状态切换', () => {
    const { result } = renderHook(() => useOnlineStatus());
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });

  it('卸载后事件不再影响状态（监听器已清理）', () => {
    const { result, unmount } = renderHook(() => useOnlineStatus());
    unmount();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(true);
  });
});
