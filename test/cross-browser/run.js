'use strict';

/**
 * Layer 4 runner — drives a few critical flows across real browser engines
 * against a deployed/staging stack. Designed to SKIP CLEANLY (exit 0) when it
 * isn't configured, so it can sit in CI without a live env or grid creds.
 *
 * Required:  TARGET_URL (or CLOUDFRONT_URL) — the deployed site to hit.
 * Grid:      SELENIUM_REMOTE_URL, or BROWSERSTACK_USERNAME/ACCESS_KEY, or
 *            SAUCE_USERNAME/ACCESS_KEY. Without a grid, runs Chrome + Firefox
 *            locally (headless) via Selenium Manager.
 */
const { browsers } = require('./browsers');
const { buildDriver } = require('./driver');
const flows = require('./flows');

const TARGET_URL = process.env.TARGET_URL || process.env.CLOUDFRONT_URL || '';

function resolveRemoteUrl() {
  if (process.env.SELENIUM_REMOTE_URL) return process.env.SELENIUM_REMOTE_URL;
  if (process.env.BROWSERSTACK_USERNAME && process.env.BROWSERSTACK_ACCESS_KEY) {
    const { BROWSERSTACK_USERNAME: u, BROWSERSTACK_ACCESS_KEY: k } = process.env;
    return `https://${u}:${k}@hub-cloud.browserstack.com/wd/hub`;
  }
  if (process.env.SAUCE_USERNAME && process.env.SAUCE_ACCESS_KEY) {
    const { SAUCE_USERNAME: u, SAUCE_ACCESS_KEY: k } = process.env;
    return `https://${u}:${k}@ondemand.us-west-1.saucelabs.com/wd/hub`;
  }
  return '';
}

function skip(message) {
  // eslint-disable-next-line no-console
  console.log(`[cross-browser] SKIP — ${message}`);
  process.exit(0);
}

(async () => {
  if (!TARGET_URL) {
    skip('set TARGET_URL (or CLOUDFRONT_URL) to a deployed/staging URL to run the cross-browser suite.');
  }

  const remoteUrl = resolveRemoteUrl();
  // Cloud/Grid → full engine matrix; local → the engines Selenium Manager can
  // provision headlessly (Chrome + Firefox).
  const selected = remoteUrl ? browsers : browsers.filter((b) => b.local);
  if (!selected.length) {
    skip('no usable browsers (set SELENIUM_REMOTE_URL or BROWSERSTACK_*/SAUCE_* for Edge/Safari).');
  }

  // eslint-disable-next-line no-console
  console.log(
    `[cross-browser] target=${TARGET_URL}  mode=${remoteUrl ? 'grid' : 'local-headless'}  browsers=${selected.map((b) => b.name).join(', ')}`
  );

  const flowEntries = Object.entries(flows);
  let failures = 0;

  for (const browser of selected) {
    let driver;
    try {
      driver = await buildDriver(browser, { remoteUrl });
    } catch (err) {
      // A missing local engine is a skip, not a hard failure, in local mode.
      if (!remoteUrl) {
        // eslint-disable-next-line no-console
        console.log(`[cross-browser] ${browser.name}: not available locally — skipping (${err.message})`);
        continue;
      }
      // eslint-disable-next-line no-console
      console.error(`[cross-browser] ${browser.name}: could not start driver — ${err.message}`);
      failures++;
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`\n[cross-browser] ${browser.name}`);
    for (const [name, flow] of flowEntries) {
      try {
        await flow(driver, { baseUrl: TARGET_URL });
        // eslint-disable-next-line no-console
        console.log(`  ✓ ${name}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`  ✕ ${name} — ${err.message}`);
        failures++;
      }
    }
    await driver.quit().catch(() => {});
  }

  // eslint-disable-next-line no-console
  console.log(`\n[cross-browser] done — ${failures ? `${failures} failure(s)` : 'all flows passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[cross-browser] fatal:', err);
  process.exit(1);
});
