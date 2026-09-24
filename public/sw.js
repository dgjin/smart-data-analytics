/**
 * Service Worker：应用壳缓存与离线兜底（PWA 安装能力，零依赖手写）。
 *
 * 缓存策略（三线分流）：
 * 1) 导航请求（mode === 'navigate'）：网络优先——在线永远拿到最新 index.html，
 *    离线回退缓存的壳（以 '/' 为键），再无则返回内置离线页；
 * 2) 同源 GET 静态资源（/assets/* hash 产物、图标等）：缓存优先，未命中请求网络并回填；
 * 3) /api/** 与其他非 GET / 跨域请求：一律直通（NetworkOnly）——业务数据与鉴权
 *    token 绝不写入 CacheStorage（含 SSE 流式问数）。
 *
 * 更新机制：本文件由服务端以 Cache-Control: no-cache 提供；页面每次加载触发
 * registration.update() 探测。导航网络优先 + activate 清理旧缓存，保证新版本
 * 部署后用户刷新一次即生效（CACHE 名中的版本号仅用于缓存清理命名）。
 */
const CACHE = 'nl2sql-app-v1';
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
];

/** 内置离线兜底页：从未在线访问过（无缓存可回退）时展示，避免 Chrome 默认错误页 */
const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>离线 - 智能问数分析系统</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #020617; color: #cbd5e1;
         font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
  .box { text-align: center; max-width: 22rem; padding: 2rem; }
  .badge { width: 3rem; height: 3rem; border-radius: .75rem; margin: 0 auto 1rem;
           background: linear-gradient(135deg, #4f46e5, #06b6d4);
           display: flex; align-items: center; justify-content: center; }
  h1 { font-size: 1.125rem; color: #e2e8f0; margin: 0 0 .5rem; font-weight: 700; }
  p { font-size: .8125rem; line-height: 1.7; color: #94a3b8; margin: 0; }
</style>
</head>
<body>
  <div class="box">
    <div class="badge">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="2" y1="2" x2="22" y2="22" />
        <path d="M8.5 16.5a5 5 0 0 1 7 0" />
        <path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
        <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
        <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" />
        <path d="M5 12.55a10 10 0 0 1 5.17-2.39" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
    </div>
    <h1>当前处于离线状态</h1>
    <p>页面缓存不可用且网络未连接。<br />
       请检查网络后重试；若为首次使用，请先联网打开一次以缓存应用。</p>
  </div>
</body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 容错预缓存：单个资源失败不阻塞 SW 安装（不缺图也能激活）
    await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 直通：跨域 / 非 GET / API（业务数据与 SSE 流式响应绝不缓存）
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：网络优先，离线回退壳 → 内置离线页
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // 先完成壳回填再返回：await 保证写入，统一以 '/' 为键供离线导航回退
        try {
          const cache = await caches.open(CACHE);
          await cache.put('/', response.clone());
        } catch {
          /* 缓存写入失败不影响本次响应 */
        }
        return response;
      } catch {
        const cached = await caches.match('/');
        if (cached) return cached;
        return new Response(OFFLINE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 同源 GET 静态资源：缓存优先（Vite 产物为 hash 文件名，缓存天然安全）
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    // 先完成回填再返回：await 保证写入，失败不影响本次响应
    if (response.ok) {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      } catch {
        /* 缓存写入失败不影响本次响应 */
      }
    }
    return response;
  })());
});
