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
  const role = queryParams.role || 'attendee';
  const displayName = queryParams.displayName || '';

  // Required parameters
  if (!token || !eventId) {
    console.error('Missing required query parameters', { connectionId, hasToken: !!token, hasEventId: !!eventId });
    return { statusCode: 401, body: 'Unauthorized: missing required parameters' };
  }

  // Verify the Cognito ID token. Identity (userId, email) comes from the
  // verified claims, never the query string — the client cannot lie about
  // who they are.
  const claims = await verifyIdToken(token);
  if (!claims) {
    console.error('Token verification failed', { connectionId, eventId });
    return { statusCode: 401, body: 'Unauthorized: invalid token' };
  }
  const userId = claims.sub;
  const email = claims.email || '';
  const tokenExp = typeof claims.exp === 'number' ? claims.exp : null;

  // Validate role (session-level, not a Cognito claim — it's the role the
  // user is *requesting* for this event session)
  const validRoles = ['presenter', 'co-presenter', 'attendee'];
  if (!validRoles.includes(role)) {
    console.error('Invalid role', { connectionId, role });
    return { statusCode: 401, body: 'Unauthorized: invalid role' };
  }

  try {
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

    // Remove stale connections for the same user+event (prevent duplicates)
    const existingConnections = await docClient.send(new QueryCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      IndexName: 'EventConnections',
      KeyConditionExpression: 'eventId = :eventId',
      ExpressionAttributeValues: { ':eventId': eventId },
    }));

    const staleConnections = (existingConnections.Items || []).filter(
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
        role,
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

    console.info('Connection stored', { connectionId, eventId, userId, role });

    // Broadcast ATTENDEE_JOINED to all connections for this event (exclude self — connection not fully established yet)
    try {
      await broadcast(eventId, {
        type: 'ATTENDEE_JOINED',
        eventId,
        data: { userId, displayName, email, role, connectionId },
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
