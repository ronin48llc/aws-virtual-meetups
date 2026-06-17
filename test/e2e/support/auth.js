'use strict';

/**
 * Drives authenticated state without Cognito.
 *
 * Auth.init() tolerates a missing Cognito SDK, and Auth.isAuthenticated() /
 * getCurrentUser() read purely from localStorage + a decoded ID token. So we
 * seed a self-issued (alg:none) JWT plus the user record the app expects, with
 * the `custom:role` claim the nav/manage gating keys off. addInitScript runs
 * before any page script, so the tokens are present when Auth.init() restores
 * the session.
 */

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

function makeJwt(payload) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {'attendee'|'organizer'} [opts.role]
 * @param {string} [opts.email]
 */
async function seedAuth(page, opts = {}) {
  const { role = 'attendee', email = 'tester@example.com' } = opts;
  const idToken = makeJwt({
    sub: 'user-1',
    email,
    'custom:role': role,
    'custom:displayName': email,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const user = {
    email,
    displayName: email,
    sub: 'user-1',
    idToken,
    accessToken: idToken,
    refreshToken: 'refresh',
  };

  await page.addInitScript(
    ({ idToken, user }) => {
      localStorage.setItem('meetup_id_token', idToken);
      localStorage.setItem('meetup_access_token', idToken);
      localStorage.setItem('meetup_refresh_token', 'refresh');
      localStorage.setItem('meetup_user', JSON.stringify(user));
    },
    { idToken, user }
  );
}

module.exports = { seedAuth, makeJwt };
