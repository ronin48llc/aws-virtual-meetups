'use strict';

/**
 * WebSocket $connect handler.
 * Authenticates via query string token and stores connection in WebSocketConnections table.
 * @module websocket/connect
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { broadcast } = require('./broadcast');

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
  const userId = queryParams.userId;
  const claimedRole = queryParams.role || 'attendee';
  const displayName = queryParams.displayName || '';
  const email = queryParams.email || '';

  // Validate required parameters
  if (!token || !eventId || !userId) {
    console.error('Missing required query parameters', { connectionId, hasToken: !!token, hasEventId: !!eventId, hasUserId: !!userId });
    return { statusCode: 401, body: 'Unauthorized: missing required parameters' };
  }

  // Validate claimed role is one of the known values.
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
        role: verifiedRole,
        displayName,
        email,
        connectedAt: now.toISOString(),
        ttl,
      },
    }));

    console.info('Connection stored', { connectionId, eventId, userId, role: verifiedRole });

    // Broadcast ATTENDEE_JOINED to all connections for this event (exclude self — connection not fully established yet)
    try {
      await broadcast(eventId, {
        type: 'ATTENDEE_JOINED',
        eventId,
        data: { userId, displayName, email, role: verifiedRole, connectionId },
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
