'use strict';

// Mock AWS SDK
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  GetItemCommand: jest.fn((params) => ({ type: 'GetItem', params })),
  UpdateItemCommand: jest.fn((params) => ({ type: 'UpdateItem', params })),
  PutItemCommand: jest.fn((params) => ({ type: 'PutItem', params })),
}));

jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
}));

// Mock crypto
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'test-session-uuid-1234'),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';

const { handler } = require('../../lambda/anonymous-token/index');

function buildEvent({ body, pathParameters, resource }) {
  return {
    httpMethod: 'POST',
    resource: resource || '/events/{id}/playback-anonymous',
    body: body ? JSON.stringify(body) : null,
    pathParameters: pathParameters || { id: 'evt_test123' },
    requestContext: {},
  };
}

const validFingerprint = 'a3f8b2c1d4e5f6a7';

describe('Anonymous Token Lambda - playbackAnonymous', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Fingerprint validation', () => {
    it('returns 400 when body is empty', async () => {
      const event = buildEvent({ pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('returns 400 when fingerprint is missing', async () => {
      const event = buildEvent({ body: {}, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('fingerprint');
    });

    it('returns 400 when fingerprint is too short', async () => {
      const event = buildEvent({ body: { fingerprint: 'abc' }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Invalid fingerprint format');
    });

    it('returns 400 when fingerprint contains non-hex characters', async () => {
      const event = buildEvent({ body: { fingerprint: 'zzzzzzzzzz' }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Invalid fingerprint format');
    });
  });

  describe('Recording lookup', () => {
    it('returns 404 when recording does not exist', async () => {
      // GetItemCommand returns no item
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({ body: { fingerprint: validFingerprint }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Recording not found');
    });

    it('returns 404 when recording exists but has no playback URL', async () => {
      // GetItemCommand returns item without playbackUrl
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: { S: 'EVENT#evt_123' },
          SK: { S: 'RECORDING' },
          // No playbackUrl field
        },
      });

      const event = buildEvent({ body: { fingerprint: validFingerprint }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Recording not yet available');
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      // GetItemCommand returns recording with playbackUrl
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: { S: 'EVENT#evt_123' },
          SK: { S: 'RECORDING' },
          playbackUrl: { S: 'https://cdn.example.com/recording.m3u8' },
        },
      });
      // UpdateItemCommand returns count > 10
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: '11' } },
      });

      const event = buildEvent({ body: { fingerprint: validFingerprint }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(429);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Too many requests');
    });
  });

  describe('Successful playback access', () => {
    it('returns hlsPlaybackUrl and sessionId on success', async () => {
      const playbackUrl = 'https://cdn.example.com/recordings/evt_123/master.m3u8';

      // GetItemCommand returns recording with playbackUrl
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: { S: 'EVENT#evt_123' },
          SK: { S: 'RECORDING' },
          playbackUrl: { S: playbackUrl },
        },
      });
      // UpdateItemCommand returns count within limit
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: '3' } },
      });
      // PutItemCommand for session record
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({ body: { fingerprint: validFingerprint }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.hlsPlaybackUrl).toBe(playbackUrl);
      expect(body.sessionId).toBe('test-session-uuid-1234');
    });

    it('does NOT include fingerprint in the response', async () => {
      const playbackUrl = 'https://cdn.example.com/recordings/evt_123/master.m3u8';

      mockSend.mockResolvedValueOnce({
        Item: {
          PK: { S: 'EVENT#evt_123' },
          SK: { S: 'RECORDING' },
          playbackUrl: { S: playbackUrl },
        },
      });
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: '1' } },
      });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({ body: { fingerprint: validFingerprint }, pathParameters: { id: 'evt_123' } });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.fingerprint).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(validFingerprint);
    });

    it('writes session record with sessionType playback', async () => {
      const playbackUrl = 'https://cdn.example.com/recordings/evt_123/master.m3u8';

      mockSend.mockResolvedValueOnce({
        Item: {
          PK: { S: 'EVENT#evt_123' },
          SK: { S: 'RECORDING' },
          playbackUrl: { S: playbackUrl },
        },
      });
      mockSend.mockResolvedValueOnce({
        Attributes: { count: { N: '2' } },
      });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({ body: { fingerprint: validFingerprint }, pathParameters: { id: 'evt_123' } });
      await handler(event);

      // Verify PutItemCommand was called (3rd call to mockSend)
      const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
      expect(PutItemCommand).toHaveBeenCalledTimes(1);
      const putParams = PutItemCommand.mock.calls[0][0];
      expect(putParams.Item.sessionType.S).toBe('playback');
      expect(putParams.Item.PK.S).toBe('EVENT#evt_123');
      expect(putParams.Item.fingerprint.S).toBe(validFingerprint);
    });
  });

  describe('Event ID validation', () => {
    it('returns 400 when event ID is missing', async () => {
      const event = {
        httpMethod: 'POST',
        resource: '/events/{id}/playback-anonymous',
        body: JSON.stringify({ fingerprint: validFingerprint }),
        pathParameters: {},
        requestContext: {},
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID');
    });
  });
});
