/**
 * P1-2 优雅停机：收到 SIGTERM/SIGINT 后按 drain 序列退场，避免部署/重启时截断在途请求。
 *
 * 序列：beforeClose（停任务 worker，不再领新活）
 *      → server.close（停止接收新连接）+ closeIdleConnections（立即回收空闲 keep-alive）
 *      → 等待在途请求自然结束（限时 SHUTDOWN_TIMEOUT_MS）
 *      → 超时则 closeAllConnections 强杀残余连接
 *      → closeResources（关闭 MySQL 连接池等）
 *      → exit(0)。
 *
 * 二次信号放弃 drain 立即退出（防止部署管道卡死）；drain 期间 isDraining=true，
 * 健康检查据此返回 503 让上游把流量摘走。
 */
import { logger } from './logger';

/** 最小可停机 server 接口（http.Server 结构兼容；便于测试注入 mock） */
export interface ClosableServer {
  close(callback: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ShutdownDeps {
  server: ClosableServer;
  /** drain 前置步骤：停止后台领取器（任务 worker 等）；抛错不阻断后续步骤 */
  beforeClose?: () => void | Promise<void>;
  /** drain 后置步骤：关闭资源（连接池等）；抛错不阻断退出 */
  closeResources?: () => void | Promise<void>;
  /** drain 总限时（ms）；默认读 SHUTDOWN_TIMEOUT_MS，区间 [1000, 120000]，缺省 10000 */
  timeoutMs?: number;
  /** 退出函数（测试注入；默认 process.exit） */
  exit?: (code: number) => void;
  /** 日志函数（测试注入；默认 logger.info） */
  log?: (msg: string) => void;
}

export interface ShutdownController {
  /** 触发一次优雅停机（幂等：draining 中重复调用直接返回） */
  trigger: (signal?: string) => Promise<void>;
  /** 是否处于 drain 中（健康检查用） */
  isDraining: () => boolean;
}

/** SHUTDOWN_TIMEOUT_MS 解析（非法值回退 10s；下限 1s、上限 120s 保护） */
export function shutdownTimeoutMs(): number {
  const n = Number(process.env.SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.min(120_000, Math.floor(n)) : 10_000;
}

export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  let draining = false;
  const timeoutMs = deps.timeoutMs ?? shutdownTimeoutMs();
  const log = deps.log ?? ((msg: string) => logger.info(msg));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const safeRun = async (step: (() => void | Promise<void>) | undefined, label: string) => {
    if (!step) return;
    try {
      await step();
    } catch (err: any) {
      log(`[Shutdown] ${label} 执行失败（继续停机）：${err?.message || err}`);
    }
  };

  async function run(signal: string): Promise<void> {
    log(`[Shutdown] 收到 ${signal}，开始优雅停机（排空限时 ${timeoutMs}ms）`);

    // 1. 停止后台领取器：不再接新任务（在途任务由孤儿心跳回收兜底）
    await safeRun(deps.beforeClose, 'beforeClose');

    // 2. 停止接收新连接；close 回调在所有连接结束后触发
    const closed = new Promise<'closed'>((resolve) => {
      try {
        deps.server.close(() => resolve('closed'));
      } catch {
        resolve('closed');
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    // 空闲 keep-alive 连接会阻塞 close 回调，立即回收让排空只等真实在途请求
    deps.server.closeIdleConnections?.();

    // 3. 限时等待在途请求结束
    const outcome = await Promise.race([closed, timedOut]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      log(`[Shutdown] 在途请求 ${timeoutMs}ms 未排空，强制关闭剩余连接`);
      deps.server.closeAllConnections?.();
    }

    // 4. 关闭资源（连接池）后退出；exit 兜底防止遗漏句柄阻塞进程自然退出
    await safeRun(deps.closeResources, 'closeResources');
    log('[Shutdown] 停机完成');
    exit(0);
  }

  return {
    isDraining: () => draining,
    trigger: (signal = 'SIGTERM') => {
      if (draining) return Promise.resolve();
      draining = true;
      return run(signal);
    },
  };
}

/**
 * 注册 SIGTERM/SIGINT 信号处理器；返回 dispose 移除监听（测试与重复安装场景）。
 * 首次信号走完整 drain；drain 期间再次收到信号放弃排空立即 exit(1)。
 */
export function installGracefulShutdown(deps: ShutdownDeps): { controller: ShutdownController; dispose: () => void } {
  const controller = createShutdownController(deps);
  const log = deps.log ?? ((msg: string) => logger.info(msg));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const onSignal = (signal: NodeJS.Signals) => {
    if (controller.isDraining()) {
      log(`[Shutdown] 再次收到 ${signal}，放弃排空立即退出`);
      exit(1);
      return;
    }
    void controller.trigger(signal);
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return {
    controller,
    dispose: () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    },
  };
}
