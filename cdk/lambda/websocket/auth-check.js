'use strict';

/**
 * Per-message authentication check for WebSocket signaling (issue #4).
 *
 * Looks up the connection record stored at $connect time and verifies that
 * the captured Cognito ID-token `exp` claim has not passed. Returns one of:
 *
 *   { allowed: true,  connection: <record or null> }   // continue
 *   { allowed: false, reason: 'token-expired' }        // reject 401
 *
 * If the connection record is missing entirely (DDB blip, race with the
 * disconnect handler), we return `allowed: true` with a null connection —
 * the $connect handler is the security boundary, not signaling.
 *
 * Extracted from signaling.js so tests can `jest.mock` this module
 * directly without chasing every action's DDB-mock setup.
 *
 * @module websocket/auth-check
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;

/**
 * @param {string} connectionId
 * @returns {Promise<{allowed: boolean, connection?: object|null, reason?: string}>}
 */
async function checkConnectionAuth(connectionId) {
  let connection;
  try {
    const result = await docClient.send(new GetCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      Key: { connectionId },
    }));
    connection = result && result.Item;
  } catch (err) {
    console.error('Failed to load connection record for auth check; continuing', { connectionId, error: err.message });
    return { allowed: true, connection: null };
  }

  if (connection && connection.tokenExp != null) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= connection.tokenExp) {
      console.warn('Connection token expired — rejecting message', {
        connectionId,
        tokenExp: connection.tokenExp,
        nowSec,
      });
      return { allowed: false, reason: 'token-expired' };
    }
  }

  return { allowed: true, connection: connection || null };
}

module.exports = { checkConnectionAuth };
