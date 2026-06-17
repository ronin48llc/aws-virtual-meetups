'use strict';

/**
 * DynamoDB utility helpers for the Virtual Meetup Platform.
 * Provides key builders, entity parsers, and batch operation helpers.
 * @module shared/dynamo-utils
 */

const { KEY_PREFIX, SK } = require('./constants');

/**
 * Build a partition key for an event.
 * @param {string} eventId - The event identifier.
 * @returns {string} The formatted PK, e.g. "EVENT#evt_abc123".
 */
function buildEventPK(eventId) {
  return `${KEY_PREFIX.EVENT}${eventId}`;
}

/**
 * Build a partition key for a user.
 * @param {string} userId - The user identifier.
 * @returns {string} The formatted PK, e.g. "USER#user_xyz".
 */
function buildUserPK(userId) {
  return `${KEY_PREFIX.USER}${userId}`;
}

/**
 * Build a sort key for an event sign-up.
 * @param {string} userId - The user identifier.
 * @returns {string} The formatted SK, e.g. "SIGNUP#user_xyz".
 */
function buildSignupSK(userId) {
  return `${KEY_PREFIX.SIGNUP}${userId}`;
}

/**
 * Build a sort key for a WebSocket connection.
 * @param {string} connectionId - The WebSocket connection identifier.
 * @returns {string} The formatted SK, e.g. "CONN#abc123".
 */
function buildConnectionSK(connectionId) {
  return `${KEY_PREFIX.CONN}${connectionId}`;
}

/**
 * Build a sort key for a raised hand.
 * @param {string} timestamp - ISO 8601 timestamp.
 * @param {string} userId - The user identifier.
 * @returns {string} The formatted SK, e.g. "HAND#2024-01-15T10:30:00Z#user_xyz".
 */
function buildHandSK(timestamp, userId) {
  return `${KEY_PREFIX.HAND}${timestamp}#${userId}`;
}

/**
 * Build a sort key for a question.
 * @param {string} timestamp - ISO 8601 timestamp.
 * @param {string} questionId - The question identifier.
 * @returns {string} The formatted SK, e.g. "QUESTION#2024-01-15T10:30:00Z#q_abc".
 */
function buildQuestionSK(timestamp, questionId) {
  return `${KEY_PREFIX.QUESTION}${timestamp}#${questionId}`;
}

/**
 * Build a GSI1 sort key for upcoming events.
 * @param {string} scheduledStart - ISO 8601 scheduled start time.
 * @param {string} eventId - The event identifier.
 * @returns {string} The formatted GSI1SK, e.g. "2024-01-15T10:30:00Z#evt_abc123".
 */
function buildGSI1SK(scheduledStart, eventId) {
  return `${scheduledStart}#${eventId}`;
}

/**
 * Build a GSI2 partition key for events by owner.
 * @param {string} userId - The owner user identifier.
 * @returns {string} The formatted GSI2PK, e.g. "USER#user_xyz#EVENTS".
 */
function buildGSI2PK(userId) {
  return `${KEY_PREFIX.USER}${userId}#EVENTS`;
}

/**
 * Parse the entity type from a sort key.
 * @param {string} sk - The sort key value.
 * @returns {string} The entity type (e.g. "SIGNUP", "CONN", "HAND", "QUESTION", "METADATA", "RECORDING", "PROFILE").
 */
function parseEntityType(sk) {
  if (sk === SK.METADATA) return 'METADATA';
  if (sk === SK.PROFILE) return 'PROFILE';
  if (sk === SK.RECORDING) return 'RECORDING';

  for (const [type, prefix] of Object.entries(KEY_PREFIX)) {
    if (sk.startsWith(prefix)) {
      return type;
    }
  }
  return 'UNKNOWN';
}

/**
 * Extract the identifier from a prefixed key.
 * @param {string} key - The prefixed key (e.g. "EVENT#evt_abc123").
 * @param {string} prefix - The prefix to strip (e.g. "EVENT#").
 * @returns {string} The extracted identifier.
 */
function extractId(key, prefix) {
  if (!key || !key.startsWith(prefix)) {
    return key;
  }
  return key.slice(prefix.length);
}

/**
 * Split an array into chunks for DynamoDB batch operations.
 * DynamoDB BatchWriteItem supports max 25 items per request.
 * @param {Array} items - The items to chunk.
 * @param {number} [size=25] - The chunk size (default 25 for DynamoDB batch limit).
 * @returns {Array<Array>} Array of chunked arrays.
 */
function chunk(items, size = 25) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Build a DynamoDB BatchWriteItem request for put operations.
 * @param {string} tableName - The DynamoDB table name.
 * @param {Array<Object>} items - The items to put.
 * @returns {Array<Object>} Array of BatchWriteItem request params (one per 25-item chunk).
 */
function buildBatchWriteParams(tableName, items) {
  return chunk(items).map((batch) => ({
    RequestItems: {
      [tableName]: batch.map((item) => ({
        PutRequest: { Item: item },
      })),
    },
  }));
}

/**
 * Build a DynamoDB BatchWriteItem request for delete operations.
 * @param {string} tableName - The DynamoDB table name.
 * @param {Array<Object>} keys - The key objects to delete (each with PK and SK).
 * @returns {Array<Object>} Array of BatchWriteItem request params (one per 25-item chunk).
 */
function buildBatchDeleteParams(tableName, keys) {
  return chunk(keys).map((batch) => ({
    RequestItems: {
      [tableName]: batch.map((key) => ({
        DeleteRequest: { Key: key },
      })),
    },
  }));
}

/**
 * Build a DynamoDB query params object.
 * @param {Object} options - Query options.
 * @param {string} options.tableName - The table name.
 * @param {string} options.pk - The partition key value.
 * @param {string} [options.skPrefix] - Optional sort key prefix for begins_with condition.
 * @param {string} [options.indexName] - Optional GSI name.
 * @param {boolean} [options.scanForward=true] - Sort direction.
 * @param {number} [options.limit] - Maximum items to return.
 * @returns {Object} DynamoDB query params.
 */
function buildQueryParams({ tableName, pk, skPrefix, indexName, scanForward = true, limit }) {
  const params = {
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': { S: pk } },
    ScanIndexForward: scanForward,
  };

  if (skPrefix) {
    params.KeyConditionExpression += ' AND begins_with(SK, :skPrefix)';
    params.ExpressionAttributeValues[':skPrefix'] = { S: skPrefix };
  }

  if (indexName) {
    params.IndexName = indexName;
  }

  if (limit) {
    params.Limit = limit;
  }

  return params;
}

// --- Anonymous Session Helpers ---

/**
 * Build a sort key for an anonymous session record.
 * Pattern: ANON#{fingerprint}#{sessionId}
 * @param {string} fingerprint - The browser fingerprint (hex string).
 * @param {string} sessionId - The unique session identifier.
 * @returns {string} The formatted SK, e.g. "ANON#a3f8b2c1d4e5f6a7#sess_abc123".
 */
function buildAnonSessionSK(fingerprint, sessionId) {
  return `${KEY_PREFIX.ANON}${fingerprint}#${sessionId}`;
}

/**
 * Build a partition key for a rate limit record.
 * Pattern: RATELIMIT#{fingerprint}
 * @param {string} fingerprint - The browser fingerprint.
 * @returns {string} The formatted PK, e.g. "RATELIMIT#a3f8b2c1d4e5f6a7".
 */
function buildRateLimitPK(fingerprint) {
  return `${KEY_PREFIX.RATELIMIT}${fingerprint}`;
}

/**
 * Build a sort key for a rate limit minute window.
 * Pattern: MINUTE#{isoMinute}
 * @param {string} isoMinute - ISO 8601 minute string (e.g. "2024-01-15T10:30").
 * @returns {string} The formatted SK, e.g. "MINUTE#2024-01-15T10:30".
 */
function buildRateLimitSK(isoMinute) {
  return `${KEY_PREFIX.MINUTE}${isoMinute}`;
}

/**
 * Build DynamoDB PutItem params for creating an anonymous session record.
 * @param {Object} options - Session options.
 * @param {string} options.tableName - The DynamoDB table name.
 * @param {string} options.eventId - The event identifier.
 * @param {string} options.fingerprint - The browser fingerprint.
 * @param {string} options.sessionId - The unique session identifier.
 * @param {string} options.sessionType - Session type: 'live' or 'playback'.
 * @returns {Object} DynamoDB PutItem params.
 */
function buildCreateAnonSessionParams({ tableName, eventId, fingerprint, sessionId, sessionType }) {
  const now = new Date().toISOString();
  const displayLabel = `Anon-${fingerprint.slice(0, 6)}`;
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours

  return {
    TableName: tableName,
    Item: {
      PK: { S: buildEventPK(eventId) },
      SK: { S: buildAnonSessionSK(fingerprint, sessionId) },
      fingerprint: { S: fingerprint },
      sessionId: { S: sessionId },
      displayLabel: { S: displayLabel },
      joinedAt: { S: now },
      sessionType: { S: sessionType },
      status: { S: 'active' },
      ttl: { N: String(ttl) },
    },
  };
}

/**
 * Build DynamoDB Query params to retrieve active anonymous sessions for an event.
 * Uses begins_with on SK prefix "ANON#" to get all anonymous sessions.
 * @param {Object} options - Query options.
 * @param {string} options.tableName - The DynamoDB table name.
 * @param {string} options.eventId - The event identifier.
 * @param {boolean} [options.activeOnly=true] - If true, filter to only active sessions.
 * @returns {Object} DynamoDB Query params.
 */
function buildQueryAnonSessionsParams({ tableName, eventId, activeOnly = true }) {
  const params = {
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': { S: buildEventPK(eventId) },
      ':skPrefix': { S: KEY_PREFIX.ANON },
    },
  };

  if (activeOnly) {
    params.FilterExpression = '#status = :active';
    params.ExpressionAttributeNames = { '#status': 'status' };
    params.ExpressionAttributeValues[':active'] = { S: 'active' };
  }

  return params;
}

/**
 * Build DynamoDB UpdateItem params to increment a rate limit counter with TTL.
 * Uses an atomic ADD operation to safely increment the counter.
 * The TTL is set to 120 seconds from now to allow for clock skew.
 * @param {Object} options - Rate limit options.
 * @param {string} options.tableName - The DynamoDB table name.
 * @param {string} options.fingerprint - The browser fingerprint.
 * @param {string} options.isoMinute - The current ISO minute window (e.g. "2024-01-15T10:30").
 * @returns {Object} DynamoDB UpdateItem params with ReturnValues set to return the new count.
 */
function buildIncrementRateLimitParams({ tableName, fingerprint, isoMinute }) {
  const ttl = Math.floor(Date.now() / 1000) + 120; // 120 seconds TTL

  return {
    TableName: tableName,
    Key: {
      PK: { S: buildRateLimitPK(fingerprint) },
      SK: { S: buildRateLimitSK(isoMinute) },
    },
    UpdateExpression: 'ADD #count :inc SET #ttl = :ttl',
    ExpressionAttributeNames: {
      '#count': 'count',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':inc': { N: '1' },
      ':ttl': { N: String(ttl) },
    },
    ReturnValues: 'ALL_NEW',
  };
}

/**
 * Build DynamoDB UpdateItem params to update an anonymous session status on disconnect.
 * Sets the status to 'disconnected' and records the leftAt timestamp.
 * @param {Object} options - Update options.
 * @param {string} options.tableName - The DynamoDB table name.
 * @param {string} options.eventId - The event identifier.
 * @param {string} options.fingerprint - The browser fingerprint.
 * @param {string} options.sessionId - The session identifier.
 * @returns {Object} DynamoDB UpdateItem params.
 */
function buildUpdateAnonSessionDisconnectParams({ tableName, eventId, fingerprint, sessionId }) {
  const now = new Date().toISOString();

  return {
    TableName: tableName,
    Key: {
      PK: { S: buildEventPK(eventId) },
      SK: { S: buildAnonSessionSK(fingerprint, sessionId) },
    },
    UpdateExpression: 'SET #status = :disconnected, #leftAt = :leftAt',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#leftAt': 'leftAt',
    },
    ExpressionAttributeValues: {
      ':disconnected': { S: 'disconnected' },
      ':leftAt': { S: now },
    },
  };
}

module.exports = {
  buildEventPK,
  buildUserPK,
  buildSignupSK,
  buildConnectionSK,
  buildHandSK,
  buildQuestionSK,
  buildGSI1SK,
  buildGSI2PK,
  parseEntityType,
  extractId,
  chunk,
  buildBatchWriteParams,
  buildBatchDeleteParams,
  buildQueryParams,
  // Anonymous session helpers
  buildAnonSessionSK,
  buildRateLimitPK,
  buildRateLimitSK,
  buildCreateAnonSessionParams,
  buildQueryAnonSessionsParams,
  buildIncrementRateLimitParams,
  buildUpdateAnonSessionDisconnectParams,
};
