/**
 * Service Worker：应用壳缓存与离线兜底（PWA 安装能力，零依赖手写）。
 *
 * 缓存策略（三线分流）：
 * 1) 导航请求（mode === 'navigate'）：网络优先——在线永远拿到最新 index.html，
 *    离线回退缓存的壳（以 '/' 为键），再无则返回内置离线页；
 * 2) 同源 GET 静态资源（/assets/*、dev 模块 /src/*、图标等）：网络优先，成功后回填缓存；
 *    离线回退缓存。不能用缓存优先：无 hash 路径（dev 模块、图标）会被钉在旧版本，
 *    导致源码/图标更新后页面仍显示旧内容；
 * 3) /api/** 与其他非 GET / 跨域请求：一律直通（NetworkOnly）——业务数据与鉴权
 *    token 绝不写入 CacheStorage（含 SSE 流式问数）。
 *
 * 更新机制：本文件由服务端以 Cache-Control: no-cache 提供；页面每次加载触发
 * registration.update() 探测。导航与静态资源均网络优先 + activate 清理旧缓存，
 * 保证新版本部署后用户刷新一次即生效（CACHE 名中的版本号仅用于缓存清理命名，
 * 策略变更时递增以触发 SW 更新与全量旧缓存清理）。
 */
const CACHE = 'nl2sql-app-v2';
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
  .badge { width: 3rem; height: 3rem; margin: 0 auto 1rem; }
  /* 与顶栏同源：无砖透明版（品牌色笔弧 + 斜向受光 + 背光面 + 双棱描边 + 核边缘光/镜面点/底部反光） */
  h1 { font-size: 1.125rem; color: #e2e8f0; margin: 0 0 .5rem; font-weight: 700; }
  p { font-size: .8125rem; line-height: 1.7; color: #94a3b8; margin: 0; }
</style>
</head>
<body>
  <div class="box">
    <div class="badge">
      <svg viewBox="44 44 168 168" width="48" height="48" aria-hidden="true">
        <defs>
          <linearGradient id="o-ink" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">
            <stop offset="0%" stop-color="#7C6FFF"/><stop offset="46%" stop-color="#5B54F2"/><stop offset="100%" stop-color="#332CA8"/>
          </linearGradient>
          <linearGradient id="o-sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".24"/><stop offset="38%" stop-color="#FFFFFF" stop-opacity=".05"/><stop offset="100%" stop-color="#000000" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="o-shade" gradientUnits="userSpaceOnUse" x1="52" y1="48" x2="238" y2="240">
            <stop offset="0%" stop-color="#1B1550" stop-opacity="0"/><stop offset="50%" stop-color="#1B1550" stop-opacity="0"/><stop offset="100%" stop-color="#1B1550" stop-opacity=".14"/>
          </linearGradient>
          <linearGradient id="o-arc" gradientUnits="userSpaceOnUse" x1="62" y1="50" x2="206" y2="212">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".95"/><stop offset="24%" stop-color="#FFFFFF" stop-opacity=".38"/><stop offset="50%" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="72%" stop-color="#0A0626" stop-opacity="0"/><stop offset="100%" stop-color="#0A0626" stop-opacity=".36"/>
          </linearGradient>
          <radialGradient id="o-core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
            <stop offset="0%" stop-color="#F2FFFF"/><stop offset="44%" stop-color="#8AF0FD"/><stop offset="100%" stop-color="#1FC5E6"/>
          </radialGradient>
          <linearGradient id="o-rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".88"/><stop offset="46%" stop-color="#FFFFFF" stop-opacity=".2"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="o-spec" gradientUnits="userSpaceOnUse" cx="119" cy="113" r="8">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity=".96"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="o-cbounce" gradientUnits="userSpaceOnUse" cx="128" cy="144" r="15">
            <stop offset="0%" stop-color="#9CF4FF" stop-opacity=".5"/><stop offset="100%" stop-color="#9CF4FF" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <path fill="url(#o-ink)" d="M203.34 148.19C197.23 163.86 185.91 177.37 171.36 185.8C157.91 193.57 141.9 196.82 126.55 194.48C112.47 192.34 99.09 185.46 89.46 174.96C80.7 165.41 75.11 152.84 74.3 139.9C73.58 128.26 76.8 116.19 83.59 106.7C89.63 98.26 98.73 91.68 108.76 88.99C117.54 86.63 127.51 87.25 135.77 91.06C142.86 94.33 149.23 100.35 152.51 107.43C148.05 101.72 141.78 97.69 134.74 95.95C127.54 94.18 119.94 94.9 113.18 97.95C106.27 101.08 100.62 106.46 97.12 113.19C93.54 120.06 92.4 127.96 93.83 135.58C95.29 143.36 99.36 150.42 105.32 155.64C111.41 160.96 119.13 164.07 127.2 164.49C135.45 164.93 143.6 162.55 150.35 157.8C157.24 152.95 162.28 145.9 164.71 137.84A20 20 0 0 0 203.34 148.19Z" />
        <path fill="url(#o-sheen)" d="M203.34 148.19C197.23 163.86 185.91 177.37 171.36 185.8C157.91 193.57 141.9 196.82 126.55 194.48C112.47 192.34 99.09 185.46 89.46 174.96C80.7 165.41 75.11 152.84 74.3 139.9C73.58 128.26 76.8 116.19 83.59 106.7C89.63 98.26 98.73 91.68 108.76 88.99C117.54 86.63 127.51 87.25 135.77 91.06C142.86 94.33 149.23 100.35 152.51 107.43C148.05 101.72 141.78 97.69 134.74 95.95C127.54 94.18 119.94 94.9 113.18 97.95C106.27 101.08 100.62 106.46 97.12 113.19C93.54 120.06 92.4 127.96 93.83 135.58C95.29 143.36 99.36 150.42 105.32 155.64C111.41 160.96 119.13 164.07 127.2 164.49C135.45 164.93 143.6 162.55 150.35 157.8C157.24 152.95 162.28 145.9 164.71 137.84A20 20 0 0 0 203.34 148.19Z" />
        <path fill="url(#o-shade)" d="M203.34 148.19C197.23 163.86 185.91 177.37 171.36 185.8C157.91 193.57 141.9 196.82 126.55 194.48C112.47 192.34 99.09 185.46 89.46 174.96C80.7 165.41 75.11 152.84 74.3 139.9C73.58 128.26 76.8 116.19 83.59 106.7C89.63 98.26 98.73 91.68 108.76 88.99C117.54 86.63 127.51 87.25 135.77 91.06C142.86 94.33 149.23 100.35 152.51 107.43C148.05 101.72 141.78 97.69 134.74 95.95C127.54 94.18 119.94 94.9 113.18 97.95C106.27 101.08 100.62 106.46 97.12 113.19C93.54 120.06 92.4 127.96 93.83 135.58C95.29 143.36 99.36 150.42 105.32 155.64C111.41 160.96 119.13 164.07 127.2 164.49C135.45 164.93 143.6 162.55 150.35 157.8C157.24 152.95 162.28 145.9 164.71 137.84A20 20 0 0 0 203.34 148.19Z" />
        <path fill="none" stroke="url(#o-arc)" stroke-width="1.5" d="M203.34 148.19C197.23 163.86 185.91 177.37 171.36 185.8C157.91 193.57 141.9 196.82 126.55 194.48C112.47 192.34 99.09 185.46 89.46 174.96C80.7 165.41 75.11 152.84 74.3 139.9C73.58 128.26 76.8 116.19 83.59 106.7C89.63 98.26 98.73 91.68 108.76 88.99C117.54 86.63 127.51 87.25 135.77 91.06C142.86 94.33 149.23 100.35 152.51 107.43C148.05 101.72 141.78 97.69 134.74 95.95C127.54 94.18 119.94 94.9 113.18 97.95C106.27 101.08 100.62 106.46 97.12 113.19C93.54 120.06 92.4 127.96 93.83 135.58C95.29 143.36 99.36 150.42 105.32 155.64C111.41 160.96 119.13 164.07 127.2 164.49C135.45 164.93 143.6 162.55 150.35 157.8C157.24 152.95 162.28 145.9 164.71 137.84A20 20 0 0 0 203.34 148.19Z" />
        <path fill="url(#o-core)" d="M150 128A22 22 0 1 1 106 128A22 22 0 1 1 150 128Z" />
        <circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#o-rim)" stroke-width="1"/>
        <ellipse cx="119" cy="113" rx="7.5" ry="6" fill="url(#o-spec)"/>
        <ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#o-cbounce)"/>
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

  // 同源 GET 静态资源：网络优先，离线回退缓存（在线永远最新；离线兜底不退化）
  event.respondWith((async () => {
    try {
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
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      return Response.error();
    }
  })());
});
