import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import {defineConfig} from 'vitest/config';

/** 应用版本号：构建期从 package.json 读取，经 define 注入为全局常量（统一版本唯一事实源） */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

export default defineConfig(() => {
  return {
    // 资产路径基准（顶层配置项，不可放 build 内）
    base: '/',
    define: {
      // 版本常量经 import.meta.env 通道注入：Vite 6 dev 模式跳过 client 环境的顶层 define 替换，
      // 仅 import.meta.env.* 键会并入 /@vite/env 注入（build 下两路径均生效），保证 dev/生产行为一致
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify: file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // 开发服务器配置 - 允许 CSP
      headers: {
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:;",
      },
    },
    // vitest 排除 Playwright E2E 用例（由 npm run test:e2e 单独运行）
    test: {
      exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    },
  };
});
