'use strict';

const { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID;

/**
 * Admin API Lambda handler for managing user accounts.
 * Supports disabling and enabling user accounts.
 * Requirements: 25.5
 */
exports.handler = async (event) => {
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
  // Support both API Gateway REST and HTTP API event formats
  const httpMethod = event.httpMethod || event.requestContext?.http?.method || 'GET';
  const path = event.path || event.rawPath || '';
  const body = event.body || '{}';
  return { httpMethod, path, body };
}

function extractUsername(path) {
  // Extract username from path like /admin/users/{username}/status
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
