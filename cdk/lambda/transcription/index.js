'use strict';

/**
 * Transcription Orchestrator Lambda handler.
 * Generates pre-signed URLs for Amazon Transcribe Streaming WebSocket API
 * and provides Amazon Translate configuration for multi-language support.
 *
 * The presenter's browser uses the pre-signed URL to connect directly to
 * Amazon Transcribe Streaming via WebSocket, eliminating server-side audio relay.
 *
 * @module transcription
 */

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { success, badRequest, unauthorized, forbidden, notFound, serverError } = require('../shared/response');
const { parseBody, validateRequiredFields } = require('../shared/validation');
const { SK } = require('../shared/constants');
const { buildEventPK } = require('../shared/dynamo-utils');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE_NAME = process.env.TABLE_NAME;

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Supported source languages for Amazon Transcribe Streaming.
 */
const SUPPORTED_SOURCE_LANGUAGES = [
  'en-US', 'en-GB', 'en-AU', 'es-US', 'fr-FR', 'fr-CA',
  'de-DE', 'it-IT', 'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN',
];

/**
 * Supported target languages for Amazon Translate.
 */
const SUPPORTED_TARGET_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar',
  'hi', 'ru', 'nl', 'sv', 'pl', 'tr', 'vi', 'th', 'id',
];

/**
 * Extract authenticated user claims from the request context.
 * @param {Object} event - API Gateway event.
 * @returns {Object|null} User claims or null if unauthenticated.
 */
function getAuthClaims(event) {
  const claims = event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims;
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
 * Create a SHA-256 HMAC.
 * @param {string|Buffer} key - The signing key.
 * @param {string} message - The message to sign.
 * @returns {Buffer} The HMAC digest.
 */
function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

/**
 * Create a SHA-256 hash.
 * @param {string} message - The message to hash.
 * @returns {string} The hex-encoded hash.
 */
function sha256(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

/**
 * Generate the AWS Signature Version 4 signing key.
 * @param {string} secretKey - AWS secret access key.
 * @param {string} dateStamp - Date in YYYYMMDD format.
 * @param {string} region - AWS region.
 * @param {string} service - AWS service name.
 * @returns {Buffer} The derived signing key.
 */
function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

/**
 * Generate a pre-signed URL for Amazon Transcribe Streaming WebSocket API.
 * Uses AWS Signature Version 4 to create a signed WebSocket URL.
 *
 * @param {Object} options - Options for URL generation.
 * @param {string} options.region - AWS region.
 * @param {string} options.accessKeyId - AWS access key ID.
 * @param {string} options.secretAccessKey - AWS secret access key.
 * @param {string} [options.sessionToken] - AWS session token (for temporary credentials).
 * @param {string} options.languageCode - Transcribe language code (e.g., 'en-US').
 * @param {number} [options.sampleRate=16000] - Audio sample rate in Hz.
 * @param {string} [options.mediaEncoding='pcm'] - Audio encoding format.
 * @returns {string} The pre-signed WebSocket URL.
 */
function generateTranscribePresignedUrl(options) {
  const {
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    languageCode,
    sampleRate = 16000,
    mediaEncoding = 'pcm',
  } = options;

  const service = 'transcribe';
  const host = `transcribestreaming.${region}.amazonaws.com`;
  const endpoint = `wss://${host}:8443/stream-transcription-websocket`;

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // Build canonical query string (parameters must be sorted)
  const queryParams = new Map();
  queryParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  queryParams.set('X-Amz-Credential', credential);
  queryParams.set('X-Amz-Date', amzDate);
  queryParams.set('X-Amz-Expires', '300');
  queryParams.set('X-Amz-SignedHeaders', 'host');
  queryParams.set('language-code', languageCode);
  queryParams.set('media-encoding', mediaEncoding);
  queryParams.set('sample-rate', String(sampleRate));

  if (sessionToken) {
    queryParams.set('X-Amz-Security-Token', sessionToken);
  }

  // Sort parameters alphabetically by key
  const sortedKeys = Array.from(queryParams.keys()).sort();
  const canonicalQueryString = sortedKeys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams.get(key))}`)
    .join('&');

  // Canonical headers
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  // Canonical request
  const canonicalRequest = [
    'GET',
    '/stream-transcription-websocket',
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // empty payload hash
  ].join('\n');

  // String to sign
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  // Calculate signature
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  // Build final URL
  const presignedUrl = `${endpoint}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return presignedUrl;
}

/**
 * Build translate configuration for the client.
 * @param {string} sourceLanguage - Source language code for Transcribe (e.g., 'en-US').
 * @param {string[]} targetLanguages - Target language codes for Translate (e.g., ['es', 'fr']).
 * @returns {Object} Translate configuration object.
 */
function buildTranslateConfig(sourceLanguage, targetLanguages) {
  // Map Transcribe language code to Translate source language code
  const sourceForTranslate = sourceLanguage.split('-')[0];

  // Filter out the source language from targets
  const validTargets = targetLanguages.filter(
    (lang) => lang !== sourceForTranslate && SUPPORTED_TARGET_LANGUAGES.includes(lang)
  );

  return {
    sourceLanguageCode: sourceForTranslate,
    targetLanguageCodes: validTargets,
    enabled: validTargets.length > 0,
  };
}

/**
 * Handle POST /events/{id}/transcription/start
 * Generates a pre-signed URL for Transcribe Streaming WebSocket.
 */
async function startTranscription(event) {
  const claims = getAuthClaims(event);
  if (!claims) {
    return unauthorized();
  }

  const pathParams = event.pathParameters;
  const eventId = pathParams && pathParams.id;
  if (!eventId) {
    return badRequest('Event ID is required');
  }

  // Issue #81: verify the requester owns the event before issuing
  // SigV4-signed Transcribe credentials. Without this any logged-in
  // user could mint Transcribe Streaming sessions on the platform's
  // AWS account (cost amplification).
  if (TABLE_NAME) {
    const eventResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: buildEventPK(eventId), SK: SK.METADATA },
    }));
    if (!eventResult.Item) {
      return notFound('Event not found');
    }
    if (eventResult.Item.ownerUserId !== claims.userId) {
      return forbidden('Only the event owner can start transcription');
    }
  }

  const { valid, data, error } = parseBody(event.body);
  if (!valid) {
    return badRequest(error);
  }

  const { valid: fieldsValid, missing } = validateRequiredFields(data, ['sourceLanguage']);
  if (!fieldsValid) {
    return badRequest(`Missing required fields: ${missing.join(', ')}`);
  }

  const { sourceLanguage, targetLanguages = [], sampleRate = 16000, mediaEncoding = 'pcm' } = data;

  // Validate source language
  if (!SUPPORTED_SOURCE_LANGUAGES.includes(sourceLanguage)) {
    return badRequest(
      `Unsupported source language: ${sourceLanguage}. Supported: ${SUPPORTED_SOURCE_LANGUAGES.join(', ')}`
    );
  }

  // Validate target languages
  if (!Array.isArray(targetLanguages)) {
    return badRequest('targetLanguages must be an array');
  }

  const invalidTargets = targetLanguages.filter((lang) => !SUPPORTED_TARGET_LANGUAGES.includes(lang));
  if (invalidTargets.length > 0) {
    return badRequest(
      `Unsupported target languages: ${invalidTargets.join(', ')}. Supported: ${SUPPORTED_TARGET_LANGUAGES.join(', ')}`
    );
  }

  // Get AWS credentials from the Lambda execution environment
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    console.error('AWS credentials not available in environment');
    return serverError('Transcription service configuration error');
  }

  // Generate pre-signed URL for Transcribe Streaming
  const presignedUrl = generateTranscribePresignedUrl({
    region: AWS_REGION,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    languageCode: sourceLanguage,
    sampleRate,
    mediaEncoding,
  });

  // Build translate configuration
  const translateConfig = buildTranslateConfig(sourceLanguage, targetLanguages);

  return success({
    presignedUrl,
    region: AWS_REGION,
    languageCode: sourceLanguage,
    sampleRate,
    mediaEncoding,
    translateConfig,
    eventId,
  });
}

/**
 * Main Lambda handler.
 * Routes requests based on HTTP method and path.
 */
exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const resource = event.resource;

    // Route: POST /events/{id}/transcription/start
    if (method === 'POST' && resource === '/events/{id}/transcription/start') {
      return await startTranscription(event);
    }

    return badRequest(`Unsupported route: ${method} ${resource}`);
  } catch (err) {
    console.error('Transcription orchestrator error:', err);
    return serverError('An unexpected error occurred');
  }
};

// Export internals for testing
exports._internals = {
  generateTranscribePresignedUrl,
  buildTranslateConfig,
  getAuthClaims,
  SUPPORTED_SOURCE_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
};
