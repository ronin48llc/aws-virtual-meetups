'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Smoke Test Runner
 * Runs post-deployment smoke tests against a deployed environment.
 * Accepts configuration via environment variables or smoke-config.json.
 */

// Load config from file or environment
function loadConfig() {
  const configPath = path.resolve(__dirname, '../smoke-config.json');
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    console.log(`Loaded config from: ${configPath}`);
  }

  return {
    apiUrl: process.env.SMOKE_API_URL || fileConfig.apiUrl || '',
    wsUrl: process.env.SMOKE_WS_URL || fileConfig.wsUrl || '',
    cloudFrontUrl: process.env.SMOKE_CLOUDFRONT_URL || fileConfig.cloudFrontUrl || '',
    cognitoUserPoolId: process.env.SMOKE_COGNITO_POOL_ID || fileConfig.cognitoUserPoolId || '',
    cognitoClientId: process.env.SMOKE_COGNITO_CLIENT_ID || fileConfig.cognitoClientId || '',
    cognitoDomain: process.env.SMOKE_COGNITO_DOMAIN || fileConfig.cognitoDomain || '',
    testUsername: process.env.SMOKE_TEST_USERNAME || fileConfig.testUsername || 'smoke-test-user',
    testPassword: process.env.SMOKE_TEST_PASSWORD || fileConfig.testPassword || 'SmokeTest123!',
    retryAttempts: parseInt(process.env.SMOKE_RETRY_ATTEMPTS || fileConfig.retryAttempts || '3', 10),
    retryDelayMs: parseInt(process.env.SMOKE_RETRY_DELAY_MS || fileConfig.retryDelayMs || '5000', 10),
  };
}

// Retry wrapper for eventual consistency
async function withRetry(fn, config, label) {
  let lastError;
  for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < config.retryAttempts) {
        console.log(`  ↻ ${label} - attempt ${attempt} failed, retrying in ${config.retryDelayMs}ms...`);
        await sleep(config.retryDelayMs);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test result tracking
const results = [];

function pass(name) {
  results.push({ name, status: 'PASS' });
  console.log(`  ✓ ${name}`);
}

function fail(name, error) {
  results.push({ name, status: 'FAIL', error: error.message || String(error) });
  console.log(`  ✗ ${name}: ${error.message || error}`);
}

function skip(name, reason) {
  results.push({ name, status: 'SKIP', reason });
  console.log(`  ○ ${name}: ${reason}`);
}

// Load test modules
async function runTests(config) {
  const testModules = [
    { name: 'API Smoke Tests', file: '../test/smoke/api.smoke.js' },
    { name: 'WebSocket Smoke Tests', file: '../test/smoke/websocket.smoke.js' },
    { name: 'IVS Resource Smoke Tests', file: '../test/smoke/ivs.smoke.js' },
    { name: 'Frontend Smoke Tests', file: '../test/smoke/frontend.smoke.js' },
    { name: 'E2E Lifecycle Smoke Test', file: '../test/smoke/e2e-lifecycle.smoke.js' },
  ];

  for (const mod of testModules) {
    console.log(`\n--- ${mod.name} ---`);
    try {
      const testModule = require(mod.file);
      await testModule.run(config, { pass, fail, skip, withRetry });
    } catch (err) {
      fail(mod.name, err);
    }
  }
}

async function main() {
  console.log('=== Virtual Meetup Platform Smoke Tests ===\n');

  const config = loadConfig();

  if (!config.apiUrl && !config.cloudFrontUrl) {
    console.error('ERROR: No deployment configuration found.');
    console.error('Set SMOKE_API_URL env var or provide smoke-config.json');
    process.exit(1);
  }

  console.log(`API URL:        ${config.apiUrl || '(not set)'}`);
  console.log(`WebSocket URL:  ${config.wsUrl || '(not set)'}`);
  console.log(`CloudFront URL: ${config.cloudFrontUrl || '(not set)'}`);
  console.log(`Retry:          ${config.retryAttempts} attempts, ${config.retryDelayMs}ms delay`);

  await runTests(config);

  // Summary
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);

  if (failed > 0) {
    console.error('\nSmoke tests FAILED');
    process.exit(1);
  }

  console.log('\nSmoke tests PASSED');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Smoke test runner failed:', err);
    process.exit(1);
  });
}

module.exports = { loadConfig, withRetry, sleep };
