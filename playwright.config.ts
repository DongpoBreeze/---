import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: process.env.TEST_AI_MOCK === '1' ? '**/*-ui.e2e.ts' : '**/*.spec.ts',
  outputDir: 'artifacts/playwright',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://localhost:8081',
    channel: process.env.TEST_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    launchOptions: { args: ['--no-proxy-server'] },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
  ],
});
