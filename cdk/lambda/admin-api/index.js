'use strict';

// Issue #93: This Lambda manipulates Cognito user accounts (disable/enable
// arbitrary users) and leaks account-status metadata. When wired to API
// Gateway it MUST sit behind a Cognito User Pool Authorizer. The
// per-request role check below is defense-in-depth so the handler stays
// safe even if a future PR adds the route without the authorizer, or
// invokes this Lambda from a different trigger (EventBridge, direct).

const { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID;

exports.handler = async (event) => {
  // Authz gate runs before routing — every operation requires organizer role.
  const authz = checkOrganizer(event);
  if (authz) return authz;

  const { httpMethod, path, body } = parseEvent(event);

  try {
    if (httpMethod === 'POST' && path.endsWith('/disable')) {
      return await disableUser(JSON.parse(body));
    }

    if (httpMethod === 'POST' && path.endsWith('/enable')) {
      return await enableUser(JSON.parse(body));
    }

    if (httpMethod === 'GET' && path.includes('/status')) {
      const username = extractUsername(path);
      return await getUserStatus(username);
    }

    return response(404, { message: 'Not found' });
  } catch (err) {
    console.error('Admin API error:', err);
    return response(500, { message: 'Internal server error' });
  }
};

function extractClaims(event) {
  // API Gateway REST: event.requestContext.authorizer.claims
  // API Gateway HTTP API (v2): event.requestContext.authorizer.jwt.claims
  return (
    event?.requestContext?.authorizer?.claims ||
    event?.requestContext?.authorizer?.jwt?.claims ||
    null
  );
}

function checkOrganizer(event) {
  const claims = extractClaims(event);
  if (!claims) {
    console.warn('Admin API call rejected: missing claims', {
      path: event?.path || event?.rawPath,
    });
    return response(401, { message: 'Unauthorized' });
  }
  const role = claims['custom:role'];
  if (role !== 'organizer') {
    console.warn('Admin API call rejected: insufficient role', {
      sub: claims.sub,
      role,
      path: event?.path || event?.rawPath,
    });
    return response(403, { message: 'Forbidden' });
  }
  return null;
}

async function disableUser(body) {
  const { username } = body;
  if (!username) {
    return response(400, { message: 'username is required' });
  }

  await cognitoClient.send(new AdminDisableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  return response(200, { message: `User ${username} has been disabled`, username, enabled: false });
}

async function enableUser(body) {
  const { username } = body;
  if (!username) {
    return response(400, { message: 'username is required' });
  }

  await cognitoClient.send(new AdminEnableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  return response(200, { message: `User ${username} has been enabled`, username, enabled: true });
}

async function getUserStatus(username) {
  if (!username) {
    return response(400, { message: 'username is required' });
  }

  const result = await cognitoClient.send(new AdminGetUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  return response(200, {
    username: result.Username,
    enabled: result.Enabled,
    userStatus: result.UserStatus,
    userCreateDate: result.UserCreateDate,
    userLastModifiedDate: result.UserLastModifiedDate,
  });
}

function parseEvent(event) {
  const httpMethod = event.httpMethod || event.requestContext?.http?.method || 'GET';
  const path = event.path || event.rawPath || '';
  const body = event.body || '{}';
  return { httpMethod, path, body };
}

function extractUsername(path) {
  const parts = path.split('/');
  const usersIndex = parts.indexOf('users');
  if (usersIndex >= 0 && parts.length > usersIndex + 1) {
    return parts[usersIndex + 1];
  }
  return null;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
