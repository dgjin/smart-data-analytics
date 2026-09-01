/**
 * v0.4.16 浏览器兼容性增强配置
 * 
 * 目标浏览器范围：
 * - Chrome/Edge: 最新版 + 前两个大版本 (≥91)
 * - 360 浏览器：极速模式 (基于 Chromium)
 * - Firefox: ≥89
 * - Safari: ≥14
 * 
 * 策略：通过 autoprefixer 和 @csstools 转换确保现代 CSS/JS 特性向下兼容
 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vitest/config';
import cssnano from 'cssnano';

export default defineConfig(() => {
  return {
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      // 生产环境使用 cssnano 压缩，保持代码简洁
      ...(process.env.NODE_ENV === 'production' 
        ? [cssnano({ 
            preset: ['default', { 
              discardComments: { removeAll: true },
              convertToMinified: true,
              autoprefixer: false, // 已由 tailwindcss-vite 处理
            }] 
          })] 
        : [])
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      headers: {
        // CSP 策略优化：支持所有主流浏览器
        // - script-src 'unsafe-eval': 支持开发模式下的动态执行
        // - style-src 'unsafe-inline': 支持 Tailwind JIT 生成的样式
        // - connect-src 包含 ws/wss: 支持 SSE 和 WebSocket
        'Content-Security-Policy': `default-src 'self'; \
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; \
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
font-src 'self' https://fonts.gstatic.com data:; \
img-src 'self' data: https://* http://*; \
connect-src 'self' ws: wss: https://* http://localhost:* http://127.0.0.1:*; \
media-src 'self' data: blob:; \
object-src 'none'; \
frame-ancestors 'self'; \
base-uri 'self'; \
form-action 'self';`,
        'X-UA-Compatible': 'IE=edge,chrome=1', // 强制 IE/Edge 使用最新渲染引擎
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    },
    build: {
      // 目标浏览器兼容配置
      target: ['es2020'], // 兼容 ES2020+ (Chrome 80+, Edge 80+, Safari 14+, Firefox 79+)
      cssTarget: ['chrome80', 'edge80', 'firefox79', 'safari14'], // CSS 特性支持
        
      // 代码分割优化
      chunkSizeWarningLimit: 1000,
      
      // 滚动条优化
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-redux'],
            'vendor-charts': ['recharts'],
            'vendor-utils': ['date-fns', 'zustand'],
          },
        },
      },
      
      // PostCSS 配置：自动添加浏览器前缀
      postcss: {
        plugins: [
          // autoprefixer 会通过 browserslist 自动处理
          require('autoprefixer')({
            overrideBrowserslist: [
              '>1%',
              'last 2 versions',
              'not dead',
              'Chrome >= 91',  // Chrome 主流版本
              'Edge >= 91',    // Edge 主流版本
              'Firefox >= 89', // Firefox 主流版本
              'Safari >= 14',  // Safari 主流版本
              // 注意：360 浏览器基于 Chromium，Chrome 配置已覆盖
            ],
            grid: true, // 启用 Grid 布局前缀
          }),
        ],
      },
    },
    test: {
      exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    },
  };
});
