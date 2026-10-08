/**
 * PWA Service Worker 注册模块单测：环境判断、注册参数、失败静默。
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker, shouldRegisterServiceWorker } from './register';

/** 注入/移除 navigator.serviceWorker（jsdom 不实现 ServiceWorker API） */
function stubServiceWorker(value: { register?: unknown; getRegistrations?: unknown } | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  } else {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value });
  }
}

afterEach(() => {
  stubServiceWorker(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shouldRegisterServiceWorker', () => {
  it('非生产环境不注册', () => {
    expect(shouldRegisterServiceWorker(false)).toBe(false);
  });

  it('环境不支持 serviceWorker 时返回 false', () => {
    expect(shouldRegisterServiceWorker(true)).toBe(false);
  });

  it('生产环境且支持 serviceWorker 时返回 true', () => {
    stubServiceWorker({});
    expect(shouldRegisterServiceWorker(true)).toBe(true);
  });
});

describe('registerServiceWorker', () => {
  it('非生产环境直接返回，不注册也不监听 load', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const register = vi.fn();
    stubServiceWorker({ register });
    registerServiceWorker(false);
    expect(addSpy).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('非生产环境自愈：注销遗留 SW 注册并清空 CacheStorage', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }, { unregister }]);
    const cachesStub = {
      keys: vi.fn().mockResolvedValue(['nl2sql-app-v1']),
      delete: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal('caches', cachesStub);
    stubServiceWorker({ register: vi.fn(), getRegistrations });

    registerServiceWorker(false);

    await vi.waitFor(() => {
      expect(getRegistrations).toHaveBeenCalled();
      expect(unregister).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(cachesStub.delete).toHaveBeenCalledWith('nl2sql-app-v1');
    });
  });

  it('非生产环境无注册管理 API / 清理失败时静默（不抛错、不影响启动）', () => {
    stubServiceWorker({ register: vi.fn() });
    expect(() => registerServiceWorker(false)).not.toThrow();
  });

  it('生产环境在 load 后以根路径 scope 注册 /sw.js 并探测一次更新', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ update });
    stubServiceWorker({ register });
    registerServiceWorker(true);
    window.dispatchEvent(new Event('load'));
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalled();
    });
  });

  it('注册失败时静默（不抛错、无未处理拒绝）', async () => {
    const register = vi.fn().mockRejectedValue(new Error('insecure context'));
    stubServiceWorker({ register });
    registerServiceWorker(true);
    window.dispatchEvent(new Event('load'));
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalled();
    });
  });
});
