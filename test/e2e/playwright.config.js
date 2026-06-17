'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT) || 4173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Layer 2 — Playwright E2E, mocked-local.
 *
 * A tiny Node static server (support/server.js) serves the real frontend/ over
 * http://localhost. Each spec installs REST/WebSocket/SDK mocks (support/), so
 * the suite is fully deterministic and needs no AWS credentials. Chromium runs
 * with fake media devices so getUserMedia/getDisplayMedia resolve without
 * hardware. Cross-platform: Linux/macOS/Windows all supported by Playwright.
 */
module.exports = defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'node support/server.js',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
    timeout: 30_000,
  },
});
