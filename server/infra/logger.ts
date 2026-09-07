/**
 * P1-2 统一日志出口：服务端运行时代码一律经 logger 输出，替代散落的 console.*。
 * - 级别由 LOG_LEVEL 控制（debug/info/warn/error，默认 info），进程启动时读取一次（重启生效）
 * - error 级恒输出；warn 及以上在 test 环境静默（VITEST/NODE_ENV=test），避免单测噪音
 * - 底层仍走 console（零依赖）；未来引入 pino 等结构化日志设施时仅需替换本文件实现
 * - eval/ 下 CLI 脚本刻意保留 console（命令行输出即用户界面），不走本封装
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL || '').trim().toLowerCase();
  return raw in LEVELS ? LEVELS[raw as Level] : LEVELS.info;
}

const threshold = resolveThreshold();
const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';

function enabled(level: Level): boolean {
  if (LEVELS[level] < threshold) return false;
  // test 环境只保留 error（单测断言不依赖日志输出；warn/info 刷屏干扰用例定位）
  if (isTest && LEVELS[level] < LEVELS.error) return false;
  return true;
}

export const logger = {
  debug(msg: unknown, ...args: unknown[]): void {
    if (enabled('debug')) console.debug(msg, ...args);
  },
  info(msg: unknown, ...args: unknown[]): void {
    if (enabled('info')) console.log(msg, ...args);
  },
  warn(msg: unknown, ...args: unknown[]): void {
    if (enabled('warn')) console.warn(msg, ...args);
  },
  error(msg: unknown, ...args: unknown[]): void {
    if (enabled('error')) console.error(msg, ...args);
  },
};
