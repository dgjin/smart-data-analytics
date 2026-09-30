/**
 * v0.9.93 链路上下文单测：AsyncLocalStorage 建立/继承/原地补充/异步传播/并发隔离。
 */
import { describe, it, expect } from 'vitest';
import { runWithLogContext, updateLogContext, getLogContext } from './asyncContext';

describe('asyncContext：日志链路上下文', () => {
  it('未包裹时 getLogContext 返回 undefined（孤儿异步安全）', () => {
    expect(getLogContext()).toBeUndefined();
  });

  it('runWithLogContext 建立上下文并贯穿异步链（await 之后仍可见）', async () => {
    const seen = await runWithLogContext({ requestId: 'r1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getLogContext();
    });
    expect(seen?.requestId).toBe('r1');
  });

  it('嵌套时继承父字段并覆盖同名键（请求链内派发任务：requestId+taskId 并存）', () => {
    runWithLogContext({ requestId: 'r1', userId: 7 }, () => {
      runWithLogContext({ taskId: 't1' }, () => {
        expect(getLogContext()).toEqual({ requestId: 'r1', userId: 7, taskId: 't1' });
      });
    });
  });

  it('updateLogContext 在当前上下文原地补充（鉴权后注入用户身份）', () => {
    runWithLogContext({ requestId: 'r2' }, () => {
      updateLogContext({ userId: 9, username: 'alice' });
      expect(getLogContext()).toEqual({ requestId: 'r2', userId: 9, username: 'alice' });
    });
  });

  it('无上下文时 updateLogContext 静默忽略', () => {
    expect(() => updateLogContext({ userId: 1 })).not.toThrow();
  });

  it('并发上下文互不串扰', async () => {
    const [a, b] = await Promise.all([
      runWithLogContext({ requestId: 'ra' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getLogContext()?.requestId;
      }),
      runWithLogContext({ requestId: 'rb' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getLogContext()?.requestId;
      }),
    ]);
    expect(a).toBe('ra');
    expect(b).toBe('rb');
  });
});
