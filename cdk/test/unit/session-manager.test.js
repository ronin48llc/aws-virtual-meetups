'use strict';

// Mock AWS SDK clients
const mockDdbSend = jest.fn();
const mockIvsRealTimeSend = jest.fn();
const mockIvsChatSend = jest.fn();
const mockApiGwSend = jest.fn();
const mockLambdaSend = jest.fn();

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
const SEND_MOCKS = [mockDdbSend, mockIvsRealTimeSend, mockIvsChatSend, mockApiGwSend, mockLambdaSend];

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
