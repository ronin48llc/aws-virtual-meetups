'use strict';

/**
 * WebSocket signaling handler for hand-raising, question queue, role management, chat control, messaging, mute/participation controls, and abuse management actions.
 * Routes based on the `action` field in the WebSocket message body.
 * Supports: raiseHand, lowerHand, lowerAllHands, submitQuestion, answerQuestion, dismissQuestion,
 *           promoteUser, demoteUser, grantSpeak, revokeSpeak, toggleChat, sendGroupMessage, sendDirectMessage,
 *           muteAudio, muteVideo, restrictChat, restrictQuestions, globalMuteAudio, globalMuteVideo,
 *           kickUser, banUser, unbanUser, listBans, acknowledgeHand, dismissHand,
 *           getAttendeeList, getQuestionQueue, getHandsList
 * @module websocket/signaling
 */

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, UpdateCommand, BatchWriteCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { IVSRealTimeClient, DisconnectParticipantCommand } = require('@aws-sdk/client-ivs-realtime');
const { IvschatClient, DisconnectUserCommand } = require('@aws-sdk/client-ivschat');
const { broadcast, getConnectionsForEvent } = require('./broadcast');
const { checkRateLimit } = require('./rate-limiter');
const { buildEventPK, buildHandSK, buildQuestionSK, chunk } = require('../shared/dynamo-utils');
const { KEY_PREFIX, SK, SESSION_ROLE, QUESTION_STATUS } = require('../shared/constants');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ivsRealTimeClient = new IVSRealTimeClient({});
const ivsChatClient = new IvschatClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;

/**
 * Main handler — routes WebSocket messages by action.
 *
 * @param {Object} event - API Gateway WebSocket event.
 * @returns {Object} Response with statusCode.
 */
async function handler(event) {
  const connectionId = event.requestContext.connectionId;
  let body;

  try {
    body = JSON.parse(event.body);
  } catch (err) {
    console.error('Invalid JSON body', { connectionId, error: err.message });
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const action = body.action;
  const eventId = body.eventId;

  if (!eventId) {
    console.error('Missing eventId', { connectionId, action });
    return { statusCode: 400, body: 'Missing eventId' };
  }

  // -------------------------------------------------------
  // Rate Limiting: max 60 actions per connection per minute
  // Uses the connections table with TTL for automatic cleanup.
  // -------------------------------------------------------
  const rateCheck = await checkRateLimit(connectionId);
  if (!rateCheck.allowed) {
    console.warn('Rate limit exceeded', { connectionId, action, eventId, count: rateCheck.count });
    return { statusCode: 429, body: 'Rate limit exceeded. Please slow down.' };
  }

  try {
    switch (action) {
      case 'raiseHand':
        return await handleRaiseHand(eventId, body, connectionId);
      case 'lowerHand':
        return await handleLowerHand(eventId, body, connectionId);
      case 'lowerAllHands':
        return await handleLowerAllHands(eventId, body, connectionId);
      case 'submitQuestion':
        return await handleSubmitQuestion(eventId, body, connectionId);
      case 'answerQuestion':
        return await handleAnswerQuestion(eventId, body, connectionId);
      case 'dismissQuestion':
        return await handleDismissQuestion(eventId, body, connectionId);
      case 'promoteUser':
        return await handlePromoteUser(eventId, body, connectionId);
      case 'demoteUser':
        return await handleDemoteUser(eventId, body, connectionId);
      case 'grantSpeak':
        return await handleGrantSpeak(eventId, body, connectionId);
      case 'revokeSpeak':
        return await handleRevokeSpeak(eventId, body, connectionId);
      case 'toggleChat':
        return await handleToggleChat(eventId, body, connectionId);
      case 'sendGroupMessage':
        return await handleSendGroupMessage(eventId, body, connectionId);
      case 'sendDirectMessage':
        return await handleSendDirectMessage(eventId, body, connectionId);
      case 'muteAudio':
        return await handleMuteAudio(eventId, body, connectionId);
      case 'muteVideo':
        return await handleMuteVideo(eventId, body, connectionId);
      case 'restrictChat':
        return await handleRestrictChat(eventId, body, connectionId);
      case 'restrictQuestions':
        return await handleRestrictQuestions(eventId, body, connectionId);
      case 'globalMuteAudio':
        return await handleGlobalMuteAudio(eventId, body, connectionId);
      case 'globalMuteVideo':
        return await handleGlobalMuteVideo(eventId, body, connectionId);
      case 'kickUser':
        return await handleKickUser(eventId, body, connectionId);
      case 'banUser':
        return await handleBanUser(eventId, body, connectionId);
      case 'unbanUser':
        return await handleUnbanUser(eventId, body, connectionId);
      case 'listBans':
        return await handleListBans(eventId, body, connectionId);
      case 'acknowledgeHand':
        return await handleAcknowledgeHand(eventId, body, connectionId);
      case 'dismissHand':
        return await handleDismissHand(eventId, body, connectionId);
      case 'getAttendeeList':
        return await handleGetAttendeeList(eventId, body, connectionId);
      case 'getQuestionQueue':
        return await handleGetQuestionQueue(eventId, body, connectionId);
      case 'getHandsList':
        return await handleGetHandsList(eventId, body, connectionId);
      case 'pinQuestion':
        return await handlePinQuestion(eventId, body, connectionId);
      case 'unpinQuestion':
        return await handleUnpinQuestion(eventId, body, connectionId);
      case 'typing':
        return await handleTyping(eventId, body, connectionId);
      case 'broadcastCaption':
        return await handleBroadcastCaption(eventId, body, connectionId);
      default:
        console.error('Unknown action', { connectionId, action });
        return { statusCode: 400, body: `Unknown action: ${action}` };
    }
  } catch (error) {
    console.error('Handler error', { connectionId, action, eventId, error: error.message });
    return { statusCode: 500, body: 'Internal server error' };
  }
}

/**
 * Handle raiseHand action.
 * Stores a hand item in DynamoDB and broadcasts HAND_RAISED to the event.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID.
 * @returns {Object} Response with statusCode 200.
 */
async function handleRaiseHand(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const displayName = body.data?.displayName || body.displayName || '';

  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  const timestamp = new Date().toISOString();
  const pk = buildEventPK(eventId);
  const sk = buildHandSK(timestamp, userId);

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: pk,
      SK: sk,
      eventId,
      userId,
      displayName,
      timestamp,
      type: 'HAND',
    },
  }));

  await broadcast(eventId, {
    type: 'HAND_RAISED',
    eventId,
    data: {
      userId,
      displayName,
      timestamp,
    },
  });

  console.info('Hand raised', { eventId, userId, timestamp });
  return { statusCode: 200, body: 'Hand raised' };
}

/**
 * Handle lowerHand action.
 * Deletes the specific hand item from DynamoDB and broadcasts HAND_LOWERED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID.
 * @returns {Object} Response with statusCode 200.
 */
async function handleLowerHand(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const timestamp = body.data?.timestamp || body.timestamp;

  if (!userId || !timestamp) {
    return { statusCode: 400, body: 'Missing userId or timestamp' };
  }

  const pk = buildEventPK(eventId);
  const sk = buildHandSK(timestamp, userId);

  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
  }));

  await broadcast(eventId, {
    type: 'HAND_LOWERED',
    eventId,
    data: {
      userId,
      timestamp,
    },
  });

  console.info('Hand lowered', { eventId, userId, timestamp });
  return { statusCode: 200, body: 'Hand lowered' };
}

/**
 * Handle lowerAllHands action.
 * Queries all HAND# items for the event, batch deletes them, and broadcasts HANDS_CLEARED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID.
 * @returns {Object} Response with statusCode 200.
 */
async function handleLowerAllHands(eventId, body, connectionId) {
  const pk = buildEventPK(eventId);

  // Query all HAND# items for this event
  const hands = [];
  let lastEvaluatedKey;

  do {
    const params = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':skPrefix': KEY_PREFIX.HAND,
      },
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await docClient.send(new QueryCommand(params));
    hands.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const count = hands.length;

  // Batch delete all hand items (25 per batch, DynamoDB limit)
  if (count > 0) {
    const batches = chunk(hands, 25);
    for (const batch of batches) {
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: batch.map((item) => ({
            DeleteRequest: {
              Key: { PK: item.PK, SK: item.SK },
            },
          })),
        },
      }));
    }
  }

  await broadcast(eventId, {
    type: 'HANDS_CLEARED',
    eventId,
    data: {
      count,
    },
  });

  console.info('All hands lowered', { eventId, count });
  return { statusCode: 200, body: 'All hands lowered' };
}

/**
 * Handle submitQuestion action.
 * Stores a question item in DynamoDB and broadcasts QUESTION_SUBMITTED to the event.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID.
 * @returns {Object} Response with statusCode 200.
 */
async function handleSubmitQuestion(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const displayName = body.data?.displayName || body.displayName || '';
  const text = body.data?.text || body.text;

  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  if (!text) {
    return { statusCode: 400, body: 'Missing question text' };
  }

  // Check if the sender's question submission is restricted
  const senderConn = await docClient.send(new GetCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId },
  }));

  if (senderConn.Item?.questionsRestricted) {
    await sendToConnection(connectionId, {
      type: 'QUESTIONS_RESTRICTED',
      eventId,
      data: {
        message: 'Your question submission has been restricted by the presenter',
      },
    });

    console.info('Question rejected — questions restricted for user', { eventId, userId, connectionId });
    return { statusCode: 200, body: 'Questions restricted' };
  }

  const questionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const pk = buildEventPK(eventId);
  const sk = buildQuestionSK(timestamp, questionId);

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: pk,
      SK: sk,
      eventId,
      questionId,
      userId,
      displayName,
      text,
      status: QUESTION_STATUS.QUEUED,
      submittedAt: timestamp,
      type: 'QUESTION',
    },
  }));

  await broadcast(eventId, {
    type: 'QUESTION_SUBMITTED',
    eventId,
    data: {
      questionId,
      userId,
      displayName,
      text,
      status: QUESTION_STATUS.QUEUED,
      submittedAt: timestamp,
    },
  });

  console.info('Question submitted', { eventId, userId, questionId, timestamp });
  return { statusCode: 200, body: 'Question submitted' };
}

/**
 * Handle answerQuestion action.
 * Updates question status to "answered" and broadcasts QUESTION_ANSWERED to the event.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID.
 * @returns {Object} Response with statusCode 200.
 */
async function handleAnswerQuestion(eventId, body, connectionId) {
  const questionId = body.data?.questionId || body.questionId;
  const timestamp = body.data?.timestamp || body.timestamp;
  const answer = body.data?.answer || body.answer || '';

  if (!questionId || !timestamp) {
    return { statusCode: 400, body: 'Missing questionId or timestamp' };
  }

  const pk = buildEventPK(eventId);
  const sk = buildQuestionSK(timestamp, questionId);

  // Update status and store answer text
  const updateExpression = answer
    ? 'SET #status = :status, #answer = :answer'
    : 'SET #status = :status';
  const expressionNames = { '#status': 'status' };
  const expressionValues = { ':status': QUESTION_STATUS.ANSWERED };
  if (answer) {
    expressionNames['#answer'] = 'answer';
    expressionValues[':answer'] = answer;
  }

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
  }));

  await broadcast(eventId, {
    type: 'QUESTION_ANSWERED',
    eventId,
    data: {
      questionId,
      timestamp,
      answer,
    },
  });

  console.info('Question answered', { eventId, questionId, timestamp });
  return { statusCode: 200, body: 'Question answered' };
}

/**
 * Handle dismissQuestion action.
 * Updates question status to "dismissed" and broadcasts QUESTION_DISMISSED to the event.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID.
 * @returns {Object} Response with statusCode 200.
 */
async function handleDismissQuestion(eventId, body, connectionId) {
  const questionId = body.data?.questionId || body.questionId;
  const timestamp = body.data?.timestamp || body.timestamp;

  if (!questionId || !timestamp) {
    return { statusCode: 400, body: 'Missing questionId or timestamp' };
  }

  const pk = buildEventPK(eventId);
  const sk = buildQuestionSK(timestamp, questionId);

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': QUESTION_STATUS.DISMISSED },
  }));

  await broadcast(eventId, {
    type: 'QUESTION_DISMISSED',
    eventId,
    data: {
      questionId,
      timestamp,
    },
  });

  console.info('Question dismissed', { eventId, questionId, timestamp });
  return { statusCode: 200, body: 'Question dismissed' };
}

/**
 * Handle promoteUser action.
 * Updates the connection role to co-presenter and broadcasts ROLE_CHANGED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handlePromoteUser(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId) {
    return { statusCode: 400, body: 'Missing targetConnectionId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #role = :role',
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: { ':role': SESSION_ROLE.CO_PRESENTER },
  }));

  await broadcast(eventId, {
    type: 'ROLE_CHANGED',
    eventId,
    data: {
      connectionId: targetConnectionId,
      userId,
      newRole: SESSION_ROLE.CO_PRESENTER,
    },
  });

  console.info('User promoted to co-presenter', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'User promoted' };
}

/**
 * Handle demoteUser action.
 * Reverts the connection role to attendee, revokes speak permission, and broadcasts ROLE_CHANGED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleDemoteUser(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId) {
    return { statusCode: 400, body: 'Missing targetConnectionId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #role = :role, #hasSpeakPermission = :speak',
    ExpressionAttributeNames: { '#role': 'role', '#hasSpeakPermission': 'hasSpeakPermission' },
    ExpressionAttributeValues: { ':role': SESSION_ROLE.ATTENDEE, ':speak': false },
  }));

  await broadcast(eventId, {
    type: 'ROLE_CHANGED',
    eventId,
    data: {
      connectionId: targetConnectionId,
      userId,
      newRole: SESSION_ROLE.ATTENDEE,
    },
  });

  console.info('User demoted to attendee', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'User demoted' };
}

/**
 * Handle grantSpeak action.
 * Updates hasSpeakPermission to true on the connection and broadcasts SPEAK_PERMISSION_CHANGED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleGrantSpeak(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId) {
    return { statusCode: 400, body: 'Missing targetConnectionId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #hasSpeakPermission = :speak',
    ExpressionAttributeNames: { '#hasSpeakPermission': 'hasSpeakPermission' },
    ExpressionAttributeValues: { ':speak': true },
  }));

  await broadcast(eventId, {
    type: 'SPEAK_PERMISSION_CHANGED',
    eventId,
    data: {
      connectionId: targetConnectionId,
      userId,
      hasSpeakPermission: true,
    },
  });

  console.info('Speak permission granted', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'Speak permission granted' };
}

/**
 * Handle revokeSpeak action.
 * Updates hasSpeakPermission to false on the connection and broadcasts SPEAK_PERMISSION_CHANGED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleRevokeSpeak(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId) {
    return { statusCode: 400, body: 'Missing targetConnectionId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #hasSpeakPermission = :speak',
    ExpressionAttributeNames: { '#hasSpeakPermission': 'hasSpeakPermission' },
    ExpressionAttributeValues: { ':speak': false },
  }));

  await broadcast(eventId, {
    type: 'SPEAK_PERMISSION_CHANGED',
    eventId,
    data: {
      connectionId: targetConnectionId,
      userId,
      hasSpeakPermission: false,
    },
  });

  console.info('Speak permission revoked', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'Speak permission revoked' };
}

/**
 * Handle toggleChat action.
 * Stores chat enabled/disabled state on event metadata and broadcasts CHAT_STATE_CHANGED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleToggleChat(eventId, body, connectionId) {
  const enabled = body.data?.enabled;

  if (typeof enabled !== 'boolean') {
    return { statusCode: 400, body: 'Missing or invalid enabled field' };
  }

  const pk = buildEventPK(eventId);

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: SK.METADATA },
    UpdateExpression: 'SET #chatEnabled = :chatEnabled',
    ExpressionAttributeNames: { '#chatEnabled': 'chatEnabled' },
    ExpressionAttributeValues: { ':chatEnabled': enabled },
  }));

  await broadcast(eventId, {
    type: 'CHAT_STATE_CHANGED',
    eventId,
    data: {
      chatEnabled: enabled,
    },
  });

  console.info('Chat state toggled', { eventId, chatEnabled: enabled });
  return { statusCode: 200, body: `Chat ${enabled ? 'enabled' : 'disabled'}` };
}

/**
 * Send a message to a specific WebSocket connection via API Gateway Management API.
 *
 * @param {string} connectionId - The target connection ID.
 * @param {Object} message - The message payload to send.
 * @returns {Promise<void>}
 */
async function sendToConnection(connectionId, message) {
  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: WEBSOCKET_ENDPOINT,
  });

  const payload = typeof message === 'string' ? message : JSON.stringify(message);

  await apiClient.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: payload,
  }));
}

/**
 * Handle sendGroupMessage action.
 * Checks if chat is enabled for the event, then broadcasts the message to all participants.
 * If chat is disabled, sends a CHAT_DISABLED notification back to the sender only.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the sender.
 * @returns {Object} Response with statusCode 200.
 */
async function handleSendGroupMessage(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const displayName = body.data?.displayName || body.displayName || '';
  const message = body.data?.message || body.message;

  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  if (!message) {
    return { statusCode: 400, body: 'Missing message' };
  }

  // Check if the sender's chat is restricted
  const senderConn = await docClient.send(new GetCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId },
  }));

  if (senderConn.Item?.chatRestricted) {
    await sendToConnection(connectionId, {
      type: 'CHAT_RESTRICTED',
      eventId,
      data: {
        message: 'Your chat participation has been restricted by the presenter',
      },
    });

    console.info('Group message rejected — chat restricted for user', { eventId, userId, connectionId });
    return { statusCode: 200, body: 'Chat restricted' };
  }

  // Fetch event metadata to check chatEnabled flag
  const pk = buildEventPK(eventId);
  const metadataResult = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: SK.METADATA },
  }));

  const metadata = metadataResult.Item;
  const chatEnabled = metadata?.chatEnabled !== false; // Default to true if not explicitly set

  if (!chatEnabled) {
    // Send CHAT_DISABLED notification back to sender only
    await sendToConnection(connectionId, {
      type: 'CHAT_DISABLED',
      eventId,
      data: {
        message: 'Group chat is currently disabled by the presenter',
      },
    });

    console.info('Group message rejected — chat disabled', { eventId, userId, connectionId });
    return { statusCode: 200, body: 'Chat disabled' };
  }

  const timestamp = new Date().toISOString();

  // Broadcast the message to all connections for the event
  await broadcast(eventId, {
    type: 'GROUP_MESSAGE',
    eventId,
    data: {
      userId,
      displayName,
      message,
      timestamp,
    },
  });

  console.info('Group message sent', { eventId, userId, timestamp });
  return { statusCode: 200, body: 'Message sent' };
}

/**
 * Handle sendDirectMessage action.
 * Routes the message only to presenter connection(s) and sends delivery confirmation to sender.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the sender.
 * @returns {Object} Response with statusCode 200.
 */
async function handleSendDirectMessage(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const displayName = body.data?.displayName || body.displayName || '';
  const message = body.data?.message || body.message;
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;

  if (!message) {
    return { statusCode: 400, body: 'Missing message' };
  }

  const timestamp = new Date().toISOString();

  // Get sender's display name from their connection record
  let senderDisplayName = displayName;
  if (!senderDisplayName) {
    try {
      const senderConn = await docClient.send(new GetCommand({
        TableName: CONNECTIONS_TABLE_NAME,
        Key: { connectionId },
      }));
      senderDisplayName = senderConn.Item?.displayName || senderConn.Item?.email || userId || 'Unknown';
    } catch (e) {
      senderDisplayName = userId || 'Unknown';
    }
  }

  const directMessage = {
    type: 'DIRECT_MESSAGE',
    eventId,
    data: {
      userId: userId || connectionId,
      displayName: senderDisplayName,
      message,
      timestamp,
    },
  };

  if (targetConnectionId) {
    // Presenter sending to a specific attendee
    try {
      await sendToConnection(targetConnectionId, directMessage);
    } catch (error) {
      console.error('Failed to send direct message to target', {
        targetConnectionId,
        error: error.message,
      });
    }
  } else {
    // Attendee sending to all presenters
    const connections = await getConnectionsForEvent(eventId);
    const presenterConnections = connections.filter(
      (conn) => conn.role === SESSION_ROLE.PRESENTER
    );

    for (const presenterConn of presenterConnections) {
      try {
        await sendToConnection(presenterConn.connectionId, directMessage);
      } catch (error) {
        console.error('Failed to send direct message to presenter', {
          connectionId: presenterConn.connectionId,
          error: error.message,
        });
      }
    }
  }

  // Send delivery confirmation back to the sender
  await sendToConnection(connectionId, {
    type: 'DIRECT_MESSAGE_CONFIRMED',
    eventId,
    data: {
      message,
      timestamp,
    },
  });

  console.info('Direct message sent', { eventId, userId, targetConnectionId, timestamp });
  return { statusCode: 200, body: 'Direct message sent' };
}

/**
 * Handle muteAudio action.
 * Updates the target connection record with audioMuted flag and notifies the affected user.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleMuteAudio(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId || !userId) {
    return { statusCode: 400, body: 'Missing targetConnectionId or userId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #audioMuted = :val',
    ExpressionAttributeNames: { '#audioMuted': 'audioMuted' },
    ExpressionAttributeValues: { ':val': true },
  }));

  await sendToConnection(targetConnectionId, {
    type: 'AUDIO_MUTED',
    eventId,
    data: {
      userId,
      message: 'Your audio has been muted by the presenter',
    },
  });

  console.info('Audio muted for user', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'Audio muted' };
}

/**
 * Handle muteVideo action.
 * Updates the target connection record with videoDisabled flag and notifies the affected user.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleMuteVideo(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId || !userId) {
    return { statusCode: 400, body: 'Missing targetConnectionId or userId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #videoDisabled = :val',
    ExpressionAttributeNames: { '#videoDisabled': 'videoDisabled' },
    ExpressionAttributeValues: { ':val': true },
  }));

  await sendToConnection(targetConnectionId, {
    type: 'VIDEO_DISABLED',
    eventId,
    data: {
      userId,
      message: 'Your video has been disabled by the presenter',
    },
  });

  console.info('Video disabled for user', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'Video disabled' };
}

/**
 * Handle restrictChat action.
 * Updates the target connection record with chatRestricted flag and notifies the affected user.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleRestrictChat(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId || !userId) {
    return { statusCode: 400, body: 'Missing targetConnectionId or userId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #chatRestricted = :val',
    ExpressionAttributeNames: { '#chatRestricted': 'chatRestricted' },
    ExpressionAttributeValues: { ':val': true },
  }));

  await sendToConnection(targetConnectionId, {
    type: 'CHAT_RESTRICTED',
    eventId,
    data: {
      userId,
      message: 'Your chat participation has been restricted by the presenter',
    },
  });

  console.info('Chat restricted for user', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'Chat restricted' };
}

/**
 * Handle restrictQuestions action.
 * Updates the target connection record with questionsRestricted flag and notifies the affected user.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleRestrictQuestions(eventId, body, connectionId) {
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const userId = body.data?.userId || body.userId;

  if (!targetConnectionId || !userId) {
    return { statusCode: 400, body: 'Missing targetConnectionId or userId' };
  }

  await docClient.send(new UpdateCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
    UpdateExpression: 'SET #questionsRestricted = :val',
    ExpressionAttributeNames: { '#questionsRestricted': 'questionsRestricted' },
    ExpressionAttributeValues: { ':val': true },
  }));

  await sendToConnection(targetConnectionId, {
    type: 'QUESTIONS_RESTRICTED',
    eventId,
    data: {
      userId,
      message: 'Your question submission has been restricted by the presenter',
    },
  });

  console.info('Questions restricted for user', { eventId, targetConnectionId, userId });
  return { statusCode: 200, body: 'Questions restricted' };
}

/**
 * Handle globalMuteAudio action.
 * Updates event metadata with globalAudioMute flag and broadcasts to all attendees.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleGlobalMuteAudio(eventId, body, connectionId) {
  const enabled = body.data?.enabled;

  if (typeof enabled !== 'boolean') {
    return { statusCode: 400, body: 'Missing or invalid enabled field' };
  }

  const pk = buildEventPK(eventId);

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: SK.METADATA },
    UpdateExpression: 'SET #globalAudioMute = :val',
    ExpressionAttributeNames: { '#globalAudioMute': 'globalAudioMute' },
    ExpressionAttributeValues: { ':val': enabled },
  }));

  await broadcast(eventId, {
    type: 'GLOBAL_AUDIO_MUTE',
    eventId,
    data: {
      globalAudioMute: enabled,
    },
  });

  console.info('Global audio mute toggled', { eventId, globalAudioMute: enabled });
  return { statusCode: 200, body: `Global audio mute ${enabled ? 'enabled' : 'disabled'}` };
}

/**
 * Handle globalMuteVideo action.
 * Updates event metadata with globalVideoMute flag and broadcasts to all attendees.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleGlobalMuteVideo(eventId, body, connectionId) {
  const enabled = body.data?.enabled;

  if (typeof enabled !== 'boolean') {
    return { statusCode: 400, body: 'Missing or invalid enabled field' };
  }

  const pk = buildEventPK(eventId);

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: SK.METADATA },
    UpdateExpression: 'SET #globalVideoMute = :val',
    ExpressionAttributeNames: { '#globalVideoMute': 'globalVideoMute' },
    ExpressionAttributeValues: { ':val': enabled },
  }));

  await broadcast(eventId, {
    type: 'GLOBAL_VIDEO_MUTE',
    eventId,
    data: {
      globalVideoMute: enabled,
    },
  });

  console.info('Global video mute toggled', { eventId, globalVideoMute: enabled });
  return { statusCode: 200, body: `Global video mute ${enabled ? 'enabled' : 'disabled'}` };
}

/**
 * Execute the kick flow: disconnect from IVS Stage, IVS Chat, send USER_KICKED message, delete WebSocket connection.
 *
 * @param {string} eventId - The event identifier.
 * @param {string} userId - The user to kick.
 * @param {string} targetConnectionId - The WebSocket connection ID of the target user.
 * @param {string} reason - The reason for the kick.
 * @returns {Promise<void>}
 */
async function executeKickFlow(eventId, userId, targetConnectionId, reason) {
  // Get event metadata for IVS Stage ARN and Chat Room ARN
  const pk = buildEventPK(eventId);
  const metadataResult = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: SK.METADATA },
  }));

  const metadata = metadataResult.Item;

  // Disconnect from IVS Stage if stageArn is available
  if (metadata?.ivsStageArn) {
    try {
      await ivsRealTimeClient.send(new DisconnectParticipantCommand({
        stageArn: metadata.ivsStageArn,
        participantId: userId,
        reason: reason || 'Kicked by presenter',
      }));
    } catch (error) {
      console.error('Failed to disconnect participant from IVS Stage', { eventId, userId, error: error.message });
    }
  }

  // Disconnect from IVS Chat if chatRoomArn is available
  if (metadata?.ivsChatRoomArn) {
    try {
      await ivsChatClient.send(new DisconnectUserCommand({
        roomIdentifier: metadata.ivsChatRoomArn,
        userId,
        reason: reason || 'Kicked by presenter',
      }));
    } catch (error) {
      console.error('Failed to disconnect user from IVS Chat', { eventId, userId, error: error.message });
    }
  }

  // Send USER_KICKED message to the target connection before disconnecting
  try {
    await sendToConnection(targetConnectionId, {
      type: 'USER_KICKED',
      eventId,
      data: {
        userId,
        reason: reason || 'You have been removed',
      },
    });
  } catch (error) {
    console.error('Failed to send USER_KICKED message', { eventId, userId, targetConnectionId, error: error.message });
  }

  // Delete WebSocket connection from connections table
  await docClient.send(new DeleteCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    Key: { connectionId: targetConnectionId },
  }));
}

/**
 * Handle kickUser action.
 * Disconnects the user from IVS Stage, IVS Chat, sends USER_KICKED message, and removes WebSocket connection.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleKickUser(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const reason = body.data?.reason || body.reason || 'Kicked by presenter';

  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  if (!targetConnectionId) {
    return { statusCode: 400, body: 'Missing targetConnectionId' };
  }

  await executeKickFlow(eventId, userId, targetConnectionId, reason);

  // Broadcast USER_KICKED to remaining participants
  await broadcast(eventId, {
    type: 'USER_KICKED',
    eventId,
    data: {
      userId,
      reason,
    },
  });

  console.info('User kicked', { eventId, userId, targetConnectionId });
  return { statusCode: 200, body: 'User kicked' };
}

/**
 * Handle banUser action.
 * Executes the kick flow and writes a BAN#{userId} item to DynamoDB.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleBanUser(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const targetConnectionId = body.data?.targetConnectionId || body.targetConnectionId;
  const reason = body.data?.reason || body.reason || 'Banned by presenter';
  const bannedBy = body.data?.bannedBy || body.bannedBy || '';

  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  if (!targetConnectionId) {
    return { statusCode: 400, body: 'Missing targetConnectionId' };
  }

  // Execute kick flow first
  await executeKickFlow(eventId, userId, targetConnectionId, reason);

  // Write BAN#{userId} item to DynamoDB
  const pk = buildEventPK(eventId);
  const timestamp = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: pk,
      SK: `BAN#${userId}`,
      eventId,
      userId,
      bannedBy,
      reason,
      timestamp,
      type: 'BAN',
    },
  }));

  // Broadcast USER_BANNED to remaining participants
  await broadcast(eventId, {
    type: 'USER_BANNED',
    eventId,
    data: {
      userId,
      reason,
    },
  });

  console.info('User banned', { eventId, userId, bannedBy, reason });
  return { statusCode: 200, body: 'User banned' };
}

/**
 * Handle unbanUser action.
 * Deletes the BAN#{userId} item from DynamoDB.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleUnbanUser(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;

  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  const pk = buildEventPK(eventId);

  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: `BAN#${userId}` },
  }));

  console.info('User unbanned', { eventId, userId });
  return { statusCode: 200, body: 'User unbanned' };
}

/**
 * Handle listBans action.
 * Queries all BAN# items for the event and sends the list back to the requester.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleListBans(eventId, body, connectionId) {
  const pk = buildEventPK(eventId);

  const bans = [];
  let lastEvaluatedKey;

  do {
    const params = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':skPrefix': 'BAN#',
      },
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await docClient.send(new QueryCommand(params));
    bans.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Send the ban list back to the requester
  await sendToConnection(connectionId, {
    type: 'BAN_LIST',
    eventId,
    data: {
      bans: bans.map((ban) => ({
        userId: ban.userId,
        bannedBy: ban.bannedBy,
        reason: ban.reason,
        timestamp: ban.timestamp,
      })),
    },
  });

  console.info('Ban list queried', { eventId, count: bans.length });
  return { statusCode: 200, body: 'Ban list sent' };
}

/**
 * Handle acknowledgeHand action.
 * Removes hand record, grants speak permission to the user, broadcasts HAND_LOWERED and SPEAK_PERMISSION_CHANGED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleAcknowledgeHand(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const timestamp = body.data?.timestamp || body.timestamp;

  if (!userId || !timestamp) {
    return { statusCode: 400, body: 'Missing userId or timestamp' };
  }

  // Delete hand record
  const pk = buildEventPK(eventId);
  const sk = buildHandSK(timestamp, userId);
  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
  }));

  // Find user's connection and grant speak permission
  const connections = await getConnectionsForEvent(eventId);
  const userConn = connections.find(c => c.userId === userId);

  if (userConn) {
    await docClient.send(new UpdateCommand({
      TableName: CONNECTIONS_TABLE_NAME,
      Key: { connectionId: userConn.connectionId },
      UpdateExpression: 'SET #hasSpeakPermission = :speak',
      ExpressionAttributeNames: { '#hasSpeakPermission': 'hasSpeakPermission' },
      ExpressionAttributeValues: { ':speak': true },
    }));
  }

  // Broadcast hand lowered
  await broadcast(eventId, {
    type: 'HAND_LOWERED',
    eventId,
    data: { userId, timestamp },
  });

  // Broadcast speak permission change
  if (userConn) {
    await broadcast(eventId, {
      type: 'SPEAK_PERMISSION_CHANGED',
      eventId,
      data: {
        connectionId: userConn.connectionId,
        userId,
        hasSpeakPermission: true,
      },
    });
  }

  console.info('Hand acknowledged', { eventId, userId, timestamp });
  return { statusCode: 200, body: 'Hand acknowledged' };
}

/**
 * Handle dismissHand action.
 * Removes hand record without granting speak permission, broadcasts HAND_LOWERED.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleDismissHand(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId;
  const timestamp = body.data?.timestamp || body.timestamp;

  if (!userId || !timestamp) {
    return { statusCode: 400, body: 'Missing userId or timestamp' };
  }

  // Delete hand record
  const pk = buildEventPK(eventId);
  const sk = buildHandSK(timestamp, userId);
  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
  }));

  // Broadcast hand lowered (no speak permission change)
  await broadcast(eventId, {
    type: 'HAND_LOWERED',
    eventId,
    data: { userId, timestamp },
  });

  console.info('Hand dismissed', { eventId, userId, timestamp });
  return { statusCode: 200, body: 'Hand dismissed' };
}

/**
 * Handle getAttendeeList action.
 * Returns all current connections for the event to the requesting connection.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleGetAttendeeList(eventId, body, connectionId) {
  const connections = await getConnectionsForEvent(eventId);
  // Issue #85: do not include email in the WS response. Every attendee can
  // call this action, so emails would be harvested by any participant. The
  // presenter's auth-gated GET /events/{id}/signups endpoint is the place
  // for email visibility.
  const attendees = connections.map(c => ({
    userId: c.userId,
    displayName: c.displayName || '',
    role: c.role,
    connectionId: c.connectionId,
  }));

  await sendToConnection(connectionId, {
    type: 'ATTENDEE_LIST',
    eventId,
    data: { attendees, count: attendees.length },
  });

  console.info('Attendee list sent', { eventId, count: attendees.length });
  return { statusCode: 200, body: 'Attendee list sent' };
}

/**
 * Handle getQuestionQueue action.
 * Returns all queued questions for the event to the requesting connection.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleGetQuestionQueue(eventId, body, connectionId) {
  const pk = buildEventPK(eventId);

  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': pk,
      ':skPrefix': KEY_PREFIX.QUESTION,
    },
    ScanIndexForward: true,
  }));

  const questions = (result.Items || [])
    .filter(q => q.status === QUESTION_STATUS.QUEUED)
    .map(q => ({
      questionId: q.questionId,
      userId: q.userId,
      displayName: q.displayName,
      text: q.text,
      status: q.status,
      submittedAt: q.submittedAt,
      timestamp: q.submittedAt,
    }));

  const answered = (result.Items || [])
    .filter(q => q.status === QUESTION_STATUS.ANSWERED)
    .map(q => ({
      questionId: q.questionId,
      userId: q.userId,
      displayName: q.displayName,
      text: q.text,
      status: q.status,
      submittedAt: q.submittedAt,
      timestamp: q.submittedAt,
    }));

  await sendToConnection(connectionId, {
    type: 'QUESTION_QUEUE',
    eventId,
    data: { questions, answered, count: questions.length },
  });

  console.info('Question queue sent', { eventId, count: questions.length, answeredCount: answered.length });
  return { statusCode: 200, body: 'Question queue sent' };
}

/**
 * Handle getHandsList action.
 * Returns all raised hands for the event in chronological order to the requesting connection.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester.
 * @returns {Object} Response with statusCode 200.
 */
async function handleGetHandsList(eventId, body, connectionId) {
  const pk = buildEventPK(eventId);

  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': pk,
      ':skPrefix': KEY_PREFIX.HAND,
    },
    ScanIndexForward: true,
  }));

  const hands = (result.Items || []).map(h => ({
    userId: h.userId,
    displayName: h.displayName,
    timestamp: h.timestamp,
  }));

  await sendToConnection(connectionId, {
    type: 'HANDS_LIST',
    eventId,
    data: { hands, count: hands.length },
  });

  console.info('Hands list sent', { eventId, count: hands.length });
  return { statusCode: 200, body: 'Hands list sent' };
}

/**
 * Handle pinQuestion action.
 * Broadcasts QUESTION_PINNED to all connections for the event.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handlePinQuestion(eventId, body, connectionId) {
  const questionId = body.data?.questionId || body.questionId;
  const text = body.data?.text || body.text;
  const displayName = body.data?.displayName || body.displayName || '';
  const answer = body.data?.answer || body.answer || '';

  if (!questionId || !text) {
    return { statusCode: 400, body: 'Missing questionId or text' };
  }

  await broadcast(eventId, {
    type: 'QUESTION_PINNED',
    eventId,
    data: {
      questionId,
      text,
      displayName,
      answer,
    },
  });

  console.info('Question pinned', { eventId, questionId });
  return { statusCode: 200, body: 'Question pinned' };
}

/**
 * Handle unpinQuestion action.
 * Broadcasts QUESTION_UNPINNED to all connections for the event.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the requester (presenter).
 * @returns {Object} Response with statusCode 200.
 */
async function handleUnpinQuestion(eventId, body, connectionId) {
  const questionId = body.data?.questionId || body.questionId;

  if (!questionId) {
    return { statusCode: 400, body: 'Missing questionId' };
  }

  await broadcast(eventId, {
    type: 'QUESTION_UNPINNED',
    eventId,
    data: {
      questionId,
    },
  });

  console.info('Question unpinned', { eventId, questionId });
  return { statusCode: 200, body: 'Question unpinned' };
}

/**
 * Handle typing action.
 * Broadcasts TYPING to all connections for the event (excluding sender).
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - The parsed message body.
 * @param {string} connectionId - The WebSocket connection ID of the sender.
 * @returns {Object} Response with statusCode 200.
 */
async function handleTyping(eventId, body, connectionId) {
  const userId = body.data?.userId || body.userId || '';
  const displayName = body.data?.displayName || body.displayName || '';

  // Get sender info from connection record if not provided
  let senderDisplayName = displayName;
  let senderUserId = userId;
  if (!senderDisplayName || !senderUserId) {
    try {
      const senderConn = await docClient.send(new GetCommand({
        TableName: CONNECTIONS_TABLE_NAME,
        Key: { connectionId },
      }));
      senderDisplayName = senderDisplayName || senderConn.Item?.displayName || senderConn.Item?.email || 'Someone';
      senderUserId = senderUserId || senderConn.Item?.userId || '';
    } catch (e) {
      senderDisplayName = senderDisplayName || 'Someone';
    }
  }

  // Broadcast to all connections except sender
  const connections = await getConnectionsForEvent(eventId);
  const otherConnections = connections.filter(c => c.connectionId !== connectionId);

  const message = {
    type: 'TYPING',
    eventId,
    data: {
      userId: senderUserId,
      displayName: senderDisplayName,
    },
  };

  for (const conn of otherConnections) {
    try {
      await sendToConnection(conn.connectionId, message);
    } catch (error) {
      // Ignore stale connections
    }
  }

  return { statusCode: 200, body: 'Typing broadcast' };
}

/**
 * Handle broadcastCaption action.
 * Presenter sends transcribed text to all attendees via WebSocket.
 * Only presenters/co-presenters can broadcast captions.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} body - { text, language, isFinal }
 * @param {string} connectionId - The sender's WebSocket connection ID.
 */
async function handleBroadcastCaption(eventId, body, connectionId) {
  const { text, language, isFinal } = body;

  if (!text || !language) {
    return { statusCode: 400, body: 'text and language are required' };
  }

  // Verify sender is a presenter
  const connections = await getConnectionsForEvent(eventId);
  const senderConn = connections.find(c => c.connectionId === connectionId);
  if (!senderConn || (senderConn.role !== 'presenter' && senderConn.role !== 'co-presenter')) {
    return { statusCode: 403, body: 'Only presenters can broadcast captions' };
  }

  // Broadcast CAPTION to all connections
  await broadcast(eventId, {
    type: 'CAPTION',
    eventId,
    data: {
      text,
      language: language || 'en',
      isFinal: isFinal !== false,
      timestamp: new Date().toISOString(),
    },
  });

  return { statusCode: 200, body: 'Caption broadcast' };
}

module.exports = { handler };
