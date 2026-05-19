'use strict';

/**
 * Rate limiter for WebSocket signaling actions.
 * Uses DynamoDB atomic counters with TTL for automatic cleanup.
 * Limits each connection to a maximum number of actions per time window.
 *
 * @module websocket/rate-limiter
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;

/** Maximum actions allowed per connection per time window */
const RATE_LIMIT = 60;

/** Time window in seconds for rate limiting */
const RATE_WINDOW_SECONDS = 60;

/**
 * Check if a connection has exceeded the rate limit.
 * Uses DynamoDB atomic counters stored in the connections table with TTL.
 * Fails open — if the check itself errors, the request is allowed through.
 *
 * @param {string} connectionId - The WebSocket connection ID to check.
 * @returns {Promise<{allowed: boolean, count: number}>} Whether the request is allowed and current count.
 */
async function checkRateLimit(connectionId) {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `RATELIMIT#${connectionId}#${Math.floor(now / RATE_WINDOW_SECONDS)}`;

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      Key: { connectionId: windowKey },
      UpdateExpression: 'ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#count': 'actionCount', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':inc': 1, ':ttl': now + RATE_WINDOW_SECONDS + 10 },
      ReturnValues: 'ALL_NEW',
    }));

    const count = (result && result.Attributes && result.Attributes.actionCount) || 0;
    return { allowed: count <= RATE_LIMIT, count };
  } catch (err) {
    // Fail open — allow the request if rate limiting check fails
    console.error('Rate limit check failed', { connectionId, error: err.message });
    return { allowed: true, count: 0 };
  }
}

module.exports = { checkRateLimit, RATE_LIMIT, RATE_WINDOW_SECONDS };
