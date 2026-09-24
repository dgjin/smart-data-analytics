/**
 * PWA 安装能力 Hook 单测：事件暂存、prompt 消费、已安装隐藏。
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStandaloneDisplay, usePwaInstall } from './usePwaInstall';

/** 构造 Chrome beforeinstallprompt 事件替身（含 prompt/userChoice） */
function createPromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome }) });
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('usePwaInstall', () => {
  it('未触发 beforeinstallprompt 时不可安装（按钮隐藏）', () => {
    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.canInstall).toBe(false);
  });

  it('beforeinstallprompt 触发后可安装（并阻止 Chrome 默认迷你信息条）', () => {
    const { result } = renderHook(() => usePwaInstall());
    const event = createPromptEvent();
    const preventSpy = vi.spyOn(event, 'preventDefault');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(preventSpy).toHaveBeenCalled();
    expect(result.current.canInstall).toBe(true);
  });

  it('点击安装调用 prompt 并消费事件（accepted 后按钮隐藏）', async () => {
    const { result } = renderHook(() => usePwaInstall());
    const event = createPromptEvent('accepted');
    act(() => {
      window.dispatchEvent(event);
    });
    await act(async () => {
      await result.current.promptInstall();
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(false);
  });

  it('dismissed 后同样消费本次事件（等待 Chrome 冷却期结束后的下次事件）', async () => {
    const { result } = renderHook(() => usePwaInstall());
    act(() => {
      window.dispatchEvent(createPromptEvent('dismissed'));
    });
    await act(async () => {
      await result.current.promptInstall();
    });
    expect(result.current.canInstall).toBe(false);
  });

  it('appinstalled 事件后入口不再显示', () => {
    const { result } = renderHook(() => usePwaInstall());
    act(() => {
      window.dispatchEvent(createPromptEvent());
    });
    expect(result.current.canInstall).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.canInstall).toBe(false);
  });

  it('standalone 显示模式（已安装）下初始即隐藏，且忽略后续 beforeinstallprompt', () => {
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    expect(isStandaloneDisplay()).toBe(true);
    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.canInstall).toBe(false);
    act(() => {
      window.dispatchEvent(createPromptEvent());
    });
    expect(result.current.canInstall).toBe(false);
  });

  it('prompt 抛错时静默且按钮保留（可再次尝试）', async () => {
    const { result } = renderHook(() => usePwaInstall());
    const event = createPromptEvent();
    event.prompt = vi.fn().mockRejectedValue(new Error('event expired'));
    act(() => {
      window.dispatchEvent(event);
    });
    await act(async () => {
      await result.current.promptInstall();
    });
    // 事件未被消费（抛错路径不置空）：按钮保留
    expect(result.current.canInstall).toBe(true);
  });
});
