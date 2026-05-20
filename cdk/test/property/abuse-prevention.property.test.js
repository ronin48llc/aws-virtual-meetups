'use strict';

const fc = require('fast-check');

// --- Token Generator Mocks ---

const mockDdbSend = jest.fn();
const mockIvsRealTimeSend = jest.fn();
const mockIvsChatSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDdbSend })),
  },
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
}));
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsRealTimeSend })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
  DisconnectParticipantCommand: jest.fn((params) => ({ type: 'DisconnectParticipant', params })),
}), { virtual: true });
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: mockIvsChatSend })),
  CreateChatTokenCommand: jest.fn((params) => ({ type: 'CreateChatToken', params })),
  DisconnectUserCommand: jest.fn((params) => ({ type: 'DisconnectUser', params })),
}), { virtual: true });

// Mock API Gateway Management API
const mockPostToConnection = jest.fn();
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockPostToConnection })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

// Mock broadcast
const mockBroadcast = jest.fn().mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });
jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: mockBroadcast,
  getConnectionsForEvent: jest.fn().mockResolvedValue([]),
}));

// Mock rate limiter — always allow in tests
jest.mock('../../lambda/websocket/rate-limiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }),
  RATE_LIMIT: 60,
  RATE_WINDOW_SECONDS: 60,
}));

// Set env before requiring handlers
process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler: tokenHandler } = require('../../lambda/token-generator/index');
const { handler: signalingHandler } = require('../../lambda/websocket/signaling');

// --- Arbitraries ---

const arbUserId = fc.string({ minLength: 3, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_]+$/.test(s))
  .map((s) => `user_${s}`);

const arbEventId = fc.string({ minLength: 3, maxLength: 12 })
  .filter((s) => /^[a-zA-Z0-9]+$/.test(s))
  .map((s) => `evt_${s}`);

const arbConnectionId = fc.string({ minLength: 5, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_]+$/.test(s))
  .map((s) => `conn_${s}`);

const arbDisplayName = fc.string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

const arbMessage = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

const arbEmail = fc.string({ minLength: 3, maxLength: 15 })
  .filter((s) => /^[a-zA-Z0-9]+$/.test(s))
  .map((s) => `${s}@example.com`);

// --- Helpers ---

function buildTokenEvent({ eventId, claims }) {
  return {
    httpMethod: 'POST',
    resource: '/events/{id}/join',
    pathParameters: { id: eventId },
    requestContext: {
      authorizer: { claims },
    },
  };
}

function buildWebSocketEvent({ action, eventId, data, connectionId = 'conn-presenter-123' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

// --- Property Tests ---

describe('Abuse Prevention Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostToConnection.mockResolvedValue({});
    mockIvsRealTimeSend.mockResolvedValue({});
    mockIvsChatSend.mockResolvedValue({});
  });

  /**
   * Property 23: Banned users cannot obtain tokens
   * **Validates: Requirements 24.4**
   *
   * For any banned user attempting to join an event, the token request is rejected with 403.
   */
  describe('Property 23: Banned users cannot obtain tokens', () => {
    it('any banned user receives 403 when attempting to join an event', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbEmail,
          arbDisplayName,
          async (eventId, userId, email, displayName) => {
            jest.clearAllMocks();

            const claims = {
              sub: userId,
              email,
              'custom:displayName': displayName,
              email_verified: 'true',
            };

            // Mock: event exists and is live
            mockDdbSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                status: 'live',
                stageArn: 'arn:aws:ivs:us-east-1:123456789:stage/test',
                chatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/test',
              },
            });

            // Mock: ban record EXISTS for this user
            mockDdbSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: `BAN#${userId}`,
                userId,
                type: 'BAN',
              },
            });

            const event = buildTokenEvent({ eventId, claims });
            const result = await tokenHandler(event);

            // Banned user must receive 403
            expect(result.statusCode).toBe(403);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('You are banned from this event');

            // IVS tokens should NOT have been generated
            expect(mockIvsRealTimeSend).not.toHaveBeenCalled();
            expect(mockIvsChatSend).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 24: Non-promoted attendees cannot publish
   * **Validates: Requirements 27.5**
   *
   * For any attendee without co-presenter promotion, the issued token has
   * SUBSCRIBE-only capabilities (no PUBLISH).
   */
  describe('Property 24: Non-promoted attendees cannot publish', () => {
    it('attendees without speak permission receive SUBSCRIBE-only stage capabilities', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbEmail,
          arbDisplayName,
          async (eventId, userId, email, displayName) => {
            jest.clearAllMocks();

            const claims = {
              sub: userId,
              email,
              'custom:displayName': displayName,
              email_verified: 'true',
            };

            const stageArn = 'arn:aws:ivs:us-east-1:123456789:stage/test';
            const chatRoomArn = 'arn:aws:ivschat:us-east-1:123456789:room/test';

            // Mock: event exists and is live
            mockDdbSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                status: 'live',
                stageArn,
                chatRoomArn,
              },
            });

            // Mock: no ban record
            mockDdbSend.mockResolvedValueOnce({ Item: undefined });

            // Mock: auto-registration PutCommand (succeeds or already exists)
            mockDdbSend.mockResolvedValueOnce({});

            // Mock: connection exists as attendee WITHOUT speak permission
            mockDdbSend.mockResolvedValueOnce({
              Items: [{
                connectionId: `conn_${userId}`,
                eventId,
                userId,
                role: 'attendee',
                hasSpeakPermission: false,
              }],
            });

            // Mock IVS token responses
            mockIvsRealTimeSend.mockResolvedValueOnce({
              participantToken: {
                token: 'stage-token-xyz',
                participantId: 'participant-xyz',
                expirationTime: '2024-12-31T23:59:59Z',
              },
            });
            mockIvsChatSend.mockResolvedValueOnce({
              token: 'chat-token-xyz',
              sessionExpirationTime: '2024-12-31T23:59:59Z',
              tokenExpirationTime: '2024-12-31T12:00:00Z',
            });

            const event = buildTokenEvent({ eventId, claims });
            const result = await tokenHandler(event);

            expect(result.statusCode).toBe(200);
            const body = JSON.parse(result.body);

            // Non-promoted attendee must have SUBSCRIBE only — no PUBLISH
            expect(body.capabilities.stage).toEqual(['SUBSCRIBE']);
            expect(body.capabilities.stage).not.toContain('PUBLISH');

            // Verify the CreateParticipantTokenCommand was called with SUBSCRIBE only
            const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
            const tokenCall = CreateParticipantTokenCommand.mock.calls[
              CreateParticipantTokenCommand.mock.calls.length - 1
            ][0];
            expect(tokenCall.capabilities).toEqual(['SUBSCRIBE']);
            expect(tokenCall.capabilities).not.toContain('PUBLISH');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 25: Kicked users are disconnected from all services
   * **Validates: Requirements 24.1**
   *
   * For any kicked user, they are removed from IVS Stage, IVS Chat, and
   * WebSocket simultaneously.
   */
  describe('Property 25: Kicked users are disconnected from all services', () => {
    it('kickUser disconnects from IVS Stage, IVS Chat, and deletes WebSocket connection', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbConnectionId,
          async (eventId, userId, targetConnectionId) => {
            jest.clearAllMocks();
            mockPostToConnection.mockResolvedValue({});
            mockIvsRealTimeSend.mockResolvedValue({});
            mockIvsChatSend.mockResolvedValue({});
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            const stageArn = 'arn:aws:ivs:us-east-1:123456789:stage/test-stage';
            const chatRoomArn = 'arn:aws:ivschat:us-east-1:123456789:room/test-room';

            // Issue #70: dispatcher authz GET on the connections table.
            mockDdbSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId } });

            // Mock: GetCommand returns event metadata with IVS ARNs
            mockDdbSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                ivsStageArn: stageArn,
                ivsChatRoomArn: chatRoomArn,
              },
            });

            // Mock: DeleteCommand for connection removal
            mockDdbSend.mockResolvedValueOnce({});

            const event = buildWebSocketEvent({
              action: 'kickUser',
              eventId,
              data: { userId, targetConnectionId, reason: 'Disruptive behavior' },
            });

            const result = await signalingHandler(event);
            expect(result.statusCode).toBe(200);

            // Verify IVS Stage disconnect was called
            const { DisconnectParticipantCommand } = require('@aws-sdk/client-ivs-realtime');
            expect(DisconnectParticipantCommand).toHaveBeenCalledWith({
              stageArn,
              participantId: userId,
              reason: 'Disruptive behavior',
            });
            expect(mockIvsRealTimeSend).toHaveBeenCalled();

            // Verify IVS Chat disconnect was called
            const { DisconnectUserCommand } = require('@aws-sdk/client-ivschat');
            expect(DisconnectUserCommand).toHaveBeenCalledWith({
              roomIdentifier: chatRoomArn,
              userId,
              reason: 'Disruptive behavior',
            });
            expect(mockIvsChatSend).toHaveBeenCalled();

            // Verify WebSocket connection was deleted from DynamoDB
            const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
            const deleteCalls = DeleteCommand.mock.calls;
            const connectionDeleteCall = deleteCalls.find(
              (call) => call[0].TableName === 'TestConnectionsTable' && call[0].Key.connectionId === targetConnectionId
            );
            expect(connectionDeleteCall).toBeDefined();

            // All three disconnection mechanisms must have been invoked
            // (IVS Stage + IVS Chat + WebSocket connection deletion)
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 26: Chat-restricted users cannot send messages
   * **Validates: Requirements 27.3**
   *
   * For any user with chatRestricted=true, message submissions are rejected.
   */
  describe('Property 26: Chat-restricted users cannot send messages', () => {
    it('chat-restricted users have their group messages rejected', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbDisplayName,
          arbMessage,
          arbConnectionId,
          async (eventId, userId, displayName, message, connectionId) => {
            jest.clearAllMocks();
            mockPostToConnection.mockResolvedValue({});
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Mock: GetCommand returns connection with chatRestricted=true
            mockDdbSend.mockResolvedValueOnce({
              Item: {
                connectionId,
                eventId,
                userId,
                role: 'attendee',
                chatRestricted: true,
              },
            });

            const event = buildWebSocketEvent({
              action: 'sendGroupMessage',
              eventId,
              data: { userId, displayName, message },
              connectionId,
            });

            const result = await signalingHandler(event);
            expect(result.statusCode).toBe(200);
            expect(result.body).toBe('Chat restricted');

            // Verify a CHAT_RESTRICTED notification was sent to the user
            const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
            expect(PostToConnectionCommand).toHaveBeenCalledWith({
              ConnectionId: connectionId,
              Data: JSON.stringify({
                type: 'CHAT_RESTRICTED',
                eventId,
                data: {
                  message: 'Your chat participation has been restricted by the presenter',
                },
              }),
            });

            // Verify the message was NOT broadcast to the event
            expect(mockBroadcast).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
