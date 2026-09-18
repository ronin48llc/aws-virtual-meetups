'use strict';

/**
 * Unit tests for GET /events/{id}/captions/{lang} — the public WebVTT
 * caption track endpoint on the Event CRUD Lambda.
 */

// Mock AWS SDK
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
}));

// Mock S3 client (cache read/write + recording existence check)
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  HeadObjectCommand: jest.fn((params) => ({ type: 'HeadObject', params })),
  GetObjectCommand: jest.fn((params) => ({ type: 'GetObject', params })),
  PutObjectCommand: jest.fn((params) => ({ type: 'PutObject', params })),
}));

// Mock Translate client for on-demand segment translation. Virtual: the
// package ships with the nodejs20 Lambda runtime and is not installed
// locally (the handler lazy-requires it).
const mockTranslateSend = jest.fn();
jest.mock('@aws-sdk/client-translate', () => ({
  TranslateClient: jest.fn(() => ({ send: mockTranslateSend })),
  TranslateTextCommand: jest.fn((params) => ({ type: 'TranslateText', params })),
}), { virtual: true });

// Mock Lambda client for email invocation
const mockLambdaSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
}));

// Mock scheduler-utils
jest.mock('../../lambda/shared/scheduler-utils', () => ({
  createReminderSchedules: jest.fn().mockResolvedValue(undefined),
  deleteReminderSchedules: jest.fn().mockResolvedValue(undefined),
  deleteAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
  deleteWarningSchedules: jest.fn().mockResolvedValue(undefined),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.RECORDING_BUCKET_NAME = 'test-recording-bucket';
process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:VirtualMeetup-EmailSender';
process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/VirtualMeetup-SchedulerRole';

const { handler } = require('../../lambda/event-crud/index');

const EVENT_ID = 'evt_abc123def456';
const STARTED_AT = '2026-01-01T10:00:00.000Z';

function buildCaptionsRequest(lang, eventId = EVENT_ID) {
  return {
    httpMethod: 'GET',
    resource: '/events/{id}/captions/{lang}',
    body: null,
    pathParameters: { id: eventId, lang },
    queryStringParameters: null,
    requestContext: {},
  };
}

function endedEventItem(overrides = {}) {
  return {
    PK: `EVENT#${EVENT_ID}`,
    SK: 'METADATA',
    eventId: EVENT_ID,
    title: 'Ended Event',
    status: 'ended',
    startedAt: STARTED_AT,
    ...overrides,
  };
}

/**
 * Build a CAPTION# segment row as persisted by the signaling fan-out.
 * @param {number} offsetSeconds - Seconds after STARTED_AT.
 */
function captionRow(offsetSeconds, text, extras = {}) {
  const timestamp = new Date(new Date(STARTED_AT).getTime() + offsetSeconds * 1000).toISOString();
  return {
    PK: `EVENT#${EVENT_ID}`,
    SK: `CAPTION#${timestamp}#abcd`,
    entityType: 'CAPTION',
    text,
    language: 'en',
    timestamp,
    ...extras,
  };
}

/** Route DDB sends: Get -> metadata item, Query -> caption rows. */
function mockDynamo({ item = endedEventItem(), rows = [] } = {}) {
  mockSend.mockImplementation((cmd) => {
    if (cmd.type === 'Get') {
      return Promise.resolve(item ? { Item: item } : {});
    }
    if (cmd.type === 'Query') {
      return Promise.resolve({ Items: rows });
    }
    return Promise.resolve({});
  });
}

const noSuchKeyError = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });

/** Route S3 sends: GetObject miss (NoSuchKey), PutObject ok. */
function mockS3CacheMiss() {
  mockS3Send.mockImplementation((cmd) => {
    if (cmd.type === 'GetObject') {
      return Promise.reject(noSuchKeyError());
    }
    return Promise.resolve({});
  });
}

describe('GET /events/{id}/captions/{lang}', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLambdaSend.mockResolvedValue({});
  });

  describe('validation', () => {
    it('returns 400 for an unsupported language code', async () => {
      const result = await handler(buildCaptionsRequest('xx'));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('Unsupported caption language');
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('returns 404 when the event does not exist', async () => {
      mockDynamo({ item: null });
      const result = await handler(buildCaptionsRequest('en'));
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).message).toBe('Event not found');
    });

    it('returns 400 when the event has not ended', async () => {
      mockDynamo({ item: endedEventItem({ status: 'live' }) });
      const result = await handler(buildCaptionsRequest('en'));
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('ended');
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  describe('S3 cache hit', () => {
    it('returns the cached VTT body as text/vtt without touching caption rows', async () => {
      mockDynamo();
      const cachedVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nCached cue\n';
      mockS3Send.mockResolvedValueOnce({
        Body: { transformToString: jest.fn().mockResolvedValue(cachedVtt) },
      });

      const result = await handler(buildCaptionsRequest('es'));

      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/vtt');
      expect(result.body).toBe(cachedVtt);

      expect(mockS3Send).toHaveBeenCalledTimes(1);
      expect(mockS3Send.mock.calls[0][0]).toEqual({
        type: 'GetObject',
        params: {
          Bucket: 'test-recording-bucket',
          Key: `recordings/${EVENT_ID}/captions/es.vtt`,
        },
      });

      // Only the metadata Get — no CAPTION# Query, no translation
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].type).toBe('Get');
      expect(mockTranslateSend).not.toHaveBeenCalled();
    });
  });

  describe('generation from CAPTION# rows', () => {
    it('returns 404 when no caption rows exist', async () => {
      mockDynamo({ rows: [] });
      mockS3CacheMiss();

      const result = await handler(buildCaptionsRequest('original'));

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toEqual({ error: 'No captions recorded for this event' });
      const query = mockSend.mock.calls.find((c) => c[0].type === 'Query')[0];
      expect(query.params.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :prefix)');
      expect(query.params.ExpressionAttributeValues).toEqual({
        ':pk': `EVENT#${EVENT_ID}`,
        ':prefix': 'CAPTION#',
      });
      expect(query.params.ScanIndexForward).toBe(true);
    });

    it('builds a correct WEBVTT document for lang "original" and caches it to S3', async () => {
      mockDynamo({
        rows: [
          captionRow(2, 'First segment'),
          captionRow(5, 'Second segment'),
          captionRow(30, 'Final segment'),
        ],
      });
      mockS3CacheMiss();

      const result = await handler(buildCaptionsRequest('original'));

      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/vtt');
      // Cue 1: ends at the next cue's start (5s < 2s+8s cap).
      // Cue 2: next start (30s) exceeds the 8s cap -> ends at 5s+8s=13s.
      // Cue 3: final cue shows for 4s.
      expect(result.body).toBe(
        'WEBVTT\n\n'
        + '00:00:02.000 --> 00:00:05.000\nFirst segment\n\n'
        + '00:00:05.000 --> 00:00:13.000\nSecond segment\n\n'
        + '00:00:30.000 --> 00:00:34.000\nFinal segment\n'
      );
      expect(mockTranslateSend).not.toHaveBeenCalled();

      // Generated track is cached back to S3
      const put = mockS3Send.mock.calls.find((c) => c[0].type === 'PutObject')[0];
      expect(put.params).toEqual({
        Bucket: 'test-recording-bucket',
        Key: `recordings/${EVENT_ID}/captions/original.vtt`,
        Body: result.body,
        ContentType: 'text/vtt',
      });
    });

    it('enforces the 1-second minimum cue duration', async () => {
      mockDynamo({
        rows: [
          captionRow(2, 'Rapid one'),
          captionRow(2.5, 'Rapid two'),
        ],
      });
      mockS3CacheMiss();

      const result = await handler(buildCaptionsRequest('original'));

      expect(result.statusCode).toBe(200);
      // Next cue starts at 2.5s but cues last at least 1s -> ends at 3s.
      expect(result.body).toContain('00:00:02.000 --> 00:00:03.000\nRapid one');
      expect(result.body).toContain('00:00:02.500 --> 00:00:06.500\nRapid two');
    });

    it('clamps cues that predate startedAt to 00:00:00.000', async () => {
      mockDynamo({ rows: [captionRow(-3, 'Early segment')] });
      mockS3CacheMiss();

      const result = await handler(buildCaptionsRequest('original'));

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('00:00:00.000 --> 00:00:04.000\nEarly segment');
    });

    it('serves original text when the requested lang equals the source language', async () => {
      mockDynamo({
        rows: [captionRow(1, 'English text', { translations: { es: 'Texto' } })],
      });
      mockS3CacheMiss();

      const result = await handler(buildCaptionsRequest('en'));

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('English text');
      expect(result.body).not.toContain('Texto');
      expect(mockTranslateSend).not.toHaveBeenCalled();
    });

    it('prefers stored translations[lang] and only calls Translate for missing segments', async () => {
      mockDynamo({
        rows: [
          captionRow(1, 'Hello', { translations: { es: 'Hola' } }),
          captionRow(4, 'World'),
        ],
      });
      mockS3CacheMiss();
      mockTranslateSend.mockResolvedValueOnce({ TranslatedText: 'Mundo' });

      const result = await handler(buildCaptionsRequest('es'));

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('00:00:01.000 --> 00:00:04.000\nHola');
      expect(result.body).toContain('00:00:04.000 --> 00:00:08.000\nMundo');

      // Exactly one TranslateText, for the row without a stored translation
      expect(mockTranslateSend).toHaveBeenCalledTimes(1);
      expect(mockTranslateSend.mock.calls[0][0]).toEqual({
        type: 'TranslateText',
        params: {
          Text: 'World',
          SourceLanguageCode: 'en',
          TargetLanguageCode: 'es',
        },
      });

      // Never written back to DDB
      const ddbWrites = mockSend.mock.calls.filter((c) => c[0].type === 'Put' || c[0].type === 'Update');
      expect(ddbWrites).toHaveLength(0);

      // Translated track is cached
      const put = mockS3Send.mock.calls.find((c) => c[0].type === 'PutObject')[0];
      expect(put.params.Key).toBe(`recordings/${EVENT_ID}/captions/es.vtt`);
    });

    it('falls back to original text on Translate failure and skips the S3 cache write', async () => {
      mockDynamo({ rows: [captionRow(1, 'Hello')] });
      mockS3CacheMiss();
      mockTranslateSend.mockRejectedValueOnce(new Error('Translate down'));

      const result = await handler(buildCaptionsRequest('fr'));

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('Hello');
      // Don't cache a track containing untranslated fallback text
      expect(mockS3Send.mock.calls.filter((c) => c[0].type === 'PutObject')).toHaveLength(0);
    });

    it('still returns 200 when the S3 cache write fails', async () => {
      mockDynamo({ rows: [captionRow(1, 'Hello')] });
      mockS3Send.mockImplementation((cmd) => {
        if (cmd.type === 'GetObject') {
          return Promise.reject(noSuchKeyError());
        }
        return Promise.reject(new Error('S3 write denied'));
      });

      const result = await handler(buildCaptionsRequest('original'));

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('Hello');
    });

    it('regenerates from rows when the S3 cache read fails with a non-404 error', async () => {
      mockDynamo({ rows: [captionRow(1, 'Hello')] });
      mockS3Send.mockImplementation((cmd) => {
        if (cmd.type === 'GetObject') {
          return Promise.reject(new Error('S3 unavailable'));
        }
        return Promise.resolve({});
      });

      const result = await handler(buildCaptionsRequest('original'));

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('WEBVTT');
      expect(result.body).toContain('Hello');
    });

    it('works for published events too', async () => {
      mockDynamo({
        item: endedEventItem({ status: 'published' }),
        rows: [captionRow(1, 'Hello')],
      });
      mockS3CacheMiss();

      const result = await handler(buildCaptionsRequest('original'));
      expect(result.statusCode).toBe(200);
    });
  });
});
