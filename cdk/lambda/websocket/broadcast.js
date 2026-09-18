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
 * Send a message to a specific list of connection IDs (targeted fan-out,
 * e.g. per-language caption lanes). Uses the same PostToConnection and
 * stale-connection (GoneException) cleanup mechanics as broadcast() but
 * without an event-wide connection query.
 *
 * @param {Array<string>} connectionIds - The target connection IDs.
 * @param {Object|string} message - The message payload to send.
 * @returns {Promise<{sent: number, failed: number, cleaned: number}>} Send result stats.
 */
async function sendToConnections(connectionIds, message) {
  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: WEBSOCKET_ENDPOINT,
  });

  const payload = typeof message === 'string' ? message : JSON.stringify(message);

  let sent = 0;
  let failed = 0;
  let cleaned = 0;

  const sendPromises = connectionIds.map(async (connectionId) => {
    try {
      await apiClient.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
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
            Key: { connectionId },
          }));
          cleaned++;
        } catch (deleteError) {
          console.error('Failed to clean stale connection', {
            connectionId,
            error: deleteError.message,
          });
        }
      } else {
        console.error('Failed to send message to connection', {
          connectionId,
          error: error.message,
        });
        failed++;
      }
    }
  });

  await Promise.all(sendPromises);

  return { sent, failed, cleaned };
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

  const connections = await getConnectionsForEvent(eventId);
  const connectionIds = connections
    .filter((connection) => !(excludeConnectionId && connection.connectionId === excludeConnectionId))
    .map((connection) => connection.connectionId);

  const { sent, failed, cleaned } = await sendToConnections(connectionIds, message);

  console.info('Broadcast complete', { eventId, sent, failed, cleaned, total: connections.length });
  return { sent, failed, cleaned };
}

module.exports = { broadcast, getConnectionsForEvent, sendToConnections };
