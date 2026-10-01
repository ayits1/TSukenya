import { existsSync } from 'node:fs';
import { defineConfig } from 'playwright/test';

const chrome =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:6007',
    locale: 'uk-UA',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.002 } },
  snapshotPathTemplate: '{testDir}/baselines/{platform}/{projectName}/{arg}{ext}',
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 1000 },
        launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
      },
    },
    {
      name: 'webkit-desktop',
      use: { browserName: 'webkit', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit-mobile',
      use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: {
    command: 'node scripts/serve-storybook.mjs',
    url: 'http://127.0.0.1:6007',
    reuseExistingServer: false,
  },
});
