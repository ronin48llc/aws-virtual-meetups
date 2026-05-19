'use strict';

/**
 * Token Generator Lambda handler.
 * Handles POST /events/{id}/join.
 * Generates IVS Real-Time Stage participant tokens and IVS Chat tokens
 * based on the user's role and permissions.
 * @module token-generator
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { IVSRealTimeClient, CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
const { IvschatClient, CreateChatTokenCommand } = require('@aws-sdk/client-ivschat');

const { EVENT_STATUS, SESSION_ROLE, SK } = require('../shared/constants');
const { buildEventPK, buildSignupSK } = require('../shared/dynamo-utils');
const { success, badRequest, unauthorized, notFound, forbidden, serverError } = require('../shared/response');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ivsRealTimeClient = new IVSRealTimeClient({});
const ivsChatClient = new IvschatClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;

// Token durations in minutes
const STAGE_TOKEN_DURATION_MINUTES = 720; // IVS Real-Time Stage: max 720 (12 hours)
const CHAT_TOKEN_DURATION_MINUTES = 180; // IVS Chat: max 180 (3 hours)

/**
 * Extract authenticated user claims from the request context.
 * @param {Object} event - API Gateway event.
 * @returns {Object|null} User claims or null if unauthenticated.
 */
function getAuthClaims(event) {
  const authorizer = event.requestContext && event.requestContext.authorizer;
  const claims = authorizer && (authorizer.claims || (authorizer.jwt && authorizer.jwt.claims));
  if (!claims || !claims.sub) {
    return null;
  }
  return {
    userId: claims.sub,
    email: claims.email || '',
    displayName: claims.email || '',
    emailVerified: claims.email_verified,
  };
}

/**
 * Check if the user's email is verified.
 * Cognito may pass email_verified as boolean true or string "true".
 * @param {Object} claims - Parsed user claims from getAuthClaims.
 * @returns {boolean} True if email is verified.
 */
function isEmailVerified(claims) {
  return claims.emailVerified === true || claims.emailVerified === 'true';
}

/**
 * Determine IVS Stage capabilities based on role and speak permission.
 * - presenter/co-presenter: ['PUBLISH', 'SUBSCRIBE']
 * - attendee with speak permission: ['PUBLISH', 'SUBSCRIBE']
 * - regular attendee: ['SUBSCRIBE'] only
 *
 * @param {string} role - The session role (presenter, co-presenter, attendee).
 * @param {boolean} hasSpeakPermission - Whether the attendee has speak permission.
 * @returns {string[]} Array of IVS Stage capabilities.
 */
function determineStageCapabilities(role, hasSpeakPermission) {
  if (role === SESSION_ROLE.PRESENTER || role === SESSION_ROLE.CO_PRESENTER) {
    return ['PUBLISH', 'SUBSCRIBE'];
  }
  if (hasSpeakPermission) {
    return ['PUBLISH', 'SUBSCRIBE'];
  }
  return ['SUBSCRIBE'];
}

/**
 * Determine IVS Chat capabilities based on role.
 * - presenter/co-presenter: ['SEND_MESSAGE', 'DISCONNECT_USER']
 * - attendee: ['SEND_MESSAGE']
 *
 * @param {string} role - The session role.
 * @returns {string[]} Array of IVS Chat capabilities.
 */
function determineChatCapabilities(role) {
  if (role === SESSION_ROLE.PRESENTER || role === SESSION_ROLE.CO_PRESENTER) {
    return ['SEND_MESSAGE', 'DISCONNECT_USER'];
  }
  return ['SEND_MESSAGE'];
}

/**
 * Look up the user's connection to determine their role and permissions.
 * Queries the connections table by eventId GSI and filters by userId.
 *
 * @param {string} eventId - The event identifier.
 * @param {string} userId - The user identifier.
 * @returns {Object|null} Connection record or null if not found.
 */
async function findUserConnection(eventId, userId) {
  const result = await docClient.send(new QueryCommand({
    TableName: CONNECTIONS_TABLE_NAME,
    IndexName: 'EventConnections',
    KeyConditionExpression: 'eventId = :eventId',
    FilterExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':eventId': eventId,
      ':userId': userId,
    },
  }));

  if (result.Items && result.Items.length > 0) {
    return result.Items[0];
  }
  return null;
}

/**
 * Auto-register attendee if no signup record exists.
 * Non-blocking: errors are logged but do not prevent join.
 *
 * @param {string} eventId - The event identifier.
 * @param {Object} claims - Authenticated user claims {userId, email, displayName}.
 * @returns {Promise<void>}
 */
async function autoRegisterIfNeeded(eventId, claims) {
  const pk = buildEventPK(eventId);
  const sk = buildSignupSK(claims.userId);

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: pk,
        SK: sk,
        userId: claims.userId,
        displayName: claims.displayName,
        email: claims.email,
        registeredAt: new Date().toISOString(),
        source: 'auto-join',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Already registered — expected, no action needed
      return;
    }
    // Log but don't block join flow
    console.error('Auto-registration failed', { eventId, userId: claims.userId, error: err.message });
  }
}

/**
 * Main Lambda handler.
 * Handles POST /events/{id}/join — generates IVS stage and chat tokens.
 */
exports.handler = async (event) => {
  try {
    const method = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
    const resource = event.resource || event.routeKey || '';
    const normalizedResource = resource.includes(' ') ? resource.split(' ')[1] : resource;
    const pathParams = event.pathParameters;

    // POST /events/{id}/join
    if (method === 'POST' && normalizedResource === '/events/{id}/join') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await joinEvent(event, eventId);
    }

    return badRequest(`Unsupported route: ${method} ${normalizedResource}`);
  } catch (err) {
    console.error('Token Generator error:', err);
    return serverError('An unexpected error occurred');
  }
};

/**
 * Handle join event request.
 * Looks up the event to get stageArn and chatRoomArn, determines user role,
 * generates IVS stage participant token and chat token.
 *
 * @param {Object} event - API Gateway event.
 * @param {string} eventId - The event identifier.
 * @returns {Object} API Gateway response with tokens.
 */
async function joinEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Require verified email for interactive participation (Req 25.1, 25.2)
  if (!isEmailVerified(claims)) {
    return forbidden('Email verification required');
  }

  // Fetch event metadata to get stageArn and chatRoomArn
  const eventRecord = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!eventRecord.Item) {
    return notFound('Event not found');
  }

  const eventItem = eventRecord.Item;

  // Event must be live or staging to join
  if (eventItem.status !== EVENT_STATUS.LIVE && eventItem.status !== EVENT_STATUS.STAGING) {
    return badRequest('Event is not currently live');
  }

  // If event is in staging, only the owner can get tokens; others get a waiting response
  if (eventItem.status === EVENT_STATUS.STAGING) {
    if (eventItem.ownerUserId !== claims.userId) {
      return success({ status: 'waiting', message: 'Event is starting soon. Please wait.' });
    }
  }

  // Check if user is banned from this event
  const banRecord = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: `BAN#${claims.userId}` },
  }));

  if (banRecord.Item) {
    return forbidden('You are banned from this event');
  }

  // Auto-register attendee if not already signed up (non-blocking)
  await autoRegisterIfNeeded(eventId, claims);

  const { stageArn, chatRoomArn } = eventItem;

  if (!stageArn || !chatRoomArn) {
    return serverError('Event streaming resources not available');
  }

  // Look up user's connection to determine role and permissions
  const connection = await findUserConnection(eventId, claims.userId);

  // Event owner is always the presenter, regardless of connection state
  let role;
  if (eventItem.ownerUserId === claims.userId) {
    role = SESSION_ROLE.PRESENTER;
  } else {
    role = connection ? connection.role : SESSION_ROLE.ATTENDEE;
  }
  const hasSpeakPermission = connection ? (connection.hasSpeakPermission === true) : false;

  // Determine capabilities
  const stageCapabilities = determineStageCapabilities(role, hasSpeakPermission);
  const chatCapabilities = determineChatCapabilities(role);

  // Generate IVS Real-Time Stage participant token
  const stageTokenResult = await ivsRealTimeClient.send(new CreateParticipantTokenCommand({
    stageArn,
    userId: claims.userId,
    capabilities: stageCapabilities,
    duration: STAGE_TOKEN_DURATION_MINUTES,
    attributes: {
      displayName: claims.displayName,
      role,
    },
  }));

  // Generate IVS Chat token
  const chatTokenResult = await ivsChatClient.send(new CreateChatTokenCommand({
    roomIdentifier: chatRoomArn,
    userId: claims.userId,
    capabilities: chatCapabilities,
    sessionDurationInMinutes: CHAT_TOKEN_DURATION_MINUTES,
    attributes: {
      displayName: claims.displayName,
      role,
    },
  }));

  return success({
    stageToken: {
      token: stageTokenResult.participantToken.token,
      participantId: stageTokenResult.participantToken.participantId,
      expirationTime: stageTokenResult.participantToken.expirationTime,
    },
    chatToken: {
      token: chatTokenResult.token,
      sessionExpirationTime: chatTokenResult.sessionExpirationTime,
      tokenExpirationTime: chatTokenResult.tokenExpirationTime,
    },
    capabilities: {
      stage: stageCapabilities,
      chat: chatCapabilities,
    },
    role,
    eventStatus: eventItem.status,
  });
}
