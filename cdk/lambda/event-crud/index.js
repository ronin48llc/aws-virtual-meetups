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
const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const { EVENT_STATUS, GSI, SK, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, ANONYMOUS } = require('../shared/constants');
const { buildEventPK, buildGSI1SK, buildGSI2PK, buildRateLimitPK, buildRateLimitSK } = require('../shared/dynamo-utils');
const { success, created, badRequest, unauthorized, notFound, serverError, forbidden, buildResponse } = require('../shared/response');
const { validateRequiredFields, isFutureDate, isValidDate, isValidLength, parseBody, sanitize, computeDurationFields, validateDurationFields } = require('../shared/validation');
const { createLogger } = require('../shared/logger');
const { createReminderSchedules, deleteReminderSchedules, deleteAutoStopSchedule, deleteWarningSchedules } = require('../shared/scheduler-utils');
const { getMetrics } = require('../shared/engagement-metrics');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});
const TABLE_NAME = process.env.TABLE_NAME;
const RECORDING_BUCKET_NAME = process.env.RECORDING_BUCKET_NAME;
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

const LIST_EVENTS_DEFAULT_LIMIT = 100;
const LIST_EVENTS_MAX_LIMIT = 500;

/**
 * Decode an opaque pagination cursor (base64url-encoded JSON) back into a
 * DynamoDB ExclusiveStartKey. Returns null for missing input; throws on
 * malformed input so the caller can surface a 400.
 * @param {string|undefined} cursor
 * @returns {Object|null}
 */
function decodeCursor(cursor) {
  if (!cursor) {
    return null;
  }
  const json = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('cursor must decode to an object');
  }
  return parsed;
}

/**
 * Encode a DynamoDB LastEvaluatedKey into an opaque base64url JSON cursor.
 * @param {Object} key
 * @returns {string}
 */
function encodeCursor(key) {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/**
 * Parse and validate the ?limit= query param.
 * @param {string|undefined} raw
 * @returns {{ value: number, error: string|null }}
 */
function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: LIST_EVENTS_DEFAULT_LIMIT, error: null };
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return { value: 0, error: 'limit must be a positive integer' };
  }
  const n = Number(raw);
  if (n > LIST_EVENTS_MAX_LIMIT) {
    return { value: 0, error: `limit must be <= ${LIST_EVENTS_MAX_LIMIT}` };
  }
  return { value: n, error: null };
}

/**
 * List upcoming events via GSI1.
 * Public access - no authentication required.
 *
 * Query params:
 *   - limit:  optional, 1..LIST_EVENTS_MAX_LIMIT, defaults to LIST_EVENTS_DEFAULT_LIMIT.
 *   - cursor: optional opaque cursor returned from a prior page as `nextCursor`.
 *
 * Response shape: { events: [...], nextCursor?: string }.
 */
async function listEvents(event) {
  const qs = (event && event.queryStringParameters) || {};

  const { value: limit, error: limitError } = parseLimit(qs.limit);
  if (limitError) {
    return badRequest(limitError);
  }

  let exclusiveStartKey = null;
  try {
    exclusiveStartKey = decodeCursor(qs.cursor);
  } catch (_err) {
    return badRequest('cursor is malformed');
  }

  const queryParams = {
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: {
      ':pk': GSI.GSI1_UPCOMING_PK,
    },
    ScanIndexForward: false, // Most recent first
    Limit: limit,
  };
  if (exclusiveStartKey) {
    queryParams.ExclusiveStartKey = exclusiveStartKey;
  }

  const result = await docClient.send(new QueryCommand(queryParams));

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

  const response = { events };
  if (result.LastEvaluatedKey) {
    response.nextCursor = encodeCursor(result.LastEvaluatedKey);
  }
  return success(response);
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
/**
 * HEAD the recording manifest behind an hlsPlaybackUrl. The URL's path is
 * the S3 key (the recordings CloudFront distribution maps 1:1 onto the
 * bucket). Fails open on unexpected errors so a transient S3 hiccup can't
 * hide a valid recording; only a definitive 404/NotFound hides the URL.
 * @param {string} hlsPlaybackUrl
 * @returns {Promise<boolean>}
 */
async function recordingObjectExists(hlsPlaybackUrl) {
  if (!RECORDING_BUCKET_NAME) return true; // env not wired — legacy behavior
  let key;
  try {
    key = decodeURIComponent(new URL(hlsPlaybackUrl).pathname.replace(/^\//, ''));
  } catch (e) {
    return true;
  }
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: RECORDING_BUCKET_NAME, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.name === 'NoSuchKey'
        || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      return false;
    }
    console.error('Recording existence check failed, failing open:', err.message);
    return true;
  }
}

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

  // Include recording URL when event has ended and recording is available.
  // The URL is written optimistically at stop from IVS's reported prefix,
  // but IVS uploads nothing for sessions where no media was published (and
  // uploads lag a stop by up to a few minutes) — verify the manifest object
  // actually exists before pointing a player at it. Missing object →
  // recordingStatus 'processing' so the UI shows a friendly state instead
  // of a broken player / raw NoSuchKey XML.
  if ((item.status === EVENT_STATUS.ENDED || item.status === EVENT_STATUS.PUBLISHED) && item.hlsPlaybackUrl) {
    const exists = await recordingObjectExists(item.hlsPlaybackUrl);
    if (exists) {
      response.recordingUrl = item.hlsPlaybackUrl;
    } else {
      response.recordingStatus = 'processing';
    }
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
        // Events that ended before anonymous-viewer tracking existed have no
        // anonymousViewers on their METRICS item — omit it rather than fake a 0.
        if (typeof metrics.anonymousViewers === 'number') {
          response.metrics.anonymousViewers = metrics.anonymousViewers;
        }
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
 * Caption languages supported by the live-session caption lanes.
 * Must stay in sync with CAPTION_LANGUAGES in frontend/js/live-session.js.
 */
const CAPTION_LANGUAGES = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'zh'];

/**
 * Cue timing rules for VTT generation from live caption segments:
 * a cue ends when the next one starts, capped at 8s, floored at 1s;
 * the final cue (which has no successor) shows for 4s.
 */
const CAPTION_CUE_MAX_MS = 8000;
const CAPTION_CUE_MIN_MS = 1000;
const CAPTION_CUE_LAST_MS = 4000;

/**
 * Per-IP-per-minute cap for the public captions route. Generous by design:
 * a legitimate playback client fetches a given VTT track once per language,
 * so this only trips on scripted abuse of the (cost-incurring, on a cache
 * miss) Translate path.
 */
const CAPTIONS_RATE_LIMIT_PER_MIN = 30;

// Lazily created: @aws-sdk/client-translate ships with the nodejs20 Lambda
// runtime but is not a local dev dependency, so it is required only when the
// captions route actually needs an on-demand translation.
let translateClient = null;

/**
 * Translate one caption segment to the requested target language.
 * @param {string} text - Original segment text.
 * @param {string} srcLang - Source language code.
 * @param {string} targetLang - Target language code.
 * @returns {Promise<string>} Translated text.
 */
async function translateCaptionText(text, srcLang, targetLang) {
  const { TranslateClient, TranslateTextCommand } = require('@aws-sdk/client-translate');
  if (!translateClient) {
    translateClient = new TranslateClient({});
  }
  const result = await translateClient.send(new TranslateTextCommand({
    Text: text,
    SourceLanguageCode: srcLang,
    TargetLanguageCode: targetLang,
  }));
  return result.TranslatedText;
}

/**
 * S3 key of the cached VTT track for an event/language pair.
 * @param {string} eventId
 * @param {string} lang - Language code or the literal "original".
 * @returns {string}
 */
function captionVttKey(eventId, lang) {
  return `recordings/${eventId}/captions/${lang}.vtt`;
}

/**
 * Format a millisecond offset as a WebVTT timestamp (HH:MM:SS.mmm).
 * @param {number} ms - Non-negative offset in milliseconds.
 * @returns {string}
 */
function formatVttTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/**
 * 200 OK response carrying a WebVTT document. buildResponse spreads extra
 * headers after the JSON default (so Content-Type comes out as text/vtt)
 * and passes string bodies through unstringified, so API Gateway returns
 * the raw VTT text.
 * @param {string} vtt - Complete WebVTT document.
 * @returns {Object} API Gateway response.
 */
function vttSuccess(vtt) {
  return buildResponse(200, vtt, { 'Content-Type': 'text/vtt' });
}

/**
 * Fetch every CAPTION# segment row for an event, ascending by SK
 * (SK embeds the ISO timestamp, so SK order is chronological order).
 * @param {string} eventId
 * @returns {Promise<Array<Object>>}
 */
async function queryCaptionRows(eventId) {
  const rows = [];
  let exclusiveStartKey;
  do {
    const params = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildEventPK(eventId),
        ':prefix': 'CAPTION#',
      },
      ScanIndexForward: true,
    };
    if (exclusiveStartKey) {
      params.ExclusiveStartKey = exclusiveStartKey;
    }
    const result = await docClient.send(new QueryCommand(params));
    rows.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

/**
 * Resolve the caller's source IP from the request context, supporting both
 * HTTP API v2 (requestContext.http.sourceIp) and REST API v1
 * (requestContext.identity.sourceIp) event shapes.
 * @param {Object} event - API Gateway event.
 * @returns {string|null} The caller IP, or null when it cannot be determined.
 */
function getSourceIp(event) {
  const ctx = event && event.requestContext;
  if (!ctx) {
    return null;
  }
  return (ctx.http && ctx.http.sourceIp)
    || (ctx.identity && ctx.identity.sourceIp)
    || null;
}

/**
 * Per-IP-per-minute throttle for the public captions route, mirroring the
 * anonymous-token rate limiter: the same RATELIMIT#/MINUTE# schema (via
 * buildRateLimitPK/buildRateLimitSK), an atomic ADD increment, and the shared
 * RATE_LIMIT_TTL_SECONDS window. The caller IP stands in for the fingerprint,
 * so the counter rows live in TABLE_NAME, which this handler already
 * reads/writes (no IAM change).
 *
 * Best-effort by design: a missing IP skips limiting, and any DynamoDB failure
 * is logged and treated as under-limit — serving captions must never fail
 * because the limiter did, matching the resilience posture of the rest of this
 * handler.
 *
 * The increment params are built with native (document-client) values rather
 * than buildIncrementRateLimitParams, which emits the low-level attribute
 * format the raw client uses in anonymous-token; this handler talks to DynamoDB
 * exclusively through docClient.
 * @param {Object} event - API Gateway event.
 * @param {Object} logger - Logger instance.
 * @returns {Promise<Object|null>} A 429 response when over the cap, else null.
 */
async function enforceCaptionsRateLimit(event, logger) {
  const sourceIp = getSourceIp(event);
  if (!sourceIp) {
    return null;
  }

  const isoMinute = new Date().toISOString().slice(0, 16); // "2024-01-15T10:30"
  const ttl = Math.floor(Date.now() / 1000) + ANONYMOUS.RATE_LIMIT_TTL_SECONDS;

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: buildRateLimitPK(sourceIp),
        SK: buildRateLimitSK(isoMinute),
      },
      UpdateExpression: 'ADD #count :inc SET #ttl = :ttl',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':inc': 1, ':ttl': ttl },
      ReturnValues: 'ALL_NEW',
    }));

    const count = result.Attributes && result.Attributes.count;
    if (count > CAPTIONS_RATE_LIMIT_PER_MIN) {
      return buildResponse(429, { error: 'Too many caption requests, please retry shortly' });
    }
  } catch (err) {
    logger.error('Captions rate-limit check failed, serving anyway', {
      action: 'getEventCaptions',
      error: err.message,
      extra: { sourceIp, isoMinute },
    });
  }

  return null;
}

/**
 * GET /events/{id}/captions/{lang} — serve a WebVTT caption track for an
 * ended/published event. Public access - no authentication required.
 *
 * Serves the cached S3 object when one exists; otherwise builds the track
 * from the CAPTION# segment rows persisted during the live broadcast
 * (translating any segment that lacks a stored translation for the
 * requested lane), caches the result back to S3, and returns text/vtt.
 * @param {Object} event - API Gateway event (for the caller IP / rate limit).
 * @param {string} eventId
 * @param {string} lang - A CAPTION_LANGUAGES code or the literal "original".
 * @param {Object} logger - Logger instance.
 * @returns {Promise<Object>} API Gateway response.
 */
async function getEventCaptions(event, eventId, lang, logger) {
  if (lang !== 'original' && !CAPTION_LANGUAGES.includes(lang)) {
    return badRequest(`Unsupported caption language: ${lang}`);
  }

  // Public, unauthenticated route: throttle per caller IP before any S3 read
  // or on-demand Translate call, both of which cost money on a cache miss.
  const limited = await enforceCaptionsRateLimit(event, logger);
  if (limited) {
    return limited;
  }

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
  if (item.status !== EVENT_STATUS.ENDED && item.status !== EVENT_STATUS.PUBLISHED) {
    return badRequest('Captions are only available after the event has ended');
  }

  const key = captionVttKey(eventId, lang);

  // Cached track from a previous request (or an external pipeline)?
  if (RECORDING_BUCKET_NAME) {
    try {
      const cached = await s3Client.send(new GetObjectCommand({
        Bucket: RECORDING_BUCKET_NAME,
        Key: key,
      }));
      return vttSuccess(await cached.Body.transformToString());
    } catch (err) {
      // Missing object → generate below. Any other read failure also falls
      // through to generation rather than 500ing — the DDB rows are the
      // source of truth and can rebuild the track.
      if (err.name !== 'NoSuchKey' && err.name !== 'NotFound'
          && !(err.$metadata && err.$metadata.httpStatusCode === 404)) {
        logger.error('Cached caption VTT read failed, regenerating', {
          action: 'getEventCaptions',
          error: err.message,
          extra: { eventId, lang },
        });
      }
    }
  }

  const rows = await queryCaptionRows(eventId);
  if (rows.length === 0) {
    return buildResponse(404, { error: 'No captions recorded for this event' });
  }

  // The whole session is captioned in one source language; the first
  // segment's language is that source.
  const srcLang = rows[0].language;
  const wantOriginal = lang === 'original' || lang === srcLang;

  // Resolve each segment's text for the requested lane: original text,
  // stored live translation, or a one-off TranslateText call (never
  // written back to DDB). A failed translation falls back to the original
  // text so the track is never silently truncated.
  let translateFailed = false;
  const texts = await Promise.all(rows.map(async (row) => {
    if (wantOriginal) {
      return row.text;
    }
    if (row.translations && row.translations[lang]) {
      return row.translations[lang];
    }
    try {
      return await translateCaptionText(row.text, srcLang, lang);
    } catch (err) {
      translateFailed = true;
      logger.error('Caption segment translation failed, using original text', {
        action: 'getEventCaptions',
        error: err.message,
        extra: { eventId, lang },
      });
      return row.text;
    }
  }));

  // Cue timing is relative to when the event went live.
  const baseMs = new Date(item.startedAt || rows[0].timestamp).getTime();
  const starts = rows.map((row) => Math.max(0, new Date(row.timestamp).getTime() - baseMs));

  const cues = rows.map((row, i) => {
    const start = starts[i];
    const end = i < rows.length - 1
      ? Math.max(start + CAPTION_CUE_MIN_MS, Math.min(starts[i + 1], start + CAPTION_CUE_MAX_MS))
      : start + CAPTION_CUE_LAST_MS;
    return `${formatVttTime(start)} --> ${formatVttTime(end)}\n${texts[i]}`;
  });

  const vtt = `WEBVTT\n\n${cues.join('\n\n')}\n`;

  // Cache the generated track so subsequent requests skip DDB + Translate.
  // Skipped when a translation fell back to original text (a later request
  // can retry and cache a fully translated track). Failure never fails the
  // response.
  if (RECORDING_BUCKET_NAME && !translateFailed) {
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: RECORDING_BUCKET_NAME,
        Key: key,
        Body: vtt,
        ContentType: 'text/vtt',
      }));
    } catch (err) {
      logger.error('Failed to cache caption VTT to S3', {
        action: 'getEventCaptions',
        error: err.message,
        extra: { eventId, lang },
      });
    }
  }

  return vttSuccess(vtt);
}

/**
 * Main Lambda handler.
 * Routes requests based on HTTP method and path.
 */
/**
 * Health check: confirm the function can reach its DynamoDB table.
 * Returns 200 when healthy, 503 when the dependency check fails —
 * callers (smoke tests, synthetics, load balancer probes) treat any
 * non-200 as unhealthy.
 * @param {Object} logger - Logger instance.
 * @returns {Object} API Gateway response.
 */
async function healthCheck(logger) {
  try {
    // Cheapest possible connectivity probe: a GetItem on a key that never
    // exists still exercises IAM, networking, and table availability.
    await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: 'HEALTHCHECK', SK: 'HEALTHCHECK' },
    }));
    return success({
      status: 'ok',
      dependencies: { dynamodb: 'ok' },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Health check failed', { action: 'healthCheck', error: err.message });
    return buildResponse(503, {
      status: 'unhealthy',
      dependencies: { dynamodb: 'error' },
      timestamp: new Date().toISOString(),
    });
  }
}

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

    // Route: GET /health — unauthenticated probe for synthetic monitoring
    // and post-deploy smoke tests. Verifies the DynamoDB dependency, not
    // just Lambda liveness.
    if (method === 'GET' && normalizedResource === '/health') {
      return await healthCheck(logger);
    }

    // Route: POST /events
    if (method === 'POST' && normalizedResource === '/events') {
      return await createEvent(event);
    }

    // Route: GET /events
    if (method === 'GET' && normalizedResource === '/events') {
      return await listEvents(event);
    }

    // Route: GET /events/{id}
    if (method === 'GET' && normalizedResource === '/events/{id}') {
      const eventId = pathParams && pathParams.id;
      if (!eventId) {
        return badRequest('Event ID is required');
      }
      return await getEvent(eventId);
    }

    // Route: GET /events/{id}/captions/{lang} — public WebVTT caption track
    // for the ended-event player (lang = code or "original").
    if (method === 'GET' && normalizedResource === '/events/{id}/captions/{lang}') {
      const eventId = pathParams && pathParams.id;
      const lang = pathParams && pathParams.lang;
      if (!eventId || !lang) {
        return badRequest('Event ID and caption language are required');
      }
      return await getEventCaptions(event, eventId, lang, logger);
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
