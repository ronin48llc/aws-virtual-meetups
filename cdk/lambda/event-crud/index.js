'use strict';

/**
 * Event CRUD Lambda handler.
 * Handles POST/GET/PUT/DELETE /events operations.
 * @module event-crud
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const crypto = require('crypto');

const { EVENT_STATUS, GSI, SK, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } = require('../shared/constants');
const { buildEventPK, buildGSI1SK, buildGSI2PK } = require('../shared/dynamo-utils');
const { success, created, badRequest, unauthorized, notFound, serverError, forbidden } = require('../shared/response');
const { validateRequiredFields, isFutureDate, isValidDate, isValidLength, parseBody, sanitize, computeDurationFields, validateDurationFields } = require('../shared/validation');
const { createLogger } = require('../shared/logger');
const { createReminderSchedules, deleteReminderSchedules, deleteAutoStopSchedule, deleteWarningSchedules } = require('../shared/scheduler-utils');
const { getMetrics } = require('../shared/engagement-metrics');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const lambdaClient = new LambdaClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const EMAIL_LAMBDA_ARN = process.env.EMAIL_LAMBDA_ARN;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;

/**
 * Extract authenticated user claims from the request context.
 * @param {Object} event - API Gateway event.
 * @returns {Object|null} User claims or null if unauthenticated.
 */
function getAuthClaims(event) {
  // Support both REST API v1 (authorizer.claims) and HTTP API v2 (authorizer.jwt.claims)
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
 * Generate a unique event ID.
 * @returns {string} Event ID with "evt_" prefix.
 */
function generateEventId() {
  return `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Asynchronously invoke the Email Lambda (fire-and-forget).
 * @param {Object} payload - The email invocation payload.
 * @param {Object} logger - Logger instance for error reporting.
 */
async function invokeEmailLambda(payload, logger) {
  if (!EMAIL_LAMBDA_ARN) {
    return;
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: EMAIL_LAMBDA_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }));
    logger.info('Email Lambda invoked', {
      action: 'invokeEmailLambda',
      extra: { type: payload.type, eventId: payload.eventId },
    });
  } catch (err) {
    logger.error('Failed to invoke Email Lambda', {
      action: 'invokeEmailLambda',
      error: err.message,
      extra: { type: payload.type, eventId: payload.eventId },
    });
  }
}

/**
 * Create a new event.
 * Requires authentication.
 */
async function createEvent(event) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Only organizers can create events
  if (claims.role !== 'organizer') {
    return forbidden('Only organizers can create events');
  }

  const { valid, data, error } = parseBody(event.body);
  if (!valid) {
    return badRequest(error);
  }

  const { valid: fieldsValid, missing } = validateRequiredFields(data, ['title', 'description', 'scheduledStart']);
  if (!fieldsValid) {
    return badRequest(`Missing required fields: ${missing.join(', ')}`);
  }

  if (!isValidLength(data.title, 1, MAX_TITLE_LENGTH)) {
    return badRequest(`title must be 1-${MAX_TITLE_LENGTH} characters`);
  }

  if (!isValidLength(data.description, 1, MAX_DESCRIPTION_LENGTH)) {
    return badRequest(`description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (!isValidDate(data.scheduledStart)) {
    return badRequest('scheduledStart must be a valid ISO 8601 date');
  }

  if (!isFutureDate(data.scheduledStart)) {
    return badRequest('scheduledStart must be in the future');
  }

  // Compute and validate duration fields
  let durationResult = null;
  try {
    durationResult = computeDurationFields(data.scheduledStart, data);
  } catch (err) {
    if (err.name === 'ValidationError') {
      return badRequest(err.message);
    }
    throw err;
  }

  if (durationResult) {
    const validation = validateDurationFields(durationResult.scheduledEnd, durationResult.durationMinutes, data.scheduledStart);
    if (!validation.valid) {
      return badRequest(validation.error);
    }
  }

  const eventId = generateEventId();
  const now = new Date().toISOString();
  const title = sanitize(data.title);
  const description = sanitize(data.description);
  const scheduledStart = data.scheduledStart;

  const item = {
    PK: buildEventPK(eventId),
    SK: SK.METADATA,
    GSI1PK: GSI.GSI1_UPCOMING_PK,
    GSI1SK: buildGSI1SK(scheduledStart, eventId),
    GSI2PK: buildGSI2PK(claims.userId),
    GSI2SK: buildGSI1SK(scheduledStart, eventId),
    eventId,
    title,
    description,
    scheduledStart,
    status: EVENT_STATUS.SCHEDULED,
    ownerUserId: claims.userId,
    ownerEmail: claims.email,
    url: `/events/${eventId}`,
    createdAt: now,
    updatedAt: now,
  };

  // Add duration fields to the item when provided
  if (durationResult) {
    item.scheduledEnd = durationResult.scheduledEnd;
    item.durationMinutes = durationResult.durationMinutes;
  }

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  // Fire-and-forget: send event-created email to organizer
  const logger = createLogger(event);
  const emailPayload = {
    type: 'event-created',
    eventId,
    recipientEmail: claims.email,
    recipientName: claims.email,
    eventTitle: title,
    eventDescription: description,
    scheduledStart,
    eventUrl: `/events/${eventId}`,
  };

  // Include duration fields in email payload when present
  if (durationResult) {
    emailPayload.scheduledEnd = durationResult.scheduledEnd;
    emailPayload.durationMinutes = durationResult.durationMinutes;
  }

  try {
    await invokeEmailLambda(emailPayload, logger);
  } catch (err) {
    logger.error('Failed to send event-created email', {
      eventId,
      error: err.message,
    });
  }

  // Fire-and-forget: create reminder schedules
  try {
    await createReminderSchedules(eventId, scheduledStart, EMAIL_LAMBDA_ARN, SCHEDULER_ROLE_ARN);
  } catch (err) {
    logger.error('Failed to create reminder schedules', {
      eventId,
      error: err.message,
    });
  }

  const response = {
    eventId,
    title,
    description,
    scheduledStart,
    status: EVENT_STATUS.SCHEDULED,
    url: `/events/${eventId}`,
    ownerUserId: claims.userId,
    createdAt: now,
  };

  // Include duration fields in the creation response when present
  if (durationResult) {
    response.scheduledEnd = durationResult.scheduledEnd;
    response.durationMinutes = durationResult.durationMinutes;
  }

  return created(response);
}

/**
 * List upcoming events via GSI1.
 * Public access - no authentication required.
 */
async function listEvents() {
  // Query all events from GSI1 (includes upcoming, live, and staging events)
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: {
      ':pk': GSI.GSI1_UPCOMING_PK,
    },
    ScanIndexForward: false, // Most recent first
  }));

  const events = (result.Items || []).map((item) => {
    const mapped = {
      eventId: item.eventId,
      title: item.title,
      description: item.description,
      scheduledStart: item.scheduledStart,
      status: item.status,
      url: item.url,
      ownerUserId: item.ownerUserId,
      createdAt: item.createdAt,
    };

    // Include duration fields when present
    if (item.scheduledEnd) {
      mapped.scheduledEnd = item.scheduledEnd;
    }
    if (item.durationMinutes) {
      mapped.durationMinutes = item.durationMinutes;
    }

    return mapped;
  });

  return success({ events });
}

/**
 * Determine the display mode for the landing page based on event status.
 * @param {string} status - Current event status.
 * @returns {string} Display mode: "signup", "live", "ended", or "cancelled".
 */
function getDisplayMode(status) {
  switch (status) {
    case EVENT_STATUS.SCHEDULED:
      return 'signup';
    case EVENT_STATUS.STAGING:
      return 'staging';
    case EVENT_STATUS.LIVE:
      return 'live';
    case EVENT_STATUS.ENDED:
    case EVENT_STATUS.PUBLISHED:
      return 'ended';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'signup';
  }
}

/**
 * Calculate countdown in seconds until the scheduled start time.
 * Returns 0 if the scheduled time has already passed.
 * @param {string} scheduledStart - ISO 8601 date string.
 * @returns {number} Seconds until start, or 0 if already passed.
 */
function getCountdown(scheduledStart) {
  const startTime = new Date(scheduledStart).getTime();
  const now = Date.now();
  const diffSeconds = Math.max(0, Math.floor((startTime - now) / 1000));
  return diffSeconds;
}

/**
 * Get a single event by ID.
 * Public access - no authentication required.
 * Includes displayMode and countdown for landing page state logic.
 */
async function getEvent(eventId) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
  }));

  if (!result.Item) {
    return notFound('Event not found');
  }

  const item = result.Item;
  const displayMode = getDisplayMode(item.status);

  const response = {
    eventId: item.eventId,
    title: item.title,
    description: item.description,
    scheduledStart: item.scheduledStart,
    status: item.status,
    displayMode,
    url: item.url,
    ownerUserId: item.ownerUserId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };

  // Include duration fields when present
  if (item.scheduledEnd) {
    response.scheduledEnd = item.scheduledEnd;
  }
  if (item.durationMinutes) {
    response.durationMinutes = item.durationMinutes;
  }

  // Include remainingSeconds when event is live and has scheduledEnd
  if (item.status === EVENT_STATUS.LIVE && item.scheduledEnd) {
    response.remainingSeconds = Math.max(0, Math.floor((new Date(item.scheduledEnd).getTime() - Date.now()) / 1000));
  }

  // Include countdown when event is scheduled (waiting room data)
  if (item.status === EVENT_STATUS.SCHEDULED) {
    response.countdown = getCountdown(item.scheduledStart);
  }

  // Include recording URL when event has ended and recording is available
  if ((item.status === EVENT_STATUS.ENDED || item.status === EVENT_STATUS.PUBLISHED) && item.hlsPlaybackUrl) {
    response.recordingUrl = item.hlsPlaybackUrl;
  }

  // Include engagement metrics for ended/published events
  if (item.status === EVENT_STATUS.ENDED || item.status === EVENT_STATUS.PUBLISHED) {
    try {
      const metrics = await getMetrics(TABLE_NAME, eventId);
      if (metrics) {
        response.metrics = {
          totalAttendees: metrics.totalAttendees || 0,
          totalQuestions: metrics.totalQuestions || 0,
          durationSeconds: metrics.durationSeconds || 0,
        };
      }
    } catch (err) {
      // Non-blocking — metrics are optional
    }
  }

  return success(response);
}

/**
 * Update an existing event.
 * Requires authentication and ownership.
 */
async function updateEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  const { valid, data, error } = parseBody(event.body);
  if (!valid) {
    return badRequest(error);
  }

  // Fetch existing event to verify ownership
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
  }));

  if (!existing.Item) {
    return notFound('Event not found');
  }

  if (existing.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can update this event');
  }

  // Reject duration field updates on live events
  const hasDurationUpdate = data.scheduledEnd !== undefined || data.durationMinutes !== undefined;
  if (existing.Item.status === EVENT_STATUS.LIVE && hasDurationUpdate) {
    return badRequest('Cannot update duration on a live event. Use POST /events/{id}/extend instead');
  }

  const now = new Date().toISOString();
  const updateExpressions = ['#updatedAt = :updatedAt'];
  const expressionNames = { '#updatedAt': 'updatedAt' };
  const expressionValues = { ':updatedAt': now };

  if (data.title !== undefined) {
    if (!isValidLength(data.title, 1, MAX_TITLE_LENGTH)) {
      return badRequest(`title must be 1-${MAX_TITLE_LENGTH} characters`);
    }
    updateExpressions.push('#title = :title');
    expressionNames['#title'] = 'title';
    expressionValues[':title'] = sanitize(data.title);
  }

  if (data.description !== undefined) {
    if (!isValidLength(data.description, 1, MAX_DESCRIPTION_LENGTH)) {
      return badRequest(`description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
    }
    updateExpressions.push('#description = :description');
    expressionNames['#description'] = 'description';
    expressionValues[':description'] = sanitize(data.description);
  }

  if (data.scheduledStart !== undefined) {
    if (!isValidDate(data.scheduledStart)) {
      return badRequest('scheduledStart must be a valid ISO 8601 date');
    }
    if (!isFutureDate(data.scheduledStart)) {
      return badRequest('scheduledStart must be in the future');
    }

    const newGSI1SK = buildGSI1SK(data.scheduledStart, eventId);
    updateExpressions.push('#scheduledStart = :scheduledStart');
    updateExpressions.push('GSI1SK = :gsi1sk');
    updateExpressions.push('GSI2SK = :gsi2sk');
    expressionNames['#scheduledStart'] = 'scheduledStart';
    expressionValues[':scheduledStart'] = data.scheduledStart;
    expressionValues[':gsi1sk'] = newGSI1SK;
    expressionValues[':gsi2sk'] = newGSI1SK;
  }

  // Handle duration fields for scheduled events
  const effectiveStart = data.scheduledStart || existing.Item.scheduledStart;

  if (hasDurationUpdate) {
    // Compute and validate duration fields from the request
    let durationResult = null;
    try {
      durationResult = computeDurationFields(effectiveStart, data);
    } catch (err) {
      if (err.name === 'ValidationError') {
        return badRequest(err.message);
      }
      throw err;
    }

    if (durationResult) {
      const validation = validateDurationFields(durationResult.scheduledEnd, durationResult.durationMinutes, effectiveStart);
      if (!validation.valid) {
        return badRequest(validation.error);
      }

      updateExpressions.push('#scheduledEnd = :scheduledEnd');
      updateExpressions.push('#durationMinutes = :durationMinutes');
      expressionNames['#scheduledEnd'] = 'scheduledEnd';
      expressionNames['#durationMinutes'] = 'durationMinutes';
      expressionValues[':scheduledEnd'] = durationResult.scheduledEnd;
      expressionValues[':durationMinutes'] = durationResult.durationMinutes;
    }
  } else if (data.scheduledStart !== undefined && existing.Item.durationMinutes) {
    // Recompute scheduledEnd when scheduledStart changes and event has existing durationMinutes
    const durationMinutes = existing.Item.durationMinutes;
    const newStart = new Date(data.scheduledStart).getTime();
    const newEnd = new Date(newStart + durationMinutes * 60000).toISOString();

    updateExpressions.push('#scheduledEnd = :scheduledEnd');
    expressionNames['#scheduledEnd'] = 'scheduledEnd';
    expressionValues[':scheduledEnd'] = newEnd;
  }

  const result = await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
    ReturnValues: 'ALL_NEW',
  }));

  // If scheduledStart changed, update reminder schedules
  if (data.scheduledStart !== undefined && data.scheduledStart !== existing.Item.scheduledStart) {
    const logger = createLogger(event);
    try {
      await deleteReminderSchedules(eventId);
    } catch (err) {
      logger.error('Failed to delete old reminder schedules on update', {
        eventId,
        error: err.message,
      });
    }
    try {
      await createReminderSchedules(eventId, data.scheduledStart, EMAIL_LAMBDA_ARN, SCHEDULER_ROLE_ARN);
    } catch (err) {
      logger.error('Failed to create new reminder schedules on update', {
        eventId,
        error: err.message,
      });
    }
  }

  // If scheduledEnd changed and the existing event had a scheduledEnd, delete old auto-stop/warning schedules
  // New schedules will be created at event start time
  const scheduledEndChanged = hasDurationUpdate || (data.scheduledStart !== undefined && existing.Item.durationMinutes);
  if (scheduledEndChanged && existing.Item.scheduledEnd) {
    const logger = createLogger(event);
    try {
      await deleteAutoStopSchedule(eventId);
    } catch (err) {
      logger.error('Failed to delete old auto-stop schedule on update', {
        eventId,
        error: err.message,
      });
    }
    try {
      await deleteWarningSchedules(eventId);
    } catch (err) {
      logger.error('Failed to delete old warning schedules on update', {
        eventId,
        error: err.message,
      });
    }
  }

  const item = result.Attributes;
  const response = {
    eventId: item.eventId,
    title: item.title,
    description: item.description,
    scheduledStart: item.scheduledStart,
    status: item.status,
    url: item.url,
    ownerUserId: item.ownerUserId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };

  // Include duration fields in the response when present
  if (item.scheduledEnd) {
    response.scheduledEnd = item.scheduledEnd;
  }
  if (item.durationMinutes) {
    response.durationMinutes = item.durationMinutes;
  }

  return success(response);
}

/**
 * Delete an event.
 * Requires authentication and ownership.
 * Removes from public listing; the URL shows cancellation notice.
 */
async function deleteEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Fetch existing event to verify ownership
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
  }));

  if (!existing.Item) {
    return notFound('Event not found');
  }

  if (existing.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can delete this event');
  }

  // Update the event to mark as cancelled and remove from GSI1 (upcoming listing)
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
    UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, cancelled = :cancelled REMOVE GSI1PK, GSI1SK',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':updatedAt': now,
      ':cancelled': true,
    },
  }));

  // Fire-and-forget: delete reminder schedules
  const logger = createLogger(event);
  try {
    await deleteReminderSchedules(eventId);
  } catch (err) {
    logger.error('Failed to delete reminder schedules on event delete', {
      eventId,
      error: err.message,
    });
  }

  // Fire-and-forget: delete auto-stop and warning schedules if event had duration
  if (existing.Item.scheduledEnd) {
    try {
      await deleteAutoStopSchedule(eventId);
    } catch (err) {
      logger.error('Failed to delete auto-stop schedule on event delete', {
        eventId,
        error: err.message,
      });
    }
    try {
      await deleteWarningSchedules(eventId);
    } catch (err) {
      logger.error('Failed to delete warning schedules on event delete', {
        eventId,
        error: err.message,
      });
    }
  }

  return success({ message: 'Event deleted', eventId });
}

/**
 * Main Lambda handler.
 * Routes requests based on HTTP method and path.
 */
exports.handler = async (event) => {
  const logger = createLogger(event);

  try {
    // Support both REST API (v1) and HTTP API (v2) event formats
    const method = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
    const resource = event.resource || event.routeKey || '';
    const pathParams = event.pathParameters;

    // Normalize HTTP API v2 routeKey format ("GET /events") to resource format
    const normalizedResource = resource.includes(' ') ? resource.split(' ')[1] : resource;

    logger.info('Request received', {
      action: `${method} ${normalizedResource}`,
      extra: { method, resource: normalizedResource },
    });

    // Route: POST /events
    if (method === 'POST' && normalizedResource === '/events') {
      return await createEvent(event);
    }

    // Route: GET /events
    if (method === 'GET' && normalizedResource === '/events') {
      return await listEvents();
    }

    // Route: GET /events/{id}
    if (method === 'GET' && normalizedResource === '/events/{id}') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await getEvent(eventId);
    }

    // Route: PUT /events/{id}
    if (method === 'PUT' && normalizedResource === '/events/{id}') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await updateEvent(event, eventId);
    }

    // Route: DELETE /events/{id}
    if (method === 'DELETE' && normalizedResource === '/events/{id}') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await deleteEvent(event, eventId);
    }

    return badRequest(`Unsupported route: ${method} ${normalizedResource}`);
  } catch (err) {
    logger.error('Event CRUD error', {
      action: 'handler',
      error: err.message,
    });
    return serverError('An unexpected error occurred');
  }
};
