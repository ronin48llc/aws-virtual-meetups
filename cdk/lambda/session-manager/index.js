'use strict';

/**
 * Session Manager Lambda handler.
 * Handles POST /events/{id}/start and POST /events/{id}/stop.
 * Manages IVS Real-Time Stage and Chat Room lifecycle.
 * @module session-manager
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { IVSRealTimeClient, CreateStageCommand, DeleteStageCommand, StartCompositionCommand, StopCompositionCommand, GetCompositionCommand } = require('@aws-sdk/client-ivs-realtime');
const { IvschatClient, CreateRoomCommand } = require('@aws-sdk/client-ivschat');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const { EVENT_STATUS, SK } = require('../shared/constants');
const { buildEventPK } = require('../shared/dynamo-utils');
const { success, badRequest, unauthorized, notFound, forbidden, serverError } = require('../shared/response');
const { createAutoStopSchedule, createWarningSchedules, deleteAutoStopSchedule, deleteWarningSchedules } = require('../shared/scheduler-utils');
const { parseBody } = require('../shared/validation');
const { storeEngagementSummary } = require('../shared/engagement-metrics');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ivsRealTimeClient = new IVSRealTimeClient({});
const ivsChatClient = new IvschatClient({});
const lambdaClient = new LambdaClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const RECORDING_BUCKET_NAME = process.env.RECORDING_BUCKET_NAME;
const RECORDING_CLOUDFRONT_DOMAIN = process.env.RECORDING_CLOUDFRONT_DOMAIN;
const IVS_COMPOSITION_ROLE_ARN = process.env.IVS_COMPOSITION_ROLE_ARN;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;
const EMAIL_LAMBDA_ARN = process.env.EMAIL_LAMBDA_ARN;
const SESSION_MANAGER_ARN = process.env.SESSION_MANAGER_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;

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
    role: claims['custom:role'] || 'member',
  };
}

/**
 * Asynchronously invoke the Email Lambda (fire-and-forget).
 * @param {Object} payload - The email invocation payload.
 */
async function invokeEmailLambda(payload) {
  if (!EMAIL_LAMBDA_ARN) {
    return;
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: EMAIL_LAMBDA_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }));
  } catch (err) {
    console.error('Failed to invoke email Lambda:', {
      error: err.message,
      type: payload.type,
      eventId: payload.eventId,
    });
  }
}

/**
 * Broadcast a message to all WebSocket connections for a given event.
 * Uses the same pattern as the websocket/broadcast module but inline to avoid
 * cross-Lambda dependencies.
 * @param {string} eventId - The event to broadcast to.
 * @param {Object} message - The message payload.
 */
async function broadcastToEvent(eventId, message) {
  if (!WEBSOCKET_ENDPOINT || !CONNECTIONS_TABLE_NAME) {
    console.warn('WebSocket broadcast skipped: missing WEBSOCKET_ENDPOINT or CONNECTIONS_TABLE_NAME');
    return;
  }

  const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

  const apiClient = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });

  // Query connections for this event
  const connections = [];
  let lastEvaluatedKey;

  do {
    const params = {
      TableName: CONNECTIONS_TABLE_NAME,
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

  const payload = JSON.stringify(message);

  await Promise.all(connections.map(async (conn) => {
    try {
      await apiClient.send(new PostToConnectionCommand({
        ConnectionId: conn.connectionId,
        Data: payload,
      }));
    } catch (error) {
      if (error.statusCode === 410 || error.name === 'GoneException') {
        // Stale connection — ignore
      } else {
        console.error('Failed to send to connection', { connectionId: conn.connectionId, error: error.message });
      }
    }
  }));
}

/**
 * Start an event session (enter Green Room / staging).
 * Creates IVS Stage, creates IVS Chat Room, updates event status to "staging",
 * stores stageArn and chatRoomArn. Does NOT broadcast EVENT_STARTED or send emails yet.
 * The presenter can test their setup in the green room before going live.
 */
async function startEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Fetch event to verify ownership and current status
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!existing.Item) {
    return notFound('Event not found');
  }

  if (existing.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can start this event');
  }

  if (existing.Item.status !== EVENT_STATUS.SCHEDULED) {
    return badRequest(`Cannot start event with status "${existing.Item.status}". Event must be in "scheduled" status.`);
  }

  // Create IVS Real-Time Stage
  const stageResult = await ivsRealTimeClient.send(new CreateStageCommand({
    name: `meetup-stage-${eventId}`,
  }));
  const stageArn = stageResult.stage.arn;

  // Create IVS Chat Room
  const chatRoomResult = await ivsChatClient.send(new CreateRoomCommand({
    name: `meetup-chat-${eventId}`,
  }));
  const chatRoomArn = chatRoomResult.arn;

  // Start server-side composition for recording to S3
  let compositionArn = null;
  if (RECORDING_BUCKET_NAME && IVS_COMPOSITION_ROLE_ARN) {
    try {
      const compositionResult = await ivsRealTimeClient.send(new StartCompositionCommand({
        stageArn,
        idempotencyToken: eventId.replace(/[^a-zA-Z0-9-_]/g, ''),
        destinations: [
          {
            s3: {
              storageConfigurationArn: process.env.IVS_STORAGE_CONFIG_ARN,
              encoderConfigurationArns: [process.env.IVS_ENCODER_CONFIG_ARN],
              recordingConfiguration: {
                format: 'HLS',
              },
            },
            name: `recording-${eventId}`,
          },
        ],
      }));
      compositionArn = compositionResult.composition?.arn;
      console.info('Composition started for recording', { eventId, compositionArn });
    } catch (compErr) {
      console.error('Failed to start composition for recording', { eventId, error: compErr.message });
      // Non-blocking — event still starts without recording
    }
  }

  // Update event status to "staging" and store ARNs (no startedAt yet — that's set on Go Live)
  const now = new Date().toISOString();
  const updateExpression = 'SET #status = :status, stageArn = :stageArn, chatRoomArn = :chatRoomArn, updatedAt = :updatedAt' + (compositionArn ? ', compositionArn = :compositionArn' : '');
  const expressionValues = {
    ':status': EVENT_STATUS.STAGING,
    ':stageArn': stageArn,
    ':chatRoomArn': chatRoomArn,
    ':updatedAt': now,
  };
  if (compositionArn) {
    expressionValues[':compositionArn'] = compositionArn;
  }

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: expressionValues,
  }));

  // Do NOT broadcast EVENT_STARTED or send emails — that happens on Go Live
  // Do NOT schedule auto-stop — that happens on Go Live

  const response = {
    eventId,
    status: EVENT_STATUS.STAGING,
    stageArn,
    chatRoomArn,
  };

  return success(response);
}

/**
 * Go Live — transition event from staging to live.
 * Sets startedAt, broadcasts EVENT_STARTED, sends event-started email,
 * and creates auto-stop schedules.
 */
async function goLiveEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Fetch event to verify ownership and current status
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!existing.Item) {
    return notFound('Event not found');
  }

  if (existing.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can go live');
  }

  if (existing.Item.status !== EVENT_STATUS.STAGING) {
    return badRequest(`Cannot go live with status "${existing.Item.status}". Event must be in "staging" status.`);
  }

  // Update event status to "live" and set startedAt
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
    UpdateExpression: 'SET #status = :status, startedAt = :startedAt, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': EVENT_STATUS.LIVE,
      ':startedAt': now,
      ':updatedAt': now,
    },
  }));

  // Schedule auto-stop and warnings if event has a scheduledEnd (not open-ended)
  const scheduledEnd = existing.Item.scheduledEnd;
  if (scheduledEnd && SESSION_MANAGER_ARN && SCHEDULER_ROLE_ARN) {
    try {
      await createAutoStopSchedule(eventId, scheduledEnd, SESSION_MANAGER_ARN, SCHEDULER_ROLE_ARN);
    } catch (err) {
      console.error('Failed to create auto-stop schedule:', { eventId, error: err.message });
    }

    try {
      await createWarningSchedules(eventId, scheduledEnd, SESSION_MANAGER_ARN, SCHEDULER_ROLE_ARN);
    } catch (err) {
      console.error('Failed to create warning schedules:', { eventId, error: err.message });
    }
  }

  const stageArn = existing.Item.stageArn;
  const chatRoomArn = existing.Item.chatRoomArn;

  // Broadcast EVENT_STARTED to all connected clients (attendees in waiting room)
  await broadcastToEvent(eventId, {
    type: 'EVENT_STARTED',
    eventId,
    stageArn,
    chatRoomArn,
    startedAt: now,
  });

  // Fire-and-forget: send event-started email to all attendees
  await invokeEmailLambda({
    type: 'event-started',
    eventId,
  });

  const response = {
    eventId,
    status: EVENT_STATUS.LIVE,
    stageArn,
    chatRoomArn,
    startedAt: now,
  };

  if (scheduledEnd) {
    response.scheduledEnd = scheduledEnd;
  }

  return success(response);
}

/**
 * Stop an event session.
 * Starts Server-Side Composition (S3 destination), updates event status to "ended",
 * broadcasts EVENT_ENDED, deletes stage after composition starts.
 */
async function stopEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Fetch event to verify ownership and current status
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!existing.Item) {
    return notFound('Event not found');
  }

  if (existing.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can stop this event');
  }

  if (existing.Item.status !== EVENT_STATUS.LIVE && existing.Item.status !== EVENT_STATUS.STAGING) {
    return badRequest(`Cannot stop event with status "${existing.Item.status}". Event must be in "live" or "staging" status.`);
  }

  const stageArn = existing.Item.stageArn;

  // Stop the composition if one was started at event start
  const compositionArn = existing.Item.compositionArn;
  if (compositionArn) {
    try {
      await ivsRealTimeClient.send(new StopCompositionCommand({ arn: compositionArn }));
      console.info('Composition stopped', { eventId, compositionArn });
    } catch (stopCompErr) {
      console.error('Failed to stop composition', { eventId, compositionArn, error: stopCompErr.message });
    }

    // Set the HLS playback URL based on the composition ID
    if (RECORDING_BUCKET_NAME) {
      try {
        const compositionId = compositionArn.split('/').pop();
        const hlsPlaybackUrl = RECORDING_CLOUDFRONT_DOMAIN
          ? `https://${RECORDING_CLOUDFRONT_DOMAIN}/ivs/v1/${compositionId}/media/hls/master.m3u8`
          : `https://${RECORDING_BUCKET_NAME}.s3.amazonaws.com/ivs/v1/${compositionId}/media/hls/master.m3u8`;
        await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
          UpdateExpression: 'SET hlsPlaybackUrl = :url',
          ExpressionAttributeValues: { ':url': hlsPlaybackUrl },
        }));
        console.info('HLS playback URL set', { eventId, hlsPlaybackUrl });
      } catch (urlErr) {
        console.error('Failed to set HLS playback URL', { eventId, error: urlErr.message });
      }
    }
  }

  // Update event status to "ended"
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
    UpdateExpression: 'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': EVENT_STATUS.ENDED,
      ':endedAt': now,
      ':updatedAt': now,
    },
  }));

  // Broadcast EVENT_ENDED to all connected clients
  await broadcastToEvent(eventId, {
    type: 'EVENT_ENDED',
    eventId,
    endedAt: now,
  });

  // Delete the stage after composition starts
  if (stageArn) {
    try {
      await ivsRealTimeClient.send(new DeleteStageCommand({ arn: stageArn }));
    } catch (deleteError) {
      // Log but don't fail — stage cleanup is best-effort
      console.error('Failed to delete stage', { stageArn, error: deleteError.message });
    }
  }

  // Clean up pending auto-stop and warning schedules on manual stop
  if (existing.Item.scheduledEnd) {
    try {
      await deleteAutoStopSchedule(eventId);
    } catch (err) {
      console.error('Failed to delete auto-stop schedule on manual stop:', { eventId, error: err.message });
    }

    try {
      await deleteWarningSchedules(eventId);
    } catch (err) {
      console.error('Failed to delete warning schedules on manual stop:', { eventId, error: err.message });
    }
  }

  // Compute and store engagement summary metrics
  try {
    const startedAt = existing.Item.startedAt;
    const durationSeconds = startedAt ? Math.floor((new Date(now).getTime() - new Date(startedAt).getTime()) / 1000) : 0;

    // Query signups count for the event
    const signupsResult = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': buildEventPK(eventId),
        ':skPrefix': 'SIGNUP#',
      },
      Select: 'COUNT',
    }));
    const totalAttendees = signupsResult.Count || 0;

    // Query questions count for the event
    const questionsResult = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': buildEventPK(eventId),
        ':skPrefix': 'QUESTION#',
      },
      Select: 'COUNT',
    }));
    const totalQuestions = questionsResult.Count || 0;

    await storeEngagementSummary(TABLE_NAME, eventId, {
      totalAttendees,
      totalQuestions,
      durationSeconds,
    });
  } catch (err) {
    console.error('Failed to store engagement summary:', { eventId, error: err.message });
  }

  return success({
    eventId,
    status: EVENT_STATUS.ENDED,
    endedAt: now,
  });
}

/**
 * Extend a live event's duration.
 * POST /events/{id}/extend
 * Body: { additionalMinutes: number }
 *
 * @param {Object} event - API Gateway event.
 * @param {string} eventId - Event ID.
 * @returns {Object} HTTP response.
 */
async function extendEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Parse request body
  const { valid: bodyValid, data, error: bodyError } = parseBody(event.body);
  if (!bodyValid) {
    return badRequest(bodyError);
  }

  const { additionalMinutes } = data;

  // Validate additionalMinutes is a positive integer
  if (!Number.isInteger(additionalMinutes) || additionalMinutes < 1) {
    return badRequest('additionalMinutes must be a positive integer');
  }

  // Fetch event to verify ownership and current status
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!existing.Item) {
    return notFound('Event not found');
  }

  if (existing.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can extend this event');
  }

  // Validate event is in "live" status
  if (existing.Item.status !== EVENT_STATUS.LIVE) {
    return badRequest('Can only extend duration of a live event');
  }

  // Compute new total duration
  const currentDurationMinutes = existing.Item.durationMinutes || 0;
  const newDurationMinutes = currentDurationMinutes + additionalMinutes;

  // Validate new total duration does not exceed 480 minutes
  if (newDurationMinutes > 480) {
    return badRequest('Total duration cannot exceed 480 minutes (8 hours)');
  }

  // Compute new scheduledEnd
  const currentScheduledEnd = existing.Item.scheduledEnd;
  const currentEndTime = new Date(currentScheduledEnd).getTime();
  const newScheduledEnd = new Date(currentEndTime + additionalMinutes * 60000).toISOString();

  // Update DynamoDB with new values
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
    UpdateExpression: 'SET scheduledEnd = :scheduledEnd, durationMinutes = :durationMinutes, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':scheduledEnd': newScheduledEnd,
      ':durationMinutes': newDurationMinutes,
      ':updatedAt': now,
    },
  }));

  // Delete old auto-stop and warning schedules, create new ones
  if (SESSION_MANAGER_ARN && SCHEDULER_ROLE_ARN) {
    try {
      await deleteAutoStopSchedule(eventId);
    } catch (err) {
      console.error('Failed to delete old auto-stop schedule during extend:', { eventId, error: err.message });
    }

    try {
      await deleteWarningSchedules(eventId);
    } catch (err) {
      console.error('Failed to delete old warning schedules during extend:', { eventId, error: err.message });
    }

    try {
      await createAutoStopSchedule(eventId, newScheduledEnd, SESSION_MANAGER_ARN, SCHEDULER_ROLE_ARN);
    } catch (err) {
      console.error('Failed to create new auto-stop schedule during extend:', { eventId, error: err.message });
    }

    try {
      await createWarningSchedules(eventId, newScheduledEnd, SESSION_MANAGER_ARN, SCHEDULER_ROLE_ARN);
    } catch (err) {
      console.error('Failed to create new warning schedules during extend:', { eventId, error: err.message });
    }
  }

  // Compute remaining seconds from new scheduledEnd
  const remainingSeconds = Math.max(0, Math.floor((new Date(newScheduledEnd).getTime() - Date.now()) / 1000));

  // Broadcast DURATION_EXTENDED to all connected clients
  await broadcastToEvent(eventId, {
    type: 'DURATION_EXTENDED',
    eventId,
    data: {
      newScheduledEnd,
      additionalMinutes,
      remainingSeconds,
      newDurationMinutes,
    },
  });

  return success({
    eventId,
    newScheduledEnd,
    additionalMinutes,
    newDurationMinutes,
    remainingSeconds,
  });
}

/**
 * Handle auto-stop invocation from EventBridge Scheduler.
 * Invoked directly (not via HTTP API).
 * Payload: { action: 'auto-stop', eventId: string }
 *
 * @param {Object} schedulerEvent - EventBridge Scheduler payload.
 * @returns {Object} Result.
 */
async function handleAutoStop(schedulerEvent) {
  const { eventId } = schedulerEvent;

  // Fetch event to check current status
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!existing.Item) {
    console.warn('Auto-stop: event not found, skipping', { eventId });
    return { status: 'skipped', reason: 'event_not_found' };
  }

  // If event is not live, this is a stale trigger — no-op
  if (existing.Item.status !== EVENT_STATUS.LIVE) {
    console.info('Auto-stop: event is not live, skipping (stale trigger)', {
      eventId,
      currentStatus: existing.Item.status,
    });
    return { status: 'skipped', reason: 'not_live' };
  }

  // Stop the event: update status to "ended" and set endedAt
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
    UpdateExpression: 'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': EVENT_STATUS.ENDED,
      ':endedAt': now,
      ':updatedAt': now,
    },
  }));

  // Broadcast EVENT_ENDED to all connected clients
  await broadcastToEvent(eventId, {
    type: 'EVENT_ENDED',
    eventId,
    endedAt: now,
  });

  console.info('Auto-stop: event ended successfully', { eventId, endedAt: now });
  return { status: 'stopped', eventId, endedAt: now };
}

/**
 * Handle warning invocation from EventBridge Scheduler.
 * Payload: { action: 'time-warning', eventId: string, warningType: '5min' | '1min' }
 *
 * @param {Object} schedulerEvent - EventBridge Scheduler payload.
 * @returns {Object} Result.
 */
async function handleTimeWarning(schedulerEvent) {
  const { eventId, warningType } = schedulerEvent;

  // Fetch event to check current status
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
  }));

  if (!existing.Item) {
    console.warn('Time warning: event not found, skipping', { eventId, warningType });
    return { status: 'skipped', reason: 'event_not_found' };
  }

  // If event is not live, this is a stale trigger — no-op
  if (existing.Item.status !== EVENT_STATUS.LIVE) {
    console.info('Time warning: event is not live, skipping (stale trigger)', {
      eventId,
      warningType,
      currentStatus: existing.Item.status,
    });
    return { status: 'skipped', reason: 'not_live' };
  }

  // Determine message type based on warningType
  const messageType = warningType === '1min' ? 'FINAL_WARNING' : 'TIME_WARNING';
  const scheduledEnd = existing.Item.scheduledEnd;

  // Compute remaining seconds from scheduledEnd
  const remainingSeconds = Math.max(0, Math.floor((new Date(scheduledEnd).getTime() - Date.now()) / 1000));

  // Determine human-readable message
  const message = warningType === '1min'
    ? 'Event ending in 1 minute'
    : 'Event ending in 5 minutes';

  // Broadcast warning to all connected clients
  await broadcastToEvent(eventId, {
    type: messageType,
    eventId,
    data: {
      remainingSeconds,
      scheduledEnd,
      message,
    },
  });

  console.info('Time warning: broadcast sent', { eventId, warningType, messageType, remainingSeconds });
  return { status: 'warned', eventId, warningType, messageType, remainingSeconds };
}

/**
 * Main Lambda handler.
 * Routes requests based on HTTP method and resource path.
 * Also handles direct invocations from EventBridge Scheduler (no httpMethod).
 */
exports.handler = async (event) => {
  try {
    // Detect direct invocation (no httpMethod) — from EventBridge Scheduler
    const method = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
    if (!method && !event.requestContext) {
      // Direct invocation from EventBridge Scheduler
      if (event.action === 'auto-stop') {
        return await handleAutoStop(event);
      }
      if (event.action === 'time-warning') {
        return await handleTimeWarning(event);
      }
      console.warn('Direct invocation with unknown action:', { action: event.action });
      return { status: 'error', reason: 'unknown_action' };
    }

    const resource = event.resource || event.routeKey || '';
    const normalizedResource = resource.includes(' ') ? resource.split(' ')[1] : resource;
    const pathParams = event.pathParameters;

    // POST /events/{id}/start
    if (method === 'POST' && normalizedResource === '/events/{id}/start') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await startEvent(event, eventId);
    }

    // POST /events/{id}/go-live
    if (method === 'POST' && normalizedResource === '/events/{id}/go-live') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await goLiveEvent(event, eventId);
    }

    // POST /events/{id}/stop
    if (method === 'POST' && normalizedResource === '/events/{id}/stop') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await stopEvent(event, eventId);
    }

    // POST /events/{id}/extend
    if (method === 'POST' && normalizedResource === '/events/{id}/extend') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await extendEvent(event, eventId);
    }

    return badRequest(`Unsupported route: ${method} ${normalizedResource}`);
  } catch (err) {
    console.error('Session Manager error:', err);
    return serverError('An unexpected error occurred');
  }
};
