'use strict';

/**
 * Cognito ID-token verifier shared by the WebSocket Lambdas.
 *
 * The first call to `verifyIdToken` lazily constructs a `CognitoJwtVerifier`
 * keyed to the configured user pool and client ID, which fetches the JWK
 * set from Cognito (cold-start cost ~200 ms). Subsequent invocations reuse
 * the cached JWKs in module scope, so warm invocations verify in <1 ms.
 *
 * Required env vars on the consuming Lambda:
 * - COGNITO_USER_POOL_ID
 * - COGNITO_CLIENT_ID
 *
 * If either is missing, `verifyIdToken` throws — fail closed.
 *
 * @module shared/jwt-verifier
 */

const { CognitoJwtVerifier } = require('aws-jwt-verify');

let cachedVerifier = null;

/**
 * Lazily build (and memoize) the verifier.
 * @returns {ReturnType<typeof CognitoJwtVerifier.create>}
 */
function getVerifier() {
  if (cachedVerifier) return cachedVerifier;

  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) {
    throw new Error('jwt-verifier: COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set');
  }

  cachedVerifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'id',
    clientId,
  });
  return cachedVerifier;
}

/**
 * Verify a Cognito ID token and return its claims, or null if invalid.
 *
 * Never throws — returns null and logs the reason. Callers should treat
 * null as "reject this request as unauthenticated".
 *
 * @param {string} token - The raw JWT.
 * @returns {Promise<object|null>} The verified claims, or null.
 */
async function verifyIdToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const verifier = getVerifier();
    return await verifier.verify(token);
  } catch (err) {
    console.warn('JWT verification failed', { reason: err.message });
    return null;
  }
}

/**
 * Reset the cached verifier. Test-only.
 * @returns {void}
 */
function _resetForTests() {
  cachedVerifier = null;
}

module.exports = { verifyIdToken, _resetForTests };
