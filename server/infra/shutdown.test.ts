/**
 * P1-2 优雅停机单测：drain 序列顺序、幂等、超时强杀、二次信号立即退出、限时解析。
 * 通过注入 mock server / exit / log 验证，不真起 http 服务、不真退出进程。
 */
import { describe, it, expect } from 'vitest';
import {
  createShutdownController,
  installGracefulShutdown,
  shutdownTimeoutMs,
  type ClosableServer,
} from './shutdown';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 受控 mock server：close 回调由测试显式触发，用于模拟排空快慢 */
function makeMockServer(order: string[], autoClose = false) {
  let closeCb: ((err?: Error) => void) | null = null;
  const server: ClosableServer = {
    close(cb) {
      order.push('close');
      closeCb = cb;
      if (autoClose) cb();
      return undefined;
    },
    closeIdleConnections() {
      order.push('closeIdle');
    },
    closeAllConnections() {
      order.push('closeAll');
    },
  };
  return { server, completeClose: () => closeCb?.() };
}

describe('createShutdownController 优雅停机', () => {
  it('正常排空：序为 beforeClose → close → closeIdle → closeResources → exit(0)', async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const mock = makeMockServer(order);
    const controller = createShutdownController({
      server: mock.server,
      beforeClose: () => {
        order.push('beforeClose');
      },
      closeResources: async () => {
        order.push('closeResources');
      },
      timeoutMs: 1000,
      exit: (c) => {
        exits.push(c);
        order.push('exit');
      },
      log: () => {},
    });

    expect(controller.isDraining()).toBe(false);
    const p = controller.trigger('SIGTERM');
    await tick();
    // 排空中：已停接单与空闲连接，等待在途请求（close 回调未触发）
    expect(order).toEqual(['beforeClose', 'close', 'closeIdle']);
    expect(controller.isDraining()).toBe(true);
    expect(exits).toEqual([]);

    mock.completeClose();
    await p;
    expect(order).toEqual(['beforeClose', 'close', 'closeIdle', 'closeResources', 'exit']);
    expect(exits).toEqual([0]);
  });

  it('幂等：draining 中重复 trigger 不重复执行序列', async () => {
    const order: string[] = [];
    const mock = makeMockServer(order);
    const controller = createShutdownController({
      server: mock.server,
      timeoutMs: 1000,
      exit: () => order.push('exit'),
      log: () => {},
    });

    const p = controller.trigger('SIGTERM');
    await tick();
    await controller.trigger('SIGINT'); // 第二次直接返回，不应重复 close
    expect(order.filter((x) => x === 'close')).toHaveLength(1);

    mock.completeClose();
    await p;
    expect(order.filter((x) => x === 'exit')).toHaveLength(1);
  });

  it('超时强杀：限时内未排空则 closeAllConnections 后仍会关资源并 exit(0)', async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const mock = makeMockServer(order); // close 回调永不触发 → 模拟慢请求
    const controller = createShutdownController({
      server: mock.server,
      closeResources: async () => {
        order.push('closeResources');
      },
      timeoutMs: 20,
      exit: (c) => exits.push(c),
      log: () => {},
    });

    await controller.trigger('SIGTERM');
    expect(order).toEqual(['close', 'closeIdle', 'closeAll', 'closeResources']);
    expect(exits).toEqual([0]);
  });

  it('步骤抛错不阻断停机：beforeClose/closeResources 失败仍退出', async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const mock = makeMockServer(order);
    const controller = createShutdownController({
      server: mock.server,
      beforeClose: () => {
        throw new Error('worker stop boom');
      },
      closeResources: () => Promise.reject(new Error('pool boom')),
      timeoutMs: 1000,
      exit: (c) => exits.push(c),
      log: () => {},
    });

    const p = controller.trigger('SIGTERM');
    await tick();
    mock.completeClose();
    await p;
    expect(exits).toEqual([0]);
  });
});

describe('installGracefulShutdown 信号接线', () => {
  it('首次信号启动 drain，drain 期间二次信号立即 exit(1)', async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const mock = makeMockServer(order); // close 不自动回调 → 保持 draining
    const { controller, dispose } = installGracefulShutdown({
      server: mock.server,
      timeoutMs: 5000,
      exit: (c) => exits.push(c),
      log: () => {},
    });

    try {
      process.emit('SIGTERM');
      await tick();
      expect(controller.isDraining()).toBe(true);
      expect(exits).toEqual([]); // drain 未完成，无退出

      process.emit('SIGINT');
      expect(exits).toEqual([1]); // 二次信号放弃排空立即退出
    } finally {
      mock.completeClose(); // 收尾挂起的 drain（时序：close 已注册回调）
      await tick();
      dispose();
    }
  });

  it('dispose 后信号不再触发 drain', async () => {
    const mock = makeMockServer([], true);
    const exits: number[] = [];
    const { controller, dispose } = installGracefulShutdown({
      server: mock.server,
      timeoutMs: 1000,
      exit: (c) => exits.push(c),
      log: () => {},
    });
    dispose();
    process.emit('SIGTERM');
    await tick();
    expect(controller.isDraining()).toBe(false);
    expect(exits).toEqual([]);
  });
});

describe('shutdownTimeoutMs 环境变量解析', () => {
  it('缺省 10s；非法值回退；越界钳制到 [1000, 120000]', () => {
    const saved = process.env.SHUTDOWN_TIMEOUT_MS;
    try {
      delete process.env.SHUTDOWN_TIMEOUT_MS;
      expect(shutdownTimeoutMs()).toBe(10_000);
      process.env.SHUTDOWN_TIMEOUT_MS = 'abc';
      expect(shutdownTimeoutMs()).toBe(10_000);
      process.env.SHUTDOWN_TIMEOUT_MS = '500';
      expect(shutdownTimeoutMs()).toBe(10_000); // 低于下限视为非法
      process.env.SHUTDOWN_TIMEOUT_MS = '30000';
      expect(shutdownTimeoutMs()).toBe(30_000);
      process.env.SHUTDOWN_TIMEOUT_MS = '999999';
      expect(shutdownTimeoutMs()).toBe(120_000); // 上限保护
    } finally {
      if (saved === undefined) delete process.env.SHUTDOWN_TIMEOUT_MS;
      else process.env.SHUTDOWN_TIMEOUT_MS = saved;
    }
  });
});
