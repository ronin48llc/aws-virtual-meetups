'use strict';

// Central configuration for the live suite. Everything is overridable via
// env vars so the same suite can point at dev or prod.
module.exports = {
  SITE_URL: process.env.SITE_URL || 'https://awsvirtualmeetups.com',
  API_URL: process.env.API_URL || 'https://api.awsvirtualmeetups.com',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  // Cognito User Pool for creating/deleting disposable test users. Defaults
  // to the dev pool; override for prod.
  USER_POOL_ID: process.env.LIVE_E2E_USER_POOL_ID || 'us-east-1_Z8YDS0abS',
  // Personas created at global-setup, torn down at global-teardown. The
  // password is randomized per run.
  PERSONAS: {
    presenter: { email: 'live-e2e-presenter@test.invalid', name: 'E2E Presenter', role: 'organizer' },
    attendee: { email: 'live-e2e-attendee@test.invalid', name: 'E2E Attendee', role: 'member' },
  },
  // How long the presenter stays live so IVS produces a real recording.
  LIVE_HOLD_MS: parseInt(process.env.LIVE_HOLD_MS || String(2 * 60 * 1000), 10),
  // How long to wait for the recording to finalize + be exposed after stop.
  RECORDING_WAIT_MS: parseInt(process.env.RECORDING_WAIT_MS || String(8 * 60 * 1000), 10),
};
