'use strict';

// Source-level guard test for issue #42: token-generator and signup
// Lambdas should be capped at 15s, not the default 30s. ApiStack is
// heavyweight to instantiate (Cognito + DDB + SES + Scheduler + Route53),
// so we verify by parsing the source and pulling the relevant Function
// blocks — same pattern as PR #31's lambda-log-retention test.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../lib/api-stack.js'),
  'utf8',
);

function functionBlockFor(constructId) {
  // Find `new lambda.Function(this, '<id>'` and return the chunk up to
  // the next `});` — covers the props object passed to the constructor.
  const start = SRC.indexOf(`new lambda.Function(this, '${constructId}'`);
  if (start === -1) {
    throw new Error(`could not find lambda.Function block for ${constructId}`);
  }
  const closeIdx = SRC.indexOf('});', start);
  if (closeIdx === -1) {
    throw new Error(`could not find closing }); for ${constructId}`);
  }
  return SRC.slice(start, closeIdx + 3);
}

describe('Lambda timeouts (issue #42)', () => {
  test('TokenGeneratorFunction timeout is Duration.seconds(15)', () => {
    const block = functionBlockFor('TokenGeneratorFunction');
    expect(block).toMatch(/timeout:\s*Duration\.seconds\(15\)/);
    expect(block).not.toMatch(/timeout:\s*Duration\.seconds\(30\)/);
  });

  test('SignupFunction timeout is Duration.seconds(15)', () => {
    const block = functionBlockFor('SignupFunction');
    expect(block).toMatch(/timeout:\s*Duration\.seconds\(15\)/);
    expect(block).not.toMatch(/timeout:\s*Duration\.seconds\(30\)/);
  });

  test('eventCrud and sessionManager keep 30s (legitimately do more work)', () => {
    const eventCrud = functionBlockFor('EventCrudFunction');
    const sessionManager = functionBlockFor('SessionManagerFunction');
    expect(eventCrud).toMatch(/timeout:\s*Duration\.seconds\(30\)/);
    expect(sessionManager).toMatch(/timeout:\s*Duration\.seconds\(30\)/);
  });

  test('WebSocket handlers stay at the existing 10s ceiling', () => {
    for (const id of ['WsConnectFunction', 'WsDisconnectFunction', 'WsSignalingFunction']) {
      const block = functionBlockFor(id);
      expect(block).toMatch(/timeout:\s*Duration\.seconds\(10\)/);
    }
  });
});
