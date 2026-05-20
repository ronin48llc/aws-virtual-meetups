'use strict';

// Set env before requiring handler
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.AWS_SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDHqa0AP';

const { handler, _internals } = require('../../lambda/transcription/index');
const { generateTranscribePresignedUrl, buildTranslateConfig, SUPPORTED_SOURCE_LANGUAGES, SUPPORTED_TARGET_LANGUAGES } = _internals;

function buildEvent({ method, resource, pathParameters, body, claims }) {
  const event = {
    httpMethod: method,
    resource,
    pathParameters: pathParameters || null,
    body: body ? JSON.stringify(body) : null,
    requestContext: {},
  };
  if (claims) {
    event.requestContext.authorizer = { claims };
  }
  return event;
}

const validClaims = {
  sub: 'user-123',
  email: 'presenter@example.com',
  'custom:role': 'member',
};

describe('Transcription Orchestrator Lambda handler', () => {
  describe('POST /events/{id}/transcription/start', () => {
    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 400 when event ID is missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: null,
        body: { sourceLanguage: 'en-US' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID is required');
    });

    it('returns 400 when body is empty', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: null,
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('returns 400 when sourceLanguage is missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { targetLanguages: ['es'] },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('sourceLanguage');
    });

    it('returns 400 for unsupported source language', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'xx-XX' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Unsupported source language');
    });

    it('returns 400 when targetLanguages is not an array', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US', targetLanguages: 'es' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('targetLanguages must be an array');
    });

    it('returns 400 for unsupported target languages', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US', targetLanguages: ['es', 'zz'] },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Unsupported target languages');
      expect(body.message).toContain('zz');
    });

    it('returns 200 with pre-signed URL for valid request', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US', targetLanguages: ['es', 'fr'] },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.presignedUrl).toBeDefined();
      expect(body.presignedUrl).toContain('transcribestreaming.us-east-1.amazonaws.com');
      expect(body.presignedUrl).toContain('stream-transcription-websocket');
      expect(body.presignedUrl).toContain('X-Amz-Signature=');
      expect(body.region).toBe('us-east-1');
      expect(body.languageCode).toBe('en-US');
      expect(body.eventId).toBe('evt_abc');
    });

    it('returns translate configuration with valid targets', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US', targetLanguages: ['es', 'fr', 'de'] },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.translateConfig).toBeDefined();
      expect(body.translateConfig.enabled).toBe(true);
      expect(body.translateConfig.sourceLanguageCode).toBe('en');
      expect(body.translateConfig.targetLanguageCodes).toEqual(['es', 'fr', 'de']);
    });

    it('returns translate config disabled when no target languages', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.translateConfig.enabled).toBe(false);
      expect(body.translateConfig.targetLanguageCodes).toEqual([]);
    });

    it('filters out source language from target languages', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US', targetLanguages: ['en', 'es', 'fr'] },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.translateConfig.targetLanguageCodes).toEqual(['es', 'fr']);
      expect(body.translateConfig.targetLanguageCodes).not.toContain('en');
    });

    it('uses default sampleRate and mediaEncoding', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.sampleRate).toBe(16000);
      expect(body.mediaEncoding).toBe('pcm');
    });

    it('accepts custom sampleRate and mediaEncoding', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US', sampleRate: 44100, mediaEncoding: 'ogg-opus' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.sampleRate).toBe(44100);
      expect(body.mediaEncoding).toBe('ogg-opus');
      expect(body.presignedUrl).toContain('sample-rate=44100');
      expect(body.presignedUrl).toContain('media-encoding=ogg-opus');
    });

    it('returns 500 when AWS credentials are missing', async () => {
      const originalKey = process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_ACCESS_KEY_ID;

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: { sourceLanguage: 'en-US' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('configuration error');

      // Restore
      process.env.AWS_ACCESS_KEY_ID = originalKey;
    });
  });

  describe('Unsupported routes', () => {
    it('returns 400 for unsupported method/resource', async () => {
      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Unsupported route');
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Pass an event that will cause an internal error
      const event = {
        httpMethod: 'POST',
        resource: '/events/{id}/transcription/start',
        pathParameters: { id: 'evt_abc' },
        body: '{"sourceLanguage": "en-US"}',
        requestContext: {
          authorizer: {
            claims: { sub: 'user-123' },
          },
        },
      };

      // Temporarily break the environment to trigger an error
      const originalKey = process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;

      const result = await handler(event);
      expect(result.statusCode).toBe(500);

      process.env.AWS_SECRET_ACCESS_KEY = originalKey;
    });
  });
});

describe('generateTranscribePresignedUrl', () => {
  it('generates a valid WebSocket URL with correct endpoint', () => {
    const url = generateTranscribePresignedUrl({
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      languageCode: 'en-US',
      sampleRate: 16000,
      mediaEncoding: 'pcm',
    });

    expect(url).toContain('wss://transcribestreaming.us-east-1.amazonaws.com:8443');
    expect(url).toContain('/stream-transcription-websocket');
  });

  it('includes required query parameters', () => {
    const url = generateTranscribePresignedUrl({
      region: 'us-west-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      languageCode: 'es-US',
      sampleRate: 44100,
      mediaEncoding: 'ogg-opus',
    });

    expect(url).toContain('language-code=es-US');
    expect(url).toContain('sample-rate=44100');
    expect(url).toContain('media-encoding=ogg-opus');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Credential=');
    expect(url).toContain('X-Amz-Date=');
    expect(url).toContain('X-Amz-Expires=300');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toContain('X-Amz-Signature=');
  });

  it('includes session token when provided', () => {
    const url = generateTranscribePresignedUrl({
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'FwoGZXIvYXdzEBYaDHqa0AP',
      languageCode: 'en-US',
    });

    expect(url).toContain('X-Amz-Security-Token=FwoGZXIvYXdzEBYaDHqa0AP');
  });

  it('does not include session token when not provided', () => {
    const url = generateTranscribePresignedUrl({
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      languageCode: 'en-US',
    });

    expect(url).not.toContain('X-Amz-Security-Token');
  });

  it('uses correct region in endpoint', () => {
    const url = generateTranscribePresignedUrl({
      region: 'eu-west-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      languageCode: 'en-GB',
    });

    expect(url).toContain('transcribestreaming.eu-west-1.amazonaws.com');
  });

  it('uses default sampleRate and mediaEncoding', () => {
    const url = generateTranscribePresignedUrl({
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      languageCode: 'en-US',
    });

    expect(url).toContain('sample-rate=16000');
    expect(url).toContain('media-encoding=pcm');
  });
});

describe('buildTranslateConfig', () => {
  it('returns enabled config with valid target languages', () => {
    const config = buildTranslateConfig('en-US', ['es', 'fr', 'de']);

    expect(config.enabled).toBe(true);
    expect(config.sourceLanguageCode).toBe('en');
    expect(config.targetLanguageCodes).toEqual(['es', 'fr', 'de']);
  });

  it('filters out source language from targets', () => {
    const config = buildTranslateConfig('es-US', ['en', 'es', 'fr']);

    expect(config.sourceLanguageCode).toBe('es');
    expect(config.targetLanguageCodes).toEqual(['en', 'fr']);
    expect(config.targetLanguageCodes).not.toContain('es');
  });

  it('returns disabled config when no valid targets remain', () => {
    const config = buildTranslateConfig('en-US', ['en']);

    expect(config.enabled).toBe(false);
    expect(config.targetLanguageCodes).toEqual([]);
  });

  it('returns disabled config for empty target array', () => {
    const config = buildTranslateConfig('en-US', []);

    expect(config.enabled).toBe(false);
    expect(config.targetLanguageCodes).toEqual([]);
  });

  it('filters out unsupported target languages', () => {
    const config = buildTranslateConfig('en-US', ['es', 'zz', 'fr', 'xx']);

    expect(config.targetLanguageCodes).toEqual(['es', 'fr']);
  });

  it('extracts source language code from Transcribe format', () => {
    const config = buildTranslateConfig('ja-JP', ['en', 'ko']);

    expect(config.sourceLanguageCode).toBe('ja');
    expect(config.targetLanguageCodes).toEqual(['en', 'ko']);
  });
});

// Issue #123: api-stack uses HttpApi (v2). The previous handler only
// read v1 event fields (event.httpMethod, event.resource,
// authorizer.claims) — every production transcription request returned
// 401 → "Unsupported route". The existing tests didn't catch it because
// they mock v1 too. These tests use the actual v2 event shape API
// Gateway sends in production.
describe('Transcription handler — API Gateway v2 event shape (#123)', () => {
  function buildHttpV2Event({ method, routeKey, pathParameters, body, claims }) {
    const event = {
      rawPath: routeKey ? routeKey.split(' ')[1] : '/',
      routeKey,
      pathParameters: pathParameters || null,
      body: body ? JSON.stringify(body) : null,
      requestContext: {
        http: { method },
      },
    };
    if (claims) {
      event.requestContext.authorizer = { jwt: { claims } };
    }
    return event;
  }

  it('routes a v2-shaped POST /events/{id}/transcription/start to the handler', async () => {
    const event = buildHttpV2Event({
      method: 'POST',
      routeKey: 'POST /events/{id}/transcription/start',
      pathParameters: { id: 'evt_abc' },
      body: { sourceLanguage: 'en-US' },
      claims: validClaims,
    });

    const result = await handler(event);

    // Critical: the handler must NOT return 401 (auth shape works) and
    // must NOT return 400 "Unsupported route" (routing shape works).
    expect(result.statusCode).not.toBe(401);
    expect(result.statusCode).not.toBe(400);

    // Should succeed with a presigned URL payload.
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.presignedUrl).toMatch(/^wss:\/\//);
    expect(body.languageCode).toBe('en-US');
    expect(body.eventId).toBe('evt_abc');
  });

  it('returns 401 on a v2 event with no authorizer at all', async () => {
    const event = buildHttpV2Event({
      method: 'POST',
      routeKey: 'POST /events/{id}/transcription/start',
      pathParameters: { id: 'evt_abc' },
      body: { sourceLanguage: 'en-US' },
      // claims omitted → no authorizer wrapper
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  it('returns 400 "Unsupported route" for an unknown v2 route', async () => {
    const event = buildHttpV2Event({
      method: 'GET',
      routeKey: 'GET /events',
      claims: validClaims,
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    // The route message should include the normalized path, not "undefined".
    expect(body.message).toContain('/events');
    expect(body.message).not.toContain('undefined');
  });
});
