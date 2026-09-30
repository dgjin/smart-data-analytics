/**
 * 前端错误上报测试：错误事件 → sendBeacon 上报（payload 字段）、unhandledrejection 归集、
 * getPage 注入、同键去重、每分钟上限、资源错误跳过、sendBeacon 不可用回退 fetch、reset 复位。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initClientErrorReporting,
  resetClientErrorReporterForTest,
} from './clientErrorReporter';

/** Blob 替身：直接暴露构造入参，便于同步断言 payload 内容（jsdom Blob 无 text()） */
class FakeBlob {
  constructor(
    public parts: unknown[],
    public options?: { type?: string }
  ) {}
  get type(): string {
    return this.options?.type || '';
  }
}
vi.stubGlobal('Blob', FakeBlob as unknown as typeof Blob);

let beaconSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

function payloadAt(i: number): Record<string, unknown> {
  const blob = beaconSpy.mock.calls[i][1] as unknown as FakeBlob;
  return JSON.parse(String(blob.parts[0])) as Record<string, unknown>;
}

function fireError(
  message: string,
  extra: { filename?: string; lineno?: number; colno?: number; error?: Error } = {}
): void {
  window.dispatchEvent(
    new ErrorEvent('error', {
      message,
      filename: extra.filename || 'http://localhost/assets/index.js',
      lineno: extra.lineno ?? 1,
      colno: extra.colno ?? 2,
      error: extra.error,
    })
  );
}

function fireRejection(reason: unknown): void {
  const ev = new Event('unhandledrejection');
  Object.assign(ev, { reason });
  window.dispatchEvent(ev);
}

beforeEach(() => {
  resetClientErrorReporterForTest();
  beaconSpy = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', {
    value: beaconSpy,
    configurable: true,
    writable: true,
  });
  fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  resetClientErrorReporterForTest();
});

describe('全局错误钩子', () => {
  it('window error → sendBeacon 上报（字段完整）', () => {
    initClientErrorReporting();
    fireError('TypeError: x is not a function', { lineno: 10, colno: 5, error: new Error('TypeError: x is not a function') });
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(beaconSpy.mock.calls[0][0]).toBe('/api/ops/client-errors');
    const payload = payloadAt(0);
    expect(payload.message).toBe('TypeError: x is not a function');
    expect(payload.lineno).toBe(10);
    expect(payload.colno).toBe(5);
    expect(typeof payload.stack).toBe('string');
    expect(typeof payload.url).toBe('string');
    expect(typeof payload.userAgent).toBe('string');
  });

  it('资源加载错误（无 message）不上报', () => {
    initClientErrorReporting();
    window.dispatchEvent(new Event('error'));
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('重复 init 幂等（不重复上报）', () => {
    initClientErrorReporting();
    initClientErrorReporting();
    fireError('boom');
    expect(beaconSpy).toHaveBeenCalledTimes(1);
  });
});

describe('unhandledrejection', () => {
  it('Error 原因 → 上报 name: message', () => {
    initClientErrorReporting();
    fireRejection(new Error('async boom'));
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(payloadAt(0).message).toBe('Error: async boom');
  });

  it('非 Error 原因 → 字符串化后上报', () => {
    initClientErrorReporting();
    fireRejection('string reason');
    expect(payloadAt(0).message).toBe('Unhandled rejection: string reason');
  });
});

describe('getPage 注入与限速', () => {
  it('getPage 返回值进入 payload.page', () => {
    initClientErrorReporting({ getPage: () => 'flexquery' });
    fireError('boom');
    expect(payloadAt(0).page).toBe('flexquery');
  });

  it('同键错误 5 分钟内只报一次（page 参与去重键）', () => {
    initClientErrorReporting({ getPage: () => 'query' });
    fireError('boom');
    fireError('boom');
    expect(beaconSpy).toHaveBeenCalledTimes(1);
  });

  it('不同 message 各自计数', () => {
    initClientErrorReporting();
    fireError('boom-1');
    fireError('boom-2');
    expect(beaconSpy).toHaveBeenCalledTimes(2);
  });

  it('每分钟总量上限 10 条', () => {
    initClientErrorReporting();
    for (let i = 0; i < 12; i++) fireError(`err-${i}`);
    expect(beaconSpy).toHaveBeenCalledTimes(10);
  });
});

describe('通道回退', () => {
  it('sendBeacon 不可用 → 回退 fetch keepalive', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true });
    initClientErrorReporting();
    fireError('fallback boom');
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ops/client-errors');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
  });

  it('reset 后可重新初始化并接收新事件', () => {
    initClientErrorReporting();
    fireError('first');
    resetClientErrorReporterForTest();
    initClientErrorReporting();
    fireError('second');
    expect(beaconSpy).toHaveBeenCalledTimes(2);
    expect(payloadAt(1).message).toBe('second');
  });
});
