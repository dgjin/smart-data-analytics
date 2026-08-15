/**
 * P2-9 Playwright E2E 配置。
 * 默认复用已运行的开发/生产服务（reuseExistingServer），CI 可让其自动拉起 tsx server.ts。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 150_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3000',
    headless: true,
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  // 本机/受限网络：优先驱动系统已装 Chrome（channel），避免 Playwright CDN 下载 chromium；
  // CI 环境可改回 browserName: 'chromium' 由 npx playwright install 预装。
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', channel: 'chrome' },
    },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: 'npx tsx server.ts',
        url: 'http://127.0.0.1:3000/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
