'use strict';

const { defineConfig } = require('@playwright/test');

// Live E2E against the real deployed environment. Serial + single worker:
// the personas share one event through its lifecycle, so ordering matters
// and parallelism would corrupt shared state.
module.exports = defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A full lifecycle (schedule → live → IVS records → stop → recording
  // finalizes) is minutes long. Generous per-test cap; individual awaits
  // set their own tighter timeouts.
  timeout: 20 * 60 * 1000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: require.resolve('./support/global-setup'),
  globalTeardown: require.resolve('./support/global-teardown'),
  use: {
    baseURL: process.env.SITE_URL || 'https://awsvirtualmeetups.com',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // Fake media devices so the presenter can publish real webcam/mic
    // tracks to IVS without hardware — the only way to exercise the
    // record-to-S3 path headlessly.
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['camera', 'microphone'],
  },
});
