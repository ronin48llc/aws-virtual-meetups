'use strict';

// Mock AWS SDK clients
const mockDdbSend = jest.fn();
const mockIvsRealTimeSend = jest.fn();
const mockIvsChatSend = jest.fn();
const mockApiGwSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDdbSend })),
  },
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
}));
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsRealTimeSend })),
  CreateStageCommand: jest.fn((params) => ({ type: 'CreateStage', params })),
  DeleteStageCommand: jest.fn((params) => ({ type: 'DeleteStage', params })),
  StartCompositionCommand: jest.fn((params) => ({ type: 'StartComposition', params })),
  StopCompositionCommand: jest.fn((params) => ({ type: 'StopComposition', params })),
  GetCompositionCommand: jest.fn((params) => ({ type: 'GetComposition', params })),
}));
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: mockIvsChatSend })),
  CreateRoomCommand: jest.fn((params) => ({ type: 'CreateRoom', params })),
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((params) => ({ type: 'PutObject', params })),
}));
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiGwSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.RECORDING_BUCKET_NAME = 'test-recording-bucket';
process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.STORAGE_CONFIGURATION_ARN = 'arn:aws:ivs:us-east-1:123456789:storage-configuration/abc';
process.env.ENCODER_CONFIGURATION_ARN = 'arn:aws:ivs:us-east-1:123456789:encoder-configuration/def';
process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789:function:VirtualMeetup-EmailSender';
// Issue #101: wires the chat-review handler into CreateRoom
process.env.CHAT_REVIEW_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789:function:VirtualMeetup-ChatReview';

const { handler } = require('../../lambda/session-manager/index');

function buildEvent({ method, resource, pathParameters, claims }) {
  const event = {
    httpMethod: method,
    resource,
    pathParameters: pathParameters || null,
    requestContext: {},
  };
  if (claims) {
    event.requestContext.authorizer = { claims };
  }
  return event;
}

const validClaims = {
  sub: 'user-123',
  email: 'test@example.com',
  'custom:role': 'organizer',
};

const scheduledEvent = {
  PK: 'EVENT#evt_abc',
  SK: 'METADATA',
  eventId: 'evt_abc',
  title: 'Test Event',
  status: 'scheduled',
  ownerUserId: 'user-123',
};

const liveEvent = {
  PK: 'EVENT#evt_abc',
  SK: 'METADATA',
  eventId: 'evt_abc',
  title: 'Test Event',
  status: 'live',
  ownerUserId: 'user-123',
  stageArn: 'arn:aws:ivs:us-east-1:123456789:stage/existing-stage',
  chatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/existing-room',
  compositionArn: 'arn:aws:ivs:us-east-1:123456789:composition/existing-comp',
};

// The per-call "send" spies — reset fully between tests so a mockResolvedValue
// (or a leftover *Once queue) from one test can't bleed into the next. That
// cross-test bleed was the original failure. We deliberately do NOT call
// jest.resetAllMocks(): that also wipes the jest.mock() factory implementations
// above (client constructors return { send: mock... }, command constructors
// return { type, params }), which silently breaks the WebSocket broadcast and
// DDB command shapes the handler relies on.
const SEND_MOCKS = [mockDdbSend, mockIvsRealTimeSend, mockIvsChatSend, mockApiGwSend, mockLambdaSend, mockS3Send];

describe('Session Manager Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();              // drop call history everywhere (keeps factory impls)
    SEND_MOCKS.forEach((m) => m.mockReset()); // fully reset only the send spies (impl + queues)
  });

  describe('POST /events/{id}/start - Start Event', () => {
    it('creates IVS Stage and Chat Room, updates status to staging, returns 200', async () => {
      // GetCommand: fetch event
      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });
      // IVS CreateStage
      mockIvsRealTimeSend.mockResolvedValueOnce({
        stage: { arn: 'arn:aws:ivs:us-east-1:123456789:stage/new-stage' },
      });
      // IVS Chat CreateRoom
      mockIvsChatSend.mockResolvedValueOnce({
        arn: 'arn:aws:ivschat:us-east-1:123456789:room/new-room',
      });
      // UpdateCommand: update event status
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.eventId).toBe('evt_abc');
      expect(body.status).toBe('staging');
      expect(body.stageArn).toBe('arn:aws:ivs:us-east-1:123456789:stage/new-stage');
      expect(body.chatRoomArn).toBe('arn:aws:ivschat:us-east-1:123456789:room/new-room');
    });

    it('does not broadcast EVENT_STARTED on start (deferred to go-live)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });
      mockIvsRealTimeSend.mockResolvedValueOnce({
        stage: { arn: 'arn:aws:ivs:us-east-1:123456789:stage/new-stage' },
      });
      mockIvsChatSend.mockResolvedValueOnce({
        arn: 'arn:aws:ivschat:us-east-1:123456789:room/new-room',
      });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      await handler(event);

      // Verify no broadcast was sent (no ApiGw calls)
      expect(mockApiGwSend).not.toHaveBeenCalled();
    });

    it('does not invoke Email Lambda on start (deferred to go-live)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });
      mockIvsRealTimeSend.mockResolvedValueOnce({
        stage: { arn: 'arn:aws:ivs:us-east-1:123456789:stage/new-stage' },
      });
      mockIvsChatSend.mockResolvedValueOnce({
        arn: 'arn:aws:ivschat:us-east-1:123456789:room/new-room',
      });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Verify Email Lambda was NOT invoked
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('succeeds without broadcast or email on start', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });
      mockIvsRealTimeSend.mockResolvedValueOnce({
        stage: { arn: 'arn:aws:ivs:us-east-1:123456789:stage/new-stage' },
      });
      mockIvsChatSend.mockResolvedValueOnce({
        arn: 'arn:aws:ivschat:us-east-1:123456789:room/new-room',
      });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe('staging');
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 404 when event not found', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_nonexistent' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('returns 403 when not the owner', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: { ...scheduledEvent, ownerUserId: 'other-user' },
      });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 400 when event is not in scheduled status', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Cannot start event');
    });

    it('returns 400 when event ID is missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: null,
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID is required');
    });

    // Issue #101: chat-review must be wired into IVS Chat or moderation
    // is silently off. Verify CreateRoom carries the messageReviewHandler.
    it('passes messageReviewHandler to CreateRoomCommand with fail-closed fallback (#101)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });
      mockIvsRealTimeSend.mockResolvedValueOnce({
        stage: { arn: 'arn:aws:ivs:us-east-1:123456789:stage/new-stage' },
      });
      mockIvsChatSend.mockResolvedValueOnce({
        arn: 'arn:aws:ivschat:us-east-1:123456789:room/new-room',
      });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      await handler(event);

      const { CreateRoomCommand } = require('@aws-sdk/client-ivschat');
      expect(CreateRoomCommand).toHaveBeenCalledWith(expect.objectContaining({
        name: 'meetup-chat-evt_abc',
        messageReviewHandler: {
          uri: 'arn:aws:lambda:us-east-1:123456789:function:VirtualMeetup-ChatReview',
          fallbackResult: 'DENY',
        },
      }));
    });

    it('omits messageReviewHandler when CHAT_REVIEW_LAMBDA_ARN is empty (#101)', async () => {
      // Temporarily un-wire the chat-review env, re-require handler with fresh module cache.
      const originalArn = process.env.CHAT_REVIEW_LAMBDA_ARN;
      process.env.CHAT_REVIEW_LAMBDA_ARN = '';
      jest.resetModules();
      const { handler: handlerNoReview } = require('../../lambda/session-manager/index');

      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });
      mockIvsRealTimeSend.mockResolvedValueOnce({
        stage: { arn: 'arn:aws:ivs:us-east-1:123456789:stage/new-stage' },
      });
      mockIvsChatSend.mockResolvedValueOnce({
        arn: 'arn:aws:ivschat:us-east-1:123456789:room/new-room',
      });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      await handlerNoReview(event);

      const { CreateRoomCommand } = require('@aws-sdk/client-ivschat');
      const lastCall = CreateRoomCommand.mock.calls[CreateRoomCommand.mock.calls.length - 1][0];
      expect(lastCall).toEqual({ name: 'meetup-chat-evt_abc' });
      expect(lastCall.messageReviewHandler).toBeUndefined();

      // Restore for any subsequent tests.
      process.env.CHAT_REVIEW_LAMBDA_ARN = originalArn;
      jest.resetModules();
    });
  });

  describe('POST /events/{id}/stop - Stop Event', () => {
    it('stops composition, updates status to ended, deletes stage, returns 200', async () => {
      // GetCommand: fetch event
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // StopComposition
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // GetComposition — supplies the recording prefix used to build hlsPlaybackUrl
      mockIvsRealTimeSend.mockResolvedValueOnce({
        composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
      });
      // UpdateCommand: set hlsPlaybackUrl
      mockDdbSend.mockResolvedValueOnce({});
      // UpdateCommand: update event status
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: get connections for broadcast
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // DeleteStage
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // QueryCommand: signups count for engagement metrics
      mockDdbSend.mockResolvedValueOnce({ Count: 5 });
      // QueryCommand: questions count for engagement metrics
      mockDdbSend.mockResolvedValueOnce({ Count: 2 });
      // QueryCommand: anonymous viewer sessions
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // PutCommand: store engagement summary
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.eventId).toBe('evt_abc');
      expect(body.status).toBe('ended');
      expect(body.endedAt).toBeDefined();
    });

    it('writes recordings/{eventId}/metadata.json so the publisher fires (with the real HLS URL)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // StopComposition
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // GetComposition — real recording prefix differs from recordings/{eventId}/
      mockIvsRealTimeSend.mockResolvedValueOnce({
        composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
      });
      // UpdateCommand: set hlsPlaybackUrl
      mockDdbSend.mockResolvedValueOnce({});
      // PutObject: metadata.json
      mockS3Send.mockResolvedValueOnce({});
      // UpdateCommand: update event status
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: get connections for broadcast
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // DeleteStage
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // Engagement metrics queries (signups, questions, anon sessions) + put
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Assert via the stable send spy, not a late require() of
      // PutObjectCommand — earlier tests call jest.resetModules(), which
      // hands a fresh require() an empty mock (see the note on the
      // engagement-metrics test below). Commands are the { type, params }
      // shape from the mock factory.
      const putCall = mockS3Send.mock.calls
        .map((c) => c[0])
        .find((cmd) => cmd && cmd.type === 'PutObject');
      expect(putCall).toBeDefined();
      expect(putCall.params.Key).toBe('recordings/evt_abc/metadata.json');
      expect(putCall.params.ContentType).toBe('application/json');
      const metadataBody = JSON.parse(putCall.params.Body);
      expect(metadataBody.eventId).toBe('evt_abc');
      // The URL must reflect IVS's real prefix, not recordings/{eventId}/
      expect(metadataBody.hlsPlaybackUrl).toContain('ivs/v1/abc/media/hls/multivariant.m3u8');
    });

    it('skips the playback URL and metadata when the composition FAILED', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // StopComposition
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // GetComposition — FAILED composition recorded nothing
      mockIvsRealTimeSend.mockResolvedValueOnce({
        composition: {
          state: 'FAILED',
          destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }],
        },
      });
      // UpdateCommand: update event status (NO hlsPlaybackUrl update first)
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: connections broadcast
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // DeleteStage
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // Engagement metrics (signups, questions, anon sessions, put)
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // No metadata.json written, no hlsPlaybackUrl set.
      const putObject = mockS3Send.mock.calls.map((c) => c[0]).find((cmd) => cmd && cmd.type === 'PutObject');
      expect(putObject).toBeUndefined();
      const hlsUpdate = mockDdbSend.mock.calls.map((c) => c[0]).find(
        (cmd) => cmd && cmd.type === 'Update' && cmd.params.UpdateExpression
          && cmd.params.UpdateExpression.includes('hlsPlaybackUrl')
      );
      expect(hlsUpdate).toBeUndefined();
    });

    it('still ends the event when the metadata write fails (non-blocking)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      mockIvsRealTimeSend.mockResolvedValueOnce({
        composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
      });
      mockDdbSend.mockResolvedValueOnce({});
      mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));
      mockDdbSend.mockResolvedValueOnce({});
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).status).toBe('ended');
    });

    it('broadcasts EVENT_ENDED to connected clients', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // StopComposition
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // GetComposition — supplies the recording prefix used to build hlsPlaybackUrl
      mockIvsRealTimeSend.mockResolvedValueOnce({
        composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
      });
      // UpdateCommand: set hlsPlaybackUrl
      mockDdbSend.mockResolvedValueOnce({});
      // UpdateCommand: update event status
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: get connections for broadcast
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc' }],
      });
      mockApiGwSend.mockResolvedValue({});
      // DeleteStage
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // QueryCommand: signups count
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      // QueryCommand: questions count
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      // QueryCommand: anonymous viewer sessions
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // PutCommand: store engagement summary
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      await handler(event);

      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 404 when event not found', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_nonexistent' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('returns 403 when not the owner', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: { ...liveEvent, ownerUserId: 'other-user' },
      });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 400 when event is not in live or staging status', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: scheduledEvent });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Cannot stop event');
    });

    it('handles stage deletion failure gracefully', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // StopComposition
      mockIvsRealTimeSend.mockResolvedValueOnce({});
      // GetComposition — supplies the recording prefix used to build hlsPlaybackUrl
      mockIvsRealTimeSend.mockResolvedValueOnce({
        composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
      });
      // UpdateCommand: set hlsPlaybackUrl
      mockDdbSend.mockResolvedValueOnce({});
      // UpdateCommand: update event status
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: get connections for broadcast
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // DeleteStage fails
      mockIvsRealTimeSend.mockRejectedValueOnce(new Error('Stage in use'));
      // QueryCommand: signups count
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      // QueryCommand: questions count
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });
      // QueryCommand: anonymous viewer sessions
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      // PutCommand: store engagement summary
      mockDdbSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      // Should still succeed even if stage deletion fails
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });

    it('returns 400 when event ID is missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/stop',
        pathParameters: null,
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID is required');
    });

    describe('engagement summary count pagination (issue #64)', () => {
      it('sums Count across paginated signups + questions queries', async () => {
        // Mock the entire endSession path with paginated counts:
        // - signups: 3 pages of Count = 1500 + 1500 + 200 = 3200
        // - questions: 2 pages of Count = 800 + 50 = 850
        mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });           // get event
        mockIvsRealTimeSend.mockResolvedValueOnce({});                     // stop composition
        mockIvsRealTimeSend.mockResolvedValueOnce({                        // get composition (recording prefix)
          composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
        });
        mockDdbSend.mockResolvedValueOnce({});                             // set hlsPlaybackUrl
        mockDdbSend.mockResolvedValueOnce({});                             // update status
        mockDdbSend.mockResolvedValueOnce({ Items: [] });                  // broadcast connections
        mockIvsRealTimeSend.mockResolvedValueOnce({});                     // delete stage

        // signups COUNT page 1
        mockDdbSend.mockResolvedValueOnce({ Count: 1500, LastEvaluatedKey: { k: 1 } });
        // signups COUNT page 2
        mockDdbSend.mockResolvedValueOnce({ Count: 1500, LastEvaluatedKey: { k: 2 } });
        // signups COUNT page 3 (terminates)
        mockDdbSend.mockResolvedValueOnce({ Count: 200 });

        // questions COUNT page 1
        mockDdbSend.mockResolvedValueOnce({ Count: 800, LastEvaluatedKey: { k: 3 } });
        // questions COUNT page 2 (terminates)
        mockDdbSend.mockResolvedValueOnce({ Count: 50 });

        // anonymous viewer sessions (none)
        mockDdbSend.mockResolvedValueOnce({ Items: [] });

        // storeEngagementSummary's UpdateCommand
        mockDdbSend.mockResolvedValueOnce({ Attributes: {} });

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/stop',
          pathParameters: { id: 'evt_abc' },
          claims: validClaims,
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);

        // Assert via the stable send spy, NOT a late require() of UpdateCommand:
        // the env-config tests above call jest.resetModules(), which would hand a
        // fresh require() an empty mock (passes in isolation, fails in the full
        // suite). mockDdbSend is a top-level const the mock factory closes over,
        // so it always captures the handler's real calls. Each command is the
        // { type, params } shape returned by the UpdateCommand mock factory.
        const finalUpdate = mockDdbSend.mock.calls
          .map((c) => c[0])
          .find((cmd) => cmd && cmd.params && cmd.params.ExpressionAttributeValues
            && cmd.params.ExpressionAttributeValues[':totalAttendees'] !== undefined);
        expect(finalUpdate).toBeDefined();
        expect(finalUpdate.params.ExpressionAttributeValues[':totalAttendees']).toBe(3200);
        expect(finalUpdate.params.ExpressionAttributeValues[':totalQuestions']).toBe(850);
      });
    });

    describe('anonymous viewer metrics (distinct fingerprints)', () => {
      it('counts distinct live fingerprints across pages, excludes playback rows, stores anonymousViewers', async () => {
        mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });           // get event
        mockIvsRealTimeSend.mockResolvedValueOnce({});                     // stop composition
        mockIvsRealTimeSend.mockResolvedValueOnce({                        // get composition (recording prefix)
          composition: { destinations: [{ detail: { s3: { recordingPrefix: 'ivs/v1/abc' } } }] },
        });
        mockDdbSend.mockResolvedValueOnce({});                             // set hlsPlaybackUrl
        mockDdbSend.mockResolvedValueOnce({});                             // update status
        mockDdbSend.mockResolvedValueOnce({ Items: [] });                  // broadcast connections
        mockIvsRealTimeSend.mockResolvedValueOnce({});                     // delete stage

        // signups + questions counts
        mockDdbSend.mockResolvedValueOnce({ Count: 10 });
        mockDdbSend.mockResolvedValueOnce({ Count: 3 });

        // ANON# page 1: fp1 with two live sessions (counts once) + a playback row
        mockDdbSend.mockResolvedValueOnce({
          Items: [
            { SK: 'ANON#fp1#sess-1', sessionType: 'live' },
            { SK: 'ANON#fp1#sess-2', sessionType: 'live' },
            { SK: 'ANON#fp2#sess-3', sessionType: 'playback' },
          ],
          LastEvaluatedKey: { k: 'anon-1' },
        });
        // ANON# page 2 (terminates): a second live fingerprint
        mockDdbSend.mockResolvedValueOnce({
          Items: [{ SK: 'ANON#fp3#sess-4', sessionType: 'live' }],
        });

        // storeEngagementSummary's UpdateCommand
        mockDdbSend.mockResolvedValueOnce({ Attributes: {} });

        const event = buildEvent({
          method: 'POST',
          resource: '/events/{id}/stop',
          pathParameters: { id: 'evt_abc' },
          claims: validClaims,
        });

        const result = await handler(event);
        expect(result.statusCode).toBe(200);

        // The anon query pages over real SKs (no Select:COUNT — COUNT can't dedupe)
        const anonQueries = mockDdbSend.mock.calls
          .map((c) => c[0])
          .filter((cmd) => cmd && cmd.type === 'Query' && cmd.params.ExpressionAttributeValues
            && cmd.params.ExpressionAttributeValues[':skPrefix'] === 'ANON#');
        expect(anonQueries).toHaveLength(2);
        expect(anonQueries[0].params.Select).toBeUndefined();
        expect(anonQueries[0].params.ProjectionExpression).toBe('SK, sessionType');
        expect(anonQueries[1].params.ExclusiveStartKey).toEqual({ k: 'anon-1' });

        const finalUpdate = mockDdbSend.mock.calls
          .map((c) => c[0])
          .find((cmd) => cmd && cmd.params && cmd.params.ExpressionAttributeValues
            && cmd.params.ExpressionAttributeValues[':anonymousViewers'] !== undefined);
        expect(finalUpdate).toBeDefined();
        // fp1 (deduped across two sessions) + fp3; fp2's playback-only row is excluded
        expect(finalUpdate.params.ExpressionAttributeValues[':anonymousViewers']).toBe(2);
        expect(finalUpdate.params.ExpressionAttributeValues[':totalAttendees']).toBe(10);
        expect(finalUpdate.params.ExpressionAttributeValues[':totalQuestions']).toBe(3);
        // The summary write keeps the first-writer-wins guard
        expect(finalUpdate.params.ConditionExpression).toBe('attribute_not_exists(#finalizedAt)');
      });
    });
  });

  describe('Direct invocation - auto-stop engagement summary', () => {
    it('ends the event and stores all four summary fields via storeEngagementSummary', async () => {
      const startedAt = new Date(Date.now() - 3600 * 1000).toISOString();
      mockDdbSend.mockResolvedValueOnce({ Item: { ...liveEvent, startedAt } }); // get event
      mockDdbSend.mockResolvedValueOnce({});                                    // update status
      mockDdbSend.mockResolvedValueOnce({ Items: [] });                         // broadcast connections
      mockDdbSend.mockResolvedValueOnce({ Count: 4 });                          // signups count
      mockDdbSend.mockResolvedValueOnce({ Count: 1 });                          // questions count
      mockDdbSend.mockResolvedValueOnce({                                       // anon sessions
        Items: [
          { SK: 'ANON#fpA#s1', sessionType: 'live' },
          { SK: 'ANON#fpB#s2', sessionType: 'playback' },
        ],
      });
      mockDdbSend.mockResolvedValueOnce({ Attributes: {} });                    // store summary

      const result = await handler({ action: 'auto-stop', eventId: 'evt_abc' });
      expect(result.status).toBe('stopped');

      const summaryUpdate = mockDdbSend.mock.calls
        .map((c) => c[0])
        .find((cmd) => cmd && cmd.params && cmd.params.ExpressionAttributeValues
          && cmd.params.ExpressionAttributeValues[':totalAttendees'] !== undefined);
      expect(summaryUpdate).toBeDefined();
      const values = summaryUpdate.params.ExpressionAttributeValues;
      expect(values[':totalAttendees']).toBe(4);
      expect(values[':totalQuestions']).toBe(1);
      expect(values[':anonymousViewers']).toBe(1);
      // durationSeconds derives from the event's startedAt (about 1 hour ago)
      expect(values[':durationSeconds']).toBeGreaterThanOrEqual(3600);
      expect(values[':durationSeconds']).toBeLessThanOrEqual(3602);
      expect(summaryUpdate.params.ConditionExpression).toBe('attribute_not_exists(#finalizedAt)');
    });

    it('still returns stopped when a manual stop already finalized the summary (first writer wins)', async () => {
      const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
      mockDdbSend.mockResolvedValueOnce({ Item: { ...liveEvent, startedAt } }); // get event
      mockDdbSend.mockResolvedValueOnce({});                                    // update status
      mockDdbSend.mockResolvedValueOnce({ Items: [] });                         // broadcast connections
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });                          // signups count
      mockDdbSend.mockResolvedValueOnce({ Count: 0 });                          // questions count
      mockDdbSend.mockResolvedValueOnce({ Items: [] });                         // anon sessions
      const guardErr = new Error('The conditional request failed');
      guardErr.name = 'ConditionalCheckFailedException';
      mockDdbSend.mockRejectedValueOnce(guardErr);                              // summary already finalized

      const result = await handler({ action: 'auto-stop', eventId: 'evt_abc' });
      expect(result.status).toBe('stopped');
    });

    it('does no metrics work on a stale trigger (event no longer live)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: { ...liveEvent, status: 'ended' } });

      const result = await handler({ action: 'auto-stop', eventId: 'evt_abc' });
      expect(result).toEqual({ status: 'skipped', reason: 'not_live' });
      // Only the initial GetCommand — no status update, no counting, no summary write
      expect(mockDdbSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('Unsupported routes', () => {
    it('returns 400 for unsupported method/resource', async () => {
      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Unsupported route');
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/start',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
    });
  });
});
