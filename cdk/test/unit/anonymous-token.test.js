'use strict';

// Mock AWS SDK clients
const mockDdbSend = jest.fn();
const mockIvsSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  GetItemCommand: jest.fn((params) => ({ type: 'GetItem', params })),
  UpdateItemCommand: jest.fn((params) => ({ type: 'UpdateItem', params })),
  PutItemCommand: jest.fn((params) => ({ type: 'PutItem', params })),
}));
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsSend })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.STAGE_ARN = 'arn:aws:ivs:us-east-1:123456789:stage/default-stage';

const { handler } = require('../../lambda/anonymous-token/index');

function buildEvent({ method, resource, pathParameters, body }) {
  return {
    httpMethod: method,
    resource,
    pathParameters: pathParameters || null,
    body: body ? JSON.stringify(body) : null,
  };
}

const validFingerprint = 'a3f8b2c1d4e5f6a7';

describe('Anonymous Token Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Route dispatcher', () => {
    it('returns 400 when event ID is missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join-anonymous',
        pathParameters: null,
        body: { fingerprint: validFingerprint },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID is required');
    });

    it('returns 400 for unsupported route', async () => {
      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/join-anonymous',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Unsupported route');
    });
  });

  describe('POST /events/{id}/join-anonymous', () => {
    describe('Fingerprint validation', () => {
      it('returns 400 when body is missing', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: null,
        });
        event.body = null;

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
      });

      it('returns 400 when fingerprint is missing', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: {},
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.message).toContain('Browser fingerprint is required');
      });

      it('returns 400 when fingerprint is too short', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: 'abc' },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.message).toContain('Invalid fingerprint format');
      });

      it('returns 400 when fingerprint contains non-hex characters', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: 'zzzzzzzz' },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.message).toContain('Invalid fingerprint format');
      });

      it('returns 400 when fingerprint is longer than 64 chars', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: 'a'.repeat(65) },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.message).toContain('Invalid fingerprint format');
      });
    });

    describe('Event status validation', () => {
      it('returns 404 when event not found', async () => {
        mockDdbSend.mockResolvedValueOnce({ Item: undefined }); // GetItem for event

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_nonexistent' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(404);
        const body = JSON.parse(result.body);
        expect(body.message).toBe('Event not found');
      });

      it('returns 400 when event is not live (scheduled)', async () => {
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'scheduled' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.message).toBe('Event is not currently live');
      });

      it('returns 400 when event is ended', async () => {
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'ended' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.message).toBe('Event is not currently live');
      });
    });

    describe('Rate limiting', () => {
      it('returns 429 when rate limit is exceeded (>= 10 requests)', async () => {
        // GetItem for event metadata - live
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        // GetItem for rate limit - at limit
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'RATELIMIT#a3f8b2c1d4e5f6a7' },
            SK: { S: 'MINUTE#2024-01-15T10:30' },
            count: { N: '10' },
          },
        });

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(429);
        const body = JSON.parse(result.body);
        expect(body.message).toContain('Too many requests');
      });

      it('allows request when rate limit is not exceeded', async () => {
        // GetItem for event metadata - live
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        // GetItem for rate limit - under limit
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'RATELIMIT#a3f8b2c1d4e5f6a7' },
            SK: { S: 'MINUTE#2024-01-15T10:30' },
            count: { N: '5' },
          },
        });
        // IVS CreateParticipantToken
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-stage-token-123' },
        });
        // UpdateItem for rate limit increment
        mockDdbSend.mockResolvedValueOnce({});
        // PutItem for session record
        mockDdbSend.mockResolvedValueOnce({});

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);
      });
    });

    describe('Successful token generation', () => {
      beforeEach(() => {
        // GetItem for event metadata - live
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        // GetItem for rate limit - no existing record
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        // IVS CreateParticipantToken
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-stage-token-123' },
        });
        // UpdateItem for rate limit increment
        mockDdbSend.mockResolvedValueOnce({});
        // PutItem for session record
        mockDdbSend.mockResolvedValueOnce({});
      });

      it('returns stageToken, sessionId, and eventStatus', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);

        const body = JSON.parse(result.body);
        expect(body.stageToken).toBe('test-stage-token-123');
        expect(body.sessionId).toBeDefined();
        expect(body.eventStatus).toBe('live');
      });

      it('does NOT include fingerprint in response', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        const body = JSON.parse(result.body);
        expect(body.fingerprint).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(validFingerprint);
      });

      it('calls CreateParticipantToken with SUBSCRIBE-only capability', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        await handler(event);

        const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
        expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            capabilities: ['SUBSCRIBE'],
          })
        );
      });

      it('sets displayName to "Anonymous Viewer" in token attributes', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        await handler(event);

        const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
        expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            attributes: expect.objectContaining({
              displayName: 'Anonymous Viewer',
            }),
          })
        );
      });

      it('includes fingerprint as participant attribute', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        await handler(event);

        const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
        expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            attributes: expect.objectContaining({
              fingerprint: validFingerprint,
            }),
          })
        );
      });

      it('sets token duration to 720 minutes', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        await handler(event);

        const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
        expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            duration: 720,
          })
        );
      });
    });

    describe('Error handling', () => {
      it('returns 500 when IVS token creation fails', async () => {
        // GetItem for event metadata - live
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        // GetItem for rate limit - no record
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        // IVS CreateParticipantToken fails
        mockIvsSend.mockRejectedValueOnce(new Error('IVS service error'));

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(500);
        const body = JSON.parse(result.body);
        expect(body.message).toBe('Failed to generate viewing token');
      });

      it('still returns token when rate limit increment fails', async () => {
        // GetItem for event metadata - live
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        // GetItem for rate limit - no record
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        // IVS CreateParticipantToken succeeds
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-stage-token-123' },
        });
        // UpdateItem for rate limit increment fails
        mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB write error'));
        // PutItem for session record succeeds
        mockDdbSend.mockResolvedValueOnce({});

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.stageToken).toBe('test-stage-token-123');
      });

      it('still returns token when session record write fails', async () => {
        // GetItem for event metadata - live
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        // GetItem for rate limit - no record
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        // IVS CreateParticipantToken succeeds
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-stage-token-123' },
        });
        // UpdateItem for rate limit increment succeeds
        mockDdbSend.mockResolvedValueOnce({});
        // PutItem for session record fails
        mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB write error'));

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.stageToken).toBe('test-stage-token-123');
      });
    });

    describe('Edge cases', () => {
      it('accepts fingerprint with exactly 8 hex chars (minimum)', async () => {
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-token' },
        });
        mockDdbSend.mockResolvedValueOnce({});
        mockDdbSend.mockResolvedValueOnce({});

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: 'abcdef12' },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);
      });

      it('accepts fingerprint with exactly 64 hex chars (maximum)', async () => {
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: 'arn:aws:ivs:us-east-1:123456789:stage/test' },
          },
        });
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-token' },
        });
        mockDdbSend.mockResolvedValueOnce({});
        mockDdbSend.mockResolvedValueOnce({});

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: 'a'.repeat(64) },
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);
      });

      it('uses event stageArn when available', async () => {
        const eventStageArn = 'arn:aws:ivs:us-east-1:123456789:stage/event-specific';
        mockDdbSend.mockResolvedValueOnce({
          Item: {
            PK: { S: 'EVENT#evt_abc' },
            SK: { S: 'METADATA' },
            status: { S: 'live' },
            stageArn: { S: eventStageArn },
          },
        });
        mockDdbSend.mockResolvedValueOnce({ Item: undefined });
        mockIvsSend.mockResolvedValueOnce({
          participantToken: { token: 'test-token' },
        });
        mockDdbSend.mockResolvedValueOnce({});
        mockDdbSend.mockResolvedValueOnce({});

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/join-anonymous',
          pathParameters: { id: 'evt_abc' },
          body: { fingerprint: validFingerprint },
        });

        await handler(event);

        const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
        expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            stageArn: eventStageArn,
          })
        );
      });
    });
  });
});
