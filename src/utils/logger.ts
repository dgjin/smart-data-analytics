/**
 * 前端统一日志出口（阶段5 console 治理）：
 * 组件/hooks、前端工具一律经本模块输出，替代散落的 console.*——
 * 单一出口便于后续接入上报采样/降噪策略；本文件是 src 侧唯一允许直连 console 的位置
 * （eslint no-console 永久豁免，见 eslint.config.js）。
 * - debug/info 仅开发构建输出（生产构建静默，避免控制台噪音）
 * - warn/error 始终输出（线上可观测性优先，供用户反馈问题排查）
 */
const isProdBuild = (() => {
  try {
    // Vite 注入 import.meta.env；非 Vite 运行环境（Node 直引该模块）时回退开发行为
    return Boolean(import.meta.env?.PROD);
  } catch {
    return false;
  }
})();

export const logger = {
  debug(msg: unknown, ...args: unknown[]): void {
    if (!isProdBuild) console.debug(msg, ...args);
  },
  info(msg: unknown, ...args: unknown[]): void {
    if (!isProdBuild) console.log(msg, ...args);
  },
  warn(msg: unknown, ...args: unknown[]): void {
    console.warn(msg, ...args);
  },
  error(msg: unknown, ...args: unknown[]): void {
    console.error(msg, ...args);
  },
};
