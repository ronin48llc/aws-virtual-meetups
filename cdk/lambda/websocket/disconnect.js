'use strict';

/**
 * WebSocket $disconnect handler.
 * Removes connection from WebSocketConnections table on disconnect.
 * @module websocket/disconnect
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { broadcast } = require('./broadcast');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;

/**
 * Handle WebSocket $disconnect route.
 * Removes the connection record from DynamoDB.
 *
 * @param {Object} event - API Gateway WebSocket event.
 * @returns {Object} Response with statusCode 200.
 */
async function handler(event) {
  const connectionId = event.requestContext.connectionId;

  try {
    // Read connection record before delete to get eventId and userId for broadcast
    let connectionRecord = null;
    try {
      const getResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { connectionId },
      }));
      connectionRecord = getResult.Item || null;
    } catch (getError) {
      console.error('Failed to read connection before delete', { connectionId, error: getError.message });
    }

    // Always attempt delete (idempotent)
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { connectionId },
    }));

    console.info('Connection removed', { connectionId });

    // Broadcast ATTENDEE_LEFT if we have the connection data
    if (connectionRecord) {
      try {
        await broadcast(connectionRecord.eventId, {
          type: 'ATTENDEE_LEFT',
          eventId: connectionRecord.eventId,
          data: { userId: connectionRecord.userId, connectionId },
        });
      } catch (broadcastError) {
        console.error('Failed to broadcast ATTENDEE_LEFT', { connectionId, error: broadcastError.message });
      }
    }

    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Failed to remove connection', { connectionId, error: error.message });
    // Return 200 even on error — disconnect is best-effort, TTL will clean up
    return { statusCode: 200, body: 'Disconnected' };
  }
}

module.exports = { handler };
