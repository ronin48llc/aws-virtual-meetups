#!/usr/bin/env node
'use strict';

/**
 * Smoke-test runner. Discovers `*.smoke.js` files in this directory and
 * invokes each one's `run(config, helpers)` export with shared
 * pass / fail / skip / withRetry helpers.
 *
 * Configuration comes from environment variables so the same script can
 * run locally and from a GitHub Actions workflow without code changes:
 *
 *   CLOUDFRONT_URL          frontend SPA root, e.g. https://d2hbje3cen4qrx.cloudfront.net
 *   API_URL                 REST API base, e.g. https://api.example.com
 *   WS_URL                  WebSocket base, e.g. wss://ws.example.com
 *   IVS_TOKEN_GENERATOR_FN  Lambda function name for IVS smoke test
 *   USER_POOL_ID            Cognito pool ID
 *   USER_POOL_CLIENT_ID     Cognito client ID
 *   SMOKE_TEST_EMAIL        login email for end-to-end smoke
 *   SMOKE_TEST_PASSWORD     login password
 *   SMOKE_RETRY_MAX         number of retries (default 3)
 *   SMOKE_RETRY_DELAY_MS    base delay in ms (default 1000, doubles each retry)
 *
 * Each smoke test that needs a config value it doesn't have calls
 * `skip(name, reason)` instead of failing — so partial configurations
 * still produce useful pass-or-skip output rather than spurious failures.
 *
 * Exit code: 0 if zero failures, 1 otherwise.
 *
 * @module test/smoke/run
 */

const fs = require('fs');
const path = require('path');

const config = {
  cloudFrontUrl: process.env.CLOUDFRONT_URL,
  apiUrl: process.env.API_URL,
  wsUrl: process.env.WS_URL,
  ivsTokenGeneratorFn: process.env.IVS_TOKEN_GENERATOR_FN,
  userPoolId: process.env.USER_POOL_ID,
  userPoolClientId: process.env.USER_POOL_CLIENT_ID,
  smokeTestEmail: process.env.SMOKE_TEST_EMAIL,
  smokeTestPassword: process.env.SMOKE_TEST_PASSWORD,
  retryMax: Number(process.env.SMOKE_RETRY_MAX || 3),
  retryDelayMs: Number(process.env.SMOKE_RETRY_DELAY_MS || 1000),
};

const results = { passed: 0, failed: 0, skipped: 0, failures: [] };

function pass(name) {
  results.passed++;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  results.failed++;
  const msg = err && err.message ? err.message : String(err);
  results.failures.push({ name, msg });
  console.log(`  ✗ ${name}\n    ${msg}`);
}

function skip(name, reason) {
  results.skipped++;
  console.log(`  ○ ${name} — skipped (${reason})`);
}

async function withRetry(fn, _config, label) {
  let lastErr;
  for (let i = 0; i <= config.retryMax; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < config.retryMax) {
        const delay = config.retryDelayMs * Math.pow(2, i);
        console.log(`    (retry ${i + 1}/${config.retryMax} for ${label}: ${err.message}; sleeping ${delay}ms)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

async function main() {
  const dir = __dirname;
  const smokeFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.smoke.js'))
    .sort();

  if (smokeFiles.length === 0) {
    console.error('No *.smoke.js files found in', dir);
    process.exit(1);
  }

  console.log('Running smoke tests against:');
  console.log('  CLOUDFRONT_URL = ' + (config.cloudFrontUrl || '(not set, frontend tests will skip)'));
  console.log('  API_URL        = ' + (config.apiUrl || '(not set, api tests will skip)'));
  console.log('  WS_URL         = ' + (config.wsUrl || '(not set, websocket tests will skip)'));
  console.log('');

  const helpers = { pass, fail, skip, withRetry };

  for (const file of smokeFiles) {
    console.log(`\n=== ${file} ===`);
    try {
      const mod = require(path.join(dir, file));
      if (typeof mod.run !== 'function') {
        fail(file, new Error('smoke file does not export run(config, helpers)'));
        continue;
      }
      await mod.run(config, helpers);
    } catch (err) {
      fail(`${file} threw`, err);
    }
  }

  console.log('');
  console.log('====================================');
  console.log(`  passed:  ${results.passed}`);
  console.log(`  failed:  ${results.failed}`);
  console.log(`  skipped: ${results.skipped}`);
  console.log('====================================');

  if (results.failed > 0) {
    console.log('\nFailures:');
    for (const f of results.failures) {
      console.log(`  ✗ ${f.name}: ${f.msg}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke runner crashed:', err);
  process.exit(2);
});
