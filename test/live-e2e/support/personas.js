'use strict';

const crypto = require('crypto');
const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { AWS_REGION, USER_POOL_ID, PERSONAS } = require('./env');

const client = new CognitoIdentityProviderClient({ region: AWS_REGION });

// Randomized per run so a leaked password from one run can't touch the next.
function randomPassword() {
  return 'E2e!' + crypto.randomBytes(12).toString('base64url') + 'aA1';
}

// State file so specs (separate process from global-setup) can read the
// credentials created at setup. Lives in the OS temp dir, never committed.
const STATE_PATH = require('path').join(require('os').tmpdir(), 'live-e2e-personas.json');

async function createPersona(key) {
  const p = PERSONAS[key];
  const password = randomPassword();
  await client.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: p.email,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: p.email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: p.name },
      { Name: 'custom:role', Value: p.role },
    ],
  }));
  await client.send(new AdminSetUserPasswordCommand({
    UserPoolId: USER_POOL_ID,
    Username: p.email,
    Password: password,
    Permanent: true,
  }));
  return { email: p.email, name: p.name, role: p.role, password };
}

async function deletePersona(email) {
  try {
    await client.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
  } catch (err) {
    if (err.name !== 'UserNotFoundException') throw err;
  }
}

async function setupPersonas() {
  const state = {};
  for (const key of Object.keys(PERSONAS)) {
    // Delete-then-create so a crashed prior run's leftover user doesn't
    // fail setup with UsernameExistsException.
    await deletePersona(PERSONAS[key].email);
    state[key] = await createPersona(key);
  }
  require('fs').writeFileSync(STATE_PATH, JSON.stringify(state));
  return state;
}

async function teardownPersonas() {
  for (const key of Object.keys(PERSONAS)) {
    await deletePersona(PERSONAS[key].email);
  }
  try { require('fs').unlinkSync(STATE_PATH); } catch (_) { /* already gone */ }
}

function loadPersonas() {
  return JSON.parse(require('fs').readFileSync(STATE_PATH, 'utf8'));
}

module.exports = { setupPersonas, teardownPersonas, loadPersonas, STATE_PATH };
