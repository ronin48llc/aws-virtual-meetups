'use strict';

/**
 * Anonymous Token Lambda handler.
 * Handles unauthenticated token generation for anonymous viewers.
 *   POST /events/{id}/join-anonymous - Generate subscribe-only stage token
 *   POST /events/{id}/playback-anonymous - Validate recording access
 * @module anonymous-token
 */

const { DynamoDBClient, GetItemCommand, UpdateItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { IVSRealTimeClient, CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
const { randomUUID } = require('crypto');

const { success, badRequest, notFound, serverError, buildResponse } = require('../shared/response');
const { validateFingerprint, parseBody } = require('../shared/validation');
const { EVENT_STATUS, SK, ANONYMOUS } = require('../shared/constants');
const {
  buildEventPK,
  buildRateLimitPK,
  buildRateLimitSK,
  buildIncrementRateLimitParams,
  buildCreateAnonSessionParams,
} = require('../shared/dynamo-utils');

const ddbClient = new DynamoDBClient({});
const ivsClient = new IVSRealTimeClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const STAGE_ARN = process.env.STAGE_ARN;

/**
 * Main Lambda handler.
 * Routes requests to the appropriate handler based on the route key.
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

    // POST /events/{id}/join-anonymous
    if (method === 'POST' && normalizedResource === '/events/{id}/join-anonymous') {
      return await joinAnonymous(event, eventId);
    }

    // POST /events/{id}/playback-anonymous
    if (method === 'POST' && normalizedResource === '/events/{id}/playback-anonymous') {
      return await playbackAnonymous(event, eventId);
    }

    return badRequest(`Unsupported route: ${method} ${normalizedResource}`);
  } catch (err) {
    console.error('Anonymous Token error:', err);
    return serverError('An unexpected error occurred');
  }
};

/**
 * Generate an anonymous stage token for live viewing.
 * @param {Object} event - API Gateway event.
 * @param {string} eventId - Event identifier.
 * @returns {Object} API Gateway response with { stageToken, sessionId, eventStatus }.
 */
async function joinAnonymous(event, eventId) {
  // 1. Parse body and validate fingerprint
  const { valid: bodyValid, data, error: bodyError } = parseBody(event.body);
  if (!bodyValid) {
    return badRequest(bodyError);
  }

  const fingerprint = data && data.fingerprint;
  const { valid: fpValid, error: fpError } = validateFingerprint(fingerprint);
  if (!fpValid) {
    return badRequest(fpError);
  }

  // 2. Query event metadata to check status is LIVE
  const eventResult = await ddbClient.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: buildEventPK(eventId) },
      SK: { S: SK.METADATA },
    },
  }));

  if (!eventResult.Item) {
    return notFound('Event not found');
  }

  const eventStatus = eventResult.Item.status && eventResult.Item.status.S;
  if (eventStatus !== EVENT_STATUS.LIVE) {
    return badRequest('Event is not currently live');
  }

  // 3. Check rate limit counter for this fingerprint in the current minute
  const isoMinute = new Date().toISOString().slice(0, 16); // "2024-01-15T10:30"
  const rateLimitKey = {
    PK: { S: buildRateLimitPK(fingerprint) },
    SK: { S: buildRateLimitSK(isoMinute) },
  };

  const rateLimitResult = await ddbClient.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: rateLimitKey,
  }));

  const currentCount = rateLimitResult.Item && rateLimitResult.Item.count
    ? parseInt(rateLimitResult.Item.count.N, 10)
    : 0;

  if (currentCount >= ANONYMOUS.RATE_LIMIT_MAX) {
    return buildResponse(429, { error: 'Too Many Requests', message: 'Too many requests. Try again later.' });
  }

  // 4. Call IVS CreateParticipantToken with SUBSCRIBE-only capability
  const stageArn = eventResult.Item.stageArn && eventResult.Item.stageArn.S;
  const targetStageArn = stageArn || STAGE_ARN;

  let tokenResult;
  try {
    tokenResult = await ivsClient.send(new CreateParticipantTokenCommand({
      stageArn: targetStageArn,
      capabilities: ['SUBSCRIBE'],
      userId: `anon-${fingerprint.slice(0, 6)}`,
      attributes: {
        displayName: 'Anonymous Viewer',
        fingerprint: fingerprint,
      },
      duration: 720, // 720 minutes max
    }));
  } catch (err) {
    console.error('Failed to create participant token:', err);
    return serverError('Failed to generate viewing token');
  }

  const stageToken = tokenResult.participantToken && tokenResult.participantToken.token;
  const sessionId = randomUUID();

  // 5. Increment rate limit counter and write anonymous session record
  try {
    await ddbClient.send(new UpdateItemCommand(
      buildIncrementRateLimitParams({ tableName: TABLE_NAME, fingerprint, isoMinute })
    ));
  } catch (err) {
    console.error('Failed to increment rate limit counter:', err);
    // Non-blocking — token already generated
  }

  try {
    await ddbClient.send(new PutItemCommand(
      buildCreateAnonSessionParams({
        tableName: TABLE_NAME,
        eventId,
        fingerprint,
        sessionId,
        sessionType: 'live',
      })
    ));
  } catch (err) {
    console.error('Failed to write anonymous session record:', err);
    // Non-blocking — token already generated
  }

  // 6. Return response — do NOT include fingerprint
  return success({
    stageToken,
    sessionId,
    eventStatus,
  });
}

/**
 * Validate recording access and return playback URL.
 * @param {Object} event - API Gateway event.
 * @param {string} eventId - Event identifier.
 * @returns {Object} API Gateway response with { hlsPlaybackUrl, sessionId }.
 */
async function playbackAnonymous(event, eventId) {
  // 1. Parse request body
  const { valid: bodyValid, data, error: bodyError } = parseBody(event.body);
  if (!bodyValid) {
    return badRequest(bodyError);
  }

  // 2. Validate fingerprint format
  const fingerprint = data && data.fingerprint;
  const { valid: fpValid, error: fpError } = validateFingerprint(fingerprint);
  if (!fpValid) {
    return badRequest(fpError);
  }

  const trimmedFingerprint = fingerprint.trim();

  // 3. Query event metadata to verify recording exists and has a playback URL
  const recordingResult = await ddbClient.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: buildEventPK(eventId) },
      SK: { S: SK.RECORDING },
    },
  }));

  if (!recordingResult.Item) {
    return notFound('Recording not found');
  }

  const playbackUrl = recordingResult.Item.playbackUrl && recordingResult.Item.playbackUrl.S;
  if (!playbackUrl) {
    return notFound('Recording not yet available');
  }

  // 4. Check rate limit counter
  const isoMinute = new Date().toISOString().slice(0, 16); // "2024-01-15T10:30"
  const rateLimitParams = buildIncrementRateLimitParams({
    tableName: TABLE_NAME,
    fingerprint: trimmedFingerprint,
    isoMinute,
  });

  const rateLimitResult = await ddbClient.send(new UpdateItemCommand(rateLimitParams));
  const currentCount = parseInt(rateLimitResult.Attributes.count.N, 10);

  if (currentCount > ANONYMOUS.RATE_LIMIT_MAX) {
    return buildResponse(429, { error: 'Too Many Requests', message: 'Too many requests. Try again later.' });
  }

  // 5. Write anonymous session record with sessionType: 'playback'
  const sessionId = randomUUID();
  const sessionParams = buildCreateAnonSessionParams({
    tableName: TABLE_NAME,
    eventId,
    fingerprint: trimmedFingerprint,
    sessionId,
    sessionType: 'playback',
  });

  await ddbClient.send(new PutItemCommand(sessionParams));

  // 6. Return playback URL and session ID — do NOT include fingerprint in response
  return success({
    hlsPlaybackUrl: playbackUrl,
    sessionId,
  });
}
