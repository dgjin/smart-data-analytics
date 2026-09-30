/**
 * v0.9.94 访问日志降噪单测：轮询端点前缀判定（默认/自定义/关闭）与 info/debug 分级落盘、
 * 非 /api 路径不记录。mock logger 断言分级，不经真实 IO。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';
import { requestLogger, shouldQuietPath } from './requestLogger';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const infoSpy = vi.mocked(logger.info);
const debugSpy = vi.mocked(logger.debug);

/** 以替身 req/res 走一遍中间件并手动触发 finish 回调（不经真实 http 服务） */
function emitFinish(method: string, path: string): void {
  const finishCbs: Array<() => void> = [];
  const req = { method, path, originalUrl: path, user: undefined } as unknown as Request;
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    on: (event: string, cb: () => void) => {
      if (event === 'finish') finishCbs.push(cb);
    },
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  requestLogger(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  for (const cb of finishCbs) cb();
}

beforeEach(() => {
  infoSpy.mockClear();
  debugSpy.mockClear();
  delete process.env.LOG_QUIET_PATHS;
});

afterEach(() => {
  delete process.env.LOG_QUIET_PATHS;
});

describe('shouldQuietPath：降噪路径判定', () => {
  it('默认列表命中轮询端点前缀（含子路径），常规端点不命中', () => {
    expect(shouldQuietPath('/api/health')).toBe(true);
    expect(shouldQuietPath('/api/health/deep')).toBe(true);
    expect(shouldQuietPath('/api/system/models')).toBe(true);
    expect(shouldQuietPath('/api/query')).toBe(false);
  });

  it('LOG_QUIET_PATHS 自定义覆盖默认列表（兼容空格分隔）', () => {
    process.env.LOG_QUIET_PATHS = '/api/poll, /api/status';
    expect(shouldQuietPath('/api/poll')).toBe(true);
    expect(shouldQuietPath('/api/status')).toBe(true);
    expect(shouldQuietPath('/api/health')).toBe(false);
  });

  it('空串 = 关闭降噪（无任何路径命中）', () => {
    process.env.LOG_QUIET_PATHS = '';
    expect(shouldQuietPath('/api/health')).toBe(false);
  });
});

describe('requestLogger：分级落盘', () => {
  it('轮询端点访问日志降为 debug（info 不落盘）', () => {
    emitFinish('GET', '/api/health');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0][0])).toContain('[HTTP] GET /api/health -> 200');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('常规端点访问日志保持 info', () => {
    emitFinish('POST', '/api/query');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0][0])).toContain('[HTTP] POST /api/query -> 200');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('非 /api 路径不记录', () => {
    emitFinish('GET', '/assets/index.js');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
