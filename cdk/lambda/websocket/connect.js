'use strict';

/**
 * WebSocket $connect handler.
 * Verifies the Cognito ID token from the query string, stores connection
 * metadata (including token expiry) in the WebSocketConnections table.
 * @module websocket/connect
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { broadcast } = require('./broadcast');
const { verifyIdToken } = require('../shared/jwt-verifier');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;

// Connection TTL: 24 hours (max event duration)
const CONNECTION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Handle WebSocket $connect route.
 * Authenticates the connection via query string token and stores connection metadata.
 *
 * @param {Object} event - API Gateway WebSocket event.
 * @returns {Object} Response with statusCode 200 (allow) or 401 (deny).
 */
async function handler(event) {
  const connectionId = event.requestContext.connectionId;
  const queryParams = event.queryStringParameters || {};

  const token = queryParams.token;
  const eventId = queryParams.eventId;
  const claimedRole = queryParams.role || 'attendee';
  const displayName = queryParams.displayName || '';
  const isAnonymous = queryParams.anonymous === 'true';
  const sessionId = queryParams.sessionId || '';

  // Required parameters
  if (!eventId) {
    console.error('Missing eventId', { connectionId });
    return { statusCode: 401, body: 'Unauthorized: missing required parameters' };
  }

  // Anonymous connections — store with limited metadata, no token verification
  if (isAnonymous && sessionId) {
    try {
      const now = new Date();
      const ttl = Math.floor(now.getTime() / 1000) + CONNECTION_TTL_SECONDS;

      await docClient.send(new PutCommand({
        TableName: CONNECTIONS_TABLE_NAME,
        Item: {
          connectionId,
          eventId,
          userId: `anon-${sessionId.slice(0, 8)}`,
          role: 'anonymous',
          displayName: `Anon-${sessionId.slice(0, 6)}`,
          email: '',
          connectedAt: now.toISOString(),
          ttl,
          anonymous: true,
          sessionId,
        },
      }));

      // Broadcast ANON_JOINED to presenter
      try {
        await broadcast(eventId, {
          type: 'ANON_JOINED',
          eventId,
          data: {
            fingerprint: sessionId.slice(0, 12),
            label: `Anon-${sessionId.slice(0, 6)}`,
            sessionId,
            joinedAt: now.toISOString(),
          },
        }, { excludeConnectionId: connectionId });
      } catch (broadcastError) {
        console.error('Failed to broadcast ANON_JOINED', { connectionId, error: broadcastError.message });
      }

      console.info('Anonymous connection stored', { connectionId, eventId, sessionId: sessionId.slice(0, 8) });
      return { statusCode: 200, body: 'Connected (anonymous)' };
    } catch (error) {
      console.error('Failed to store anonymous connection', { connectionId, error: error.message });
      return { statusCode: 500, body: 'Internal server error' };
    }
  }

  // Authenticated connections require a token
  if (!token) {
    console.error('Missing token for authenticated connection', { connectionId });
    return { statusCode: 401, body: 'Unauthorized: missing required parameters' };
  }

  // Verify the Cognito ID token. Identity (userId, email) comes from the
  // verified claims, never the query string — the client cannot lie about
  // who they are. (issue #4)
  const claims = await verifyIdToken(token);
  if (!claims) {
    console.error('Token verification failed', { connectionId, eventId });
    return { statusCode: 401, body: 'Unauthorized: invalid token' };
  }
  const userId = claims.sub;
  const email = claims.email || '';
  const tokenExp = typeof claims.exp === 'number' ? claims.exp : null;

  // Validate the claimed role is one of the known values. The query string is
  // client-controlled, so we still re-verify the actual role against event
  // ownership below (issue #83).
  const validRoles = ['presenter', 'co-presenter', 'attendee'];
  if (!validRoles.includes(claimedRole)) {
    console.error('Invalid role', { connectionId, claimedRole });
    return { statusCode: 401, body: 'Unauthorized: invalid role' };
  }

  try {
    // Issue #83: verify the claimed role against the event's ownership data.
    // The query string is client-controlled, so trusting `claimedRole` as-is
    // means any attendee can connect with role=presenter and bypass every
    // downstream connection.role check (PR #71, #80, token-generator).
    // Minimum viable rule: owner -> presenter, everyone else -> attendee.
    // Co-presenter persistence across reconnects is intentionally NOT
    // supported here; promotion must be re-issued by the presenter via the
    // `promoteUser` WS action each session.
    let verifiedRole = 'attendee';
    if (TABLE_NAME) {
      const eventResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `EVENT#${eventId}`, SK: 'METADATA' },
      }));

      if (!eventResult.Item) {
        console.error('Event not found at $connect', { connectionId, eventId });
        return { statusCode: 401, body: 'Unauthorized: event not found' };
      }

      if (eventResult.Item.ownerUserId === userId) {
        verifiedRole = 'presenter';
      }
      // else: stays 'attendee' — co-presenter promotions must come from the
      // server-mediated `promoteUser` action during the session.
    } else {
      // Test / pre-deploy environments without TABLE_NAME fall through with
      // attendee role. Production stack ALWAYS sets TABLE_NAME.
      verifiedRole = 'attendee';
    }

    if (claimedRole !== verifiedRole) {
      console.warn('Role downgraded at $connect', {
        connectionId, eventId, userId, claimedRole, verifiedRole,
      });
    }

    // Check if user is banned from this event
    if (TABLE_NAME) {
      const banRecord = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `EVENT#${eventId}`, SK: `BAN#${userId}` },
      }));

      if (banRecord.Item) {
        console.error('User is banned from event', { connectionId, eventId, userId });
        return { statusCode: 401, body: 'You are banned from this event' };
      }
    }

    // Remove stale connections for the same user+event (prevent duplicates).
    // Loop through DDB Query pages — single-page reads silently miss any
    // stale connection past the 1 MB page cap, so on large events the
    // reconnecting user accumulates duplicate connections and receives
    // every broadcast twice. See issue #68.
    const existingConnectionItems = [];
    let dedupExclusiveStartKey;
    do {
      const dedupParams = {
        TableName: CONNECTIONS_TABLE_NAME,
        IndexName: 'EventConnections',
        KeyConditionExpression: 'eventId = :eventId',
        ExpressionAttributeValues: { ':eventId': eventId },
      };
      if (dedupExclusiveStartKey) {
        dedupParams.ExclusiveStartKey = dedupExclusiveStartKey;
      }
      const dedupResult = await docClient.send(new QueryCommand(dedupParams));
      existingConnectionItems.push(...(dedupResult.Items || []));
      dedupExclusiveStartKey = dedupResult.LastEvaluatedKey;
    } while (dedupExclusiveStartKey);

    const staleConnections = existingConnectionItems.filter(
      (conn) => conn.userId === userId && conn.connectionId !== connectionId
    );

    for (const staleConn of staleConnections) {
      try {
        await docClient.send(new DeleteCommand({
          TableName: CONNECTIONS_TABLE_NAME,
          Key: { connectionId: staleConn.connectionId },
        }));
        console.info('Removed stale connection', { staleConnectionId: staleConn.connectionId, eventId, userId });
      } catch (deleteError) {
        console.error('Failed to remove stale connection', { staleConnectionId: staleConn.connectionId, error: deleteError.message });
      }
    }

    const now = new Date();
    const ttl = Math.floor(now.getTime() / 1000) + CONNECTION_TTL_SECONDS;

    await docClient.send(new PutCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      Item: {
        connectionId,
        eventId,
        userId,
        role: verifiedRole,
        displayName,
        email,
        connectedAt: now.toISOString(),
        ttl,
        // Per-message auth: signaling.js compares tokenExp against the
        // current time on every message and rejects expired connections.
        // See issue #4.
        tokenExp,
      },
    }));

    console.info('Connection stored', { connectionId, eventId, userId, role: verifiedRole });

    // Broadcast ATTENDEE_JOINED to all connections for this event (exclude
    // self — connection not fully established yet). Issue #85: do NOT
    // include email in the broadcast — every attendee receives this, and
    // emails would be harvestable by any participant.
    try {
      await broadcast(eventId, {
        type: 'ATTENDEE_JOINED',
        eventId,
        // Issue #85: do not include `email` in the broadcast payload.
        data: { userId, displayName, role: verifiedRole, connectionId },
      }, { excludeConnectionId: connectionId });
    } catch (broadcastError) {
      console.error('Failed to broadcast ATTENDEE_JOINED', { connectionId, eventId, error: broadcastError.message });
    }

    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error('Failed to store connection', { connectionId, error: error.message });
    return { statusCode: 500, body: 'Internal server error' };
  }
}

module.exports = { handler };
