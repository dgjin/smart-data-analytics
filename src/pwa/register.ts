/**
 * PWA Service Worker 注册（仅生产环境启用）。
 * - dev 模式不注册：避免缓存干扰 Vite HMR 与调试（验收请使用 npm run build && npm start）；
 * - 注册失败静默：SW 属渐进增强能力，任何失败不得影响应用本体；
 * - 注册后立即触发一次 update() 探测：新版本部署后用户刷新一次即生效。
 */

/** 是否满足注册条件（拆出纯函数便于单测；prodFlag 为测试注入点，默认取构建环境） */
export function shouldRegisterServiceWorker(prodFlag: boolean = import.meta.env.PROD): boolean {
  if (!prodFlag) return false;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return true;
}

/** 注册 Service Worker（window load 后执行，scope 固定为根路径） */
export function registerServiceWorker(prodFlag: boolean = import.meta.env.PROD): void {
  if (!shouldRegisterServiceWorker(prodFlag)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => registration.update())
      .catch(() => {
        // 静默：SW 注册失败（如非安全上下文）不影响应用功能
      });
  });
}
