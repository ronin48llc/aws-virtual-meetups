'use strict';

/**
 * WebSocket broadcast utility.
 * Fans out messages to all connections for a given event via API Gateway Management API.
 * @module websocket/broadcast
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;

/**
 * Get all connections for a given event using the EventConnections GSI.
 *
 * @param {string} eventId - The event identifier.
 * @returns {Promise<Array<Object>>} Array of connection records.
 */
async function getConnectionsForEvent(eventId) {
  const connections = [];
  let lastEvaluatedKey;

  do {
    const params = {
      TableName: TABLE_NAME,
      IndexName: 'EventConnections',
      KeyConditionExpression: 'eventId = :eventId',
      ExpressionAttributeValues: { ':eventId': eventId },
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await docClient.send(new QueryCommand(params));
    connections.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return connections;
}

/**
 * Broadcast a message to all WebSocket connections for a given event.
 * Stale connections (GoneException) are automatically cleaned up.
 *
 * @param {string} eventId - The event to broadcast to.
 * @param {Object|string} message - The message payload to send.
 * @param {Object} [options] - Optional configuration.
 * @param {string} [options.excludeConnectionId] - Connection ID to exclude from broadcast.
 * @returns {Promise<{sent: number, failed: number, cleaned: number}>} Broadcast result stats.
 */
async function broadcast(eventId, message, options = {}) {
  const { excludeConnectionId } = options;

  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: WEBSOCKET_ENDPOINT,
  });

  const connections = await getConnectionsForEvent(eventId);
  const payload = typeof message === 'string' ? message : JSON.stringify(message);

  let sent = 0;
  let failed = 0;
  let cleaned = 0;

  const sendPromises = connections.map(async (connection) => {
    if (excludeConnectionId && connection.connectionId === excludeConnectionId) {
      return;
    }

    try {
      await apiClient.send(new PostToConnectionCommand({
        ConnectionId: connection.connectionId,
        Data: payload,
      }));
      sent++;
    } catch (error) {
      if (error.statusCode === 410 || error.name === 'GoneException') {
        // Connection is stale — clean it up
        try {
          const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { connectionId: connection.connectionId },
          }));
          cleaned++;
        } catch (deleteError) {
          console.error('Failed to clean stale connection', {
            connectionId: connection.connectionId,
            error: deleteError.message,
          });
        }
      } else {
        console.error('Failed to send message to connection', {
          connectionId: connection.connectionId,
          error: error.message,
        });
        failed++;
      }
    }
  });

  await Promise.all(sendPromises);

  console.info('Broadcast complete', { eventId, sent, failed, cleaned, total: connections.length });
  return { sent, failed, cleaned };
}

module.exports = { broadcast, getConnectionsForEvent };
