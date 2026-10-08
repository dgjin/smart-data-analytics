/**
 * PWA Service Worker 注册（仅生产环境启用）。
 * - dev 模式不注册，并自愈清理历史遗留注册：早期以生产模式访问（或安装 PWA）时注册的 SW
 *   会把 dev 模块（/src/*，无 hash 路径）钉在旧版本，导致源码更新后页面仍显示旧功能；
 * - 注册失败静默：SW 属渐进增强能力，任何失败不得影响应用本体；
 * - 注册后立即触发一次 update() 探测：新版本部署后用户刷新一次即生效。
 */

/** 是否满足注册条件（拆出纯函数便于单测；prodFlag 为测试注入点，默认取构建环境） */
export function shouldRegisterServiceWorker(prodFlag: boolean = import.meta.env.PROD): boolean {
  if (!prodFlag) return false;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return true;
}

/** dev 模式自愈：注销遗留的 SW 注册并清空 CacheStorage（异步静默，任何失败不阻断应用） */
function purgeLegacyServiceWorkerState(): void {
  void (async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.allSettled(registrations.map((registration) => registration.unregister()));
    } catch {
      // 静默：注册管理 API 不可用（如测试桩）或注销失败均不阻断
    }
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch {
      // 静默：CacheStorage 不可用或清缓存失败均不阻断
    }
  })();
}

/** 注册 Service Worker（window load 后执行，scope 固定为根路径） */
export function registerServiceWorker(prodFlag: boolean = import.meta.env.PROD): void {
  if (!shouldRegisterServiceWorker(prodFlag)) {
    // dev 模式自愈清理（其它不满足注册条件的情形无遗留可清，不进入）
    if (!prodFlag && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      purgeLegacyServiceWorkerState();
    }
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => registration.update())
      .catch(() => {
        // 静默：SW 注册失败（如非安全上下文）不影响应用功能
      });
  });
}
