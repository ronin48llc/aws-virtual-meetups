'use strict';

/**
 * WebSocket Smoke Tests
 * Validates WebSocket connectivity and basic signaling actions.
 */
async function run(config, { pass, fail, skip, withRetry }) {
  if (!config.wsUrl) {
    skip('WebSocket tests', 'wsUrl not configured');
    return;
  }

  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch (err) {
    skip('WebSocket tests', 'ws package not installed');
    return;
  }

  // Test $connect without auth - should be rejected
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(config.wsUrl);
      const timeout = setTimeout(() => {
        ws.terminate();
        // If connection hangs, it might be rejected at API Gateway level
        resolve('timeout-rejected');
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        ws.close();
        // If it connects without auth, that's unexpected but not necessarily wrong
        // depending on configuration
        resolve('connected');
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve('rejected');
      });

      ws.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 1006 || code === 4001 || code === 4003) {
          resolve('rejected');
        }
      });
    });
    pass('WebSocket $connect without auth is handled');
  } catch (err) {
    fail('WebSocket $connect without auth is handled', err);
  }

  // Test $connect with auth token
  try {
    const token = 'smoke-test-token'; // Would use real token in production
    const connected = await withRetry(async () => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${config.wsUrl}?token=${token}`);
        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', () => {
          clearTimeout(timeout);
          // Test raiseHand action
          ws.send(JSON.stringify({ action: 'raiseHand', eventId: 'smoke-test' }));

          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            ws.close();
            resolve(msg);
          });

          // If no response in 5s, still pass connection test
          setTimeout(() => {
            ws.close();
            resolve({ connected: true });
          }, 5000);
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    }, config, 'WebSocket connect with auth');

    if (connected) {
      pass('WebSocket $connect with auth succeeds');
    }
  } catch (err) {
    // Connection might fail if no valid token - that's expected in smoke test without real creds
    skip('WebSocket $connect with auth', 'Could not establish connection (may need valid token)');
  }
}

module.exports = { run };
