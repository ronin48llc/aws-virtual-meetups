'use strict';

/**
 * Cross-browser capability matrix.
 *
 * `local: true` browsers can run without a grid — Selenium Manager (bundled
 * with selenium-webdriver v4) auto-provisions their drivers. Edge and Safari
 * need a Grid or a cloud provider; Safari only exists on macOS, so even there
 * a cloud grid is the practical path for CI. Cloud capabilities (BrowserStack /
 * Sauce `bstack:options` / `sauce:options`) are merged in driver.js from env.
 */
const browsers = [
  { name: 'Chrome', browserName: 'chrome', local: true },
  { name: 'Firefox', browserName: 'firefox', local: true },
  { name: 'Edge', browserName: 'MicrosoftEdge', local: false },
  { name: 'Safari', browserName: 'safari', local: false },
];

module.exports = { browsers };
