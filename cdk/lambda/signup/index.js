'use strict';

/**
 * Sign-Up Lambda handler.
 * Handles POST /events/{id}/signup and GET /events/{id}/signups.
 * @module signup
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const { KEY_PREFIX, SK, MAX_DISPLAY_NAME_LENGTH } = require('../shared/constants');
const { buildEventPK, buildSignupSK } = require('../shared/dynamo-utils');
const { success, created, badRequest, unauthorized, forbidden, notFound, serverError } = require('../shared/response');
const { validateRequiredFields, isValidEmail, isValidLength, parseBody, sanitize } = require('../shared/validation');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const lambdaClient = new LambdaClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const EMAIL_LAMBDA_ARN = process.env.EMAIL_LAMBDA_ARN;

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
      recipientEmail: payload.recipientEmail,
    });
  }
}

/**
 * Register a user for an event (POST /events/{id}/signup).
 * Requires authentication.
 */
async function signUpForEvent(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Verify the event exists
  const eventResult = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
  }));

  if (!eventResult.Item) {
    return notFound('Event not found');
  }

  const { valid, data, error } = parseBody(event.body);
  if (!valid) {
    return badRequest(error);
  }

  const { valid: fieldsValid, missing } = validateRequiredFields(data, ['displayName']);
  if (!fieldsValid) {
    return badRequest(`Missing required fields: ${missing.join(', ')}`);
  }

  // Issue #77: use the authenticated user's email from the JWT — NOT
  // the body. Without this, any logged-in user could submit a body
  // with someone else's email and trigger a branded confirmation email
  // to that victim, turning the platform into an email-spam relay.
  const email = (claims.email || '').trim();
  if (!isValidEmail(email)) {
    return badRequest('Authenticated user has no valid email claim');
  }

  if (!isValidLength(data.displayName, 1, MAX_DISPLAY_NAME_LENGTH)) {
    return badRequest(`displayName must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`);
  }

  const displayName = sanitize(data.displayName);
  const now = new Date().toISOString();

  const item = {
    PK: buildEventPK(eventId),
    SK: buildSignupSK(claims.userId),
    userId: claims.userId,
    displayName,
    email,
    registeredAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  // Async invoke email Lambda for sign-up confirmation (fire-and-forget)
  await invokeEmailLambda({
    type: 'signup-confirmation',
    eventId,
    recipientEmail: email,
    recipientName: displayName,
    eventTitle: eventResult.Item.title,
    scheduledStart: eventResult.Item.scheduledStart,
    eventUrl: `/events/${eventId}`,
  });

  return created({
    message: 'Successfully registered for event',
    eventId,
    userId: claims.userId,
    displayName,
    email,
    registeredAt: now,
  });
}

const LIST_SIGNUPS_DEFAULT_LIMIT = 100;
const LIST_SIGNUPS_MAX_LIMIT = 500;

/**
 * Decode an opaque pagination cursor (base64url JSON) into a DynamoDB
 * ExclusiveStartKey. Returns null for missing input; throws on malformed
 * input so the caller can surface a 400. Mirrors PR #21's pattern in
 * event-crud.
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

function encodeCursor(key) {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: LIST_SIGNUPS_DEFAULT_LIMIT, error: null };
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return { value: 0, error: 'limit must be a positive integer' };
  }
  const n = Number(raw);
  if (n > LIST_SIGNUPS_MAX_LIMIT) {
    return { value: 0, error: `limit must be <= ${LIST_SIGNUPS_MAX_LIMIT}` };
  }
  return { value: n, error: null };
}

/**
 * List sign-ups for an event (GET /events/{id}/signups).
 * Requires authentication and event ownership.
 *
 * Query params:
 *   - limit:  optional, 1..LIST_SIGNUPS_MAX_LIMIT, defaults to 100.
 *   - cursor: optional opaque cursor returned from a prior page as `nextCursor`.
 *
 * Response: { eventId, signups: [...], count, nextCursor? }.
 * `count` is the size of THIS page, not the total — see #56 for why and the
 * out-of-scope note on adding a true count endpoint.
 */
async function listSignups(event, eventId) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  // Verify the event exists and check ownership
  const eventResult = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
  }));

  if (!eventResult.Item) {
    return notFound('Event not found');
  }

  if (eventResult.Item.ownerUserId !== claims.userId) {
    return forbidden('Only the event owner can view sign-ups');
  }

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
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': buildEventPK(eventId),
      ':skPrefix': KEY_PREFIX.SIGNUP,
    },
    Limit: limit,
  };
  if (exclusiveStartKey) {
    queryParams.ExclusiveStartKey = exclusiveStartKey;
  }

  const result = await docClient.send(new QueryCommand(queryParams));

  const signups = (result.Items || []).map((item) => ({
    userId: item.userId,
    displayName: item.displayName,
    email: item.email,
    registeredAt: item.registeredAt,
  }));

  const response = { eventId, signups, count: signups.length };
  if (result.LastEvaluatedKey) {
    response.nextCursor = encodeCursor(result.LastEvaluatedKey);
  }
  return success(response);
}

/**
 * Main Lambda handler.
 * Routes requests based on HTTP method and resource.
 */
exports.handler = async (event) => {
  try {
    const method = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
    const resource = event.resource || event.routeKey || '';
    const normalizedResource = resource.includes(' ') ? resource.split(' ')[1] : resource;
    const pathParams = event.pathParameters;

    const eventId = pathParams && pathParams.id;
    if (!eventId) {
      return badRequest('Event ID is required');
    }

    // Route: POST /events/{id}/signup
    if (method === 'POST' && normalizedResource === '/events/{id}/signup') {
      return await signUpForEvent(event, eventId);
    }

    // Route: GET /events/{id}/signups
    if (method === 'GET' && normalizedResource === '/events/{id}/signups') {
      return await listSignups(event, eventId);
    }

    return badRequest(`Unsupported route: ${method} ${normalizedResource}`);
  } catch (err) {
    console.error('Sign-up handler error:', err);
    return serverError('An unexpected error occurred');
  }
};
