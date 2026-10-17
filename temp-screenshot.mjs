import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://localhost:8085');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'artifacts/ui-v0.6/today-390.png', fullPage: true });
  
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: 'artifacts/ui-v0.6/today-360.png', fullPage: true });
  
  await browser.close();
  console.log('截图完成');
})();
