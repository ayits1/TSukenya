import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

const chrome =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'] } },
      {
        plugins: [
          storybookTest({ configDir: fileURLToPath(new URL('./.storybook', import.meta.url)) }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
