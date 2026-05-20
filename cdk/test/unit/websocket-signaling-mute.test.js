'use strict';

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
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

// Mock API Gateway Management API
const mockApiSend = jest.fn();
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

// Mock IVS Real-Time
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
  DisconnectParticipantCommand: jest.fn((params) => ({ type: 'DisconnectParticipant', params })),
}));

// Mock IVS Chat
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: jest.fn() })),
  DisconnectUserCommand: jest.fn((params) => ({ type: 'DisconnectUser', params })),
}));

// Mock broadcast
const mockBroadcast = jest.fn().mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });
const mockGetConnectionsForEvent = jest.fn();
jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: mockBroadcast,
  getConnectionsForEvent: mockGetConnectionsForEvent,
}));

// Mock rate limiter — always allow in tests
jest.mock('../../lambda/websocket/rate-limiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }),
  RATE_LIMIT: 60,
  RATE_WINDOW_SECONDS: 60,
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler } = require('../../lambda/websocket/signaling');

function buildEvent({ action, eventId, data, userId, targetConnectionId, connectionId = 'conn-presenter' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  if (userId) body.userId = userId;
  if (targetConnectionId) body.targetConnectionId = targetConnectionId;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

// Issue #70: prepend a presenter Item to satisfy dispatcher authz on
// presenter-only actions (restrictChat, restrictQuestions, globalMute*).
function presenterAuth() {
  mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-presenter', role: 'presenter', eventId: 'evt_abc123' } });
}

describe('WebSocket Signaling Handler — Mute and Participation Controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiSend.mockResolvedValue({});
  });

  describe('muteAudio', () => {
    it('updates connection record with audioMuted flag and notifies the user', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'muteAudio',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target', userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Audio muted');

      // Verify UpdateCommand was called with correct params
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-target' },
        UpdateExpression: 'SET #audioMuted = :val',
        ExpressionAttributeNames: { '#audioMuted': 'audioMuted' },
        ExpressionAttributeValues: { ':val': true },
      });

      // Verify notification sent to target
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      expect(PostToConnectionCommand.mock.calls[0][0].ConnectionId).toBe('conn-target');
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('AUDIO_MUTED');
      expect(sentData.eventId).toBe('evt_abc123');
      expect(sentData.data.userId).toBe('user_target');
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'muteAudio',
        eventId: 'evt_abc123',
        data: { userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId or userId');
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'muteAudio',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId or userId');
    });

    it('accepts targetConnectionId and userId from top-level body fields', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'muteAudio',
        eventId: 'evt_abc123',
        targetConnectionId: 'conn-target',
        userId: 'user_target',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Audio muted');
    });
  });

  describe('muteVideo', () => {
    it('updates connection record with videoDisabled flag and notifies the user', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'muteVideo',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target', userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Video disabled');

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-target' },
        UpdateExpression: 'SET #videoDisabled = :val',
        ExpressionAttributeNames: { '#videoDisabled': 'videoDisabled' },
        ExpressionAttributeValues: { ':val': true },
      });

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('VIDEO_DISABLED');
      expect(sentData.data.userId).toBe('user_target');
    });

    it('returns 400 when targetConnectionId or userId is missing', async () => {
      const event = buildEvent({
        action: 'muteVideo',
        eventId: 'evt_abc123',
        data: { userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId or userId');
    });
  });

  describe('restrictChat', () => {
    beforeEach(presenterAuth);
    it('updates connection record with chatRestricted flag and notifies the user', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'restrictChat',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target', userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Chat restricted');

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-target' },
        UpdateExpression: 'SET #chatRestricted = :val',
        ExpressionAttributeNames: { '#chatRestricted': 'chatRestricted' },
        ExpressionAttributeValues: { ':val': true },
      });

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('CHAT_RESTRICTED');
      expect(sentData.data.message).toContain('restricted');
    });

    it('returns 400 when targetConnectionId or userId is missing', async () => {
      const event = buildEvent({
        action: 'restrictChat',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('restrictQuestions', () => {
    beforeEach(presenterAuth);
    it('updates connection record with questionsRestricted flag and notifies the user', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'restrictQuestions',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target', userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Questions restricted');

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-target' },
        UpdateExpression: 'SET #questionsRestricted = :val',
        ExpressionAttributeNames: { '#questionsRestricted': 'questionsRestricted' },
        ExpressionAttributeValues: { ':val': true },
      });

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('QUESTIONS_RESTRICTED');
    });

    it('returns 400 when targetConnectionId or userId is missing', async () => {
      const event = buildEvent({
        action: 'restrictQuestions',
        eventId: 'evt_abc123',
        data: {},
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('globalMuteAudio', () => {
    beforeEach(presenterAuth);
    it('updates event metadata with globalAudioMute flag and broadcasts to all', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'globalMuteAudio',
        eventId: 'evt_abc123',
        data: { enabled: true },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Global audio mute enabled');

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'METADATA' },
        UpdateExpression: 'SET #globalAudioMute = :val',
        ExpressionAttributeNames: { '#globalAudioMute': 'globalAudioMute' },
        ExpressionAttributeValues: { ':val': true },
      });

      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'GLOBAL_AUDIO_MUTE',
        eventId: 'evt_abc123',
        data: { globalAudioMute: true },
      });
    });

    it('disables global audio mute when enabled is false', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'globalMuteAudio',
        eventId: 'evt_abc123',
        data: { enabled: false },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Global audio mute disabled');

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith(expect.objectContaining({
        ExpressionAttributeValues: { ':val': false },
      }));

      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'GLOBAL_AUDIO_MUTE',
        eventId: 'evt_abc123',
        data: { globalAudioMute: false },
      });
    });

    it('returns 400 when enabled field is missing', async () => {
      const event = buildEvent({
        action: 'globalMuteAudio',
        eventId: 'evt_abc123',
        data: {},
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing or invalid enabled field');
    });

    it('returns 400 when enabled field is not a boolean', async () => {
      const event = buildEvent({
        action: 'globalMuteAudio',
        eventId: 'evt_abc123',
        data: { enabled: 'yes' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('globalMuteVideo', () => {
    beforeEach(presenterAuth);
    it('updates event metadata with globalVideoMute flag and broadcasts to all', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'globalMuteVideo',
        eventId: 'evt_abc123',
        data: { enabled: true },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Global video mute enabled');

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'METADATA' },
        UpdateExpression: 'SET #globalVideoMute = :val',
        ExpressionAttributeNames: { '#globalVideoMute': 'globalVideoMute' },
        ExpressionAttributeValues: { ':val': true },
      });

      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'GLOBAL_VIDEO_MUTE',
        eventId: 'evt_abc123',
        data: { globalVideoMute: true },
      });
    });

    it('disables global video mute when enabled is false', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'globalMuteVideo',
        eventId: 'evt_abc123',
        data: { enabled: false },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Global video mute disabled');
    });

    it('returns 400 when enabled field is missing or invalid', async () => {
      const event = buildEvent({
        action: 'globalMuteVideo',
        eventId: 'evt_abc123',
        data: {},
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('Chat restriction enforcement in sendGroupMessage', () => {
    it('rejects message when sender has chatRestricted flag', async () => {
      // Mock GetCommand for connection record — chatRestricted: true
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender', chatRestricted: true },
      });

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello!' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Chat restricted');

      // Verify CHAT_RESTRICTED notification sent to sender
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('CHAT_RESTRICTED');

      // Verify broadcast was NOT called
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('allows message when sender does not have chatRestricted flag', async () => {
      // Mock GetCommand for connection record — no chatRestricted
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender' },
      });
      // Mock GetCommand for event metadata — chatEnabled: true
      mockSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA', chatEnabled: true },
      });

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello!' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Message sent');
      expect(mockBroadcast).toHaveBeenCalled();
    });
  });

  describe('Question restriction enforcement in submitQuestion', () => {
    it('rejects question when sender has questionsRestricted flag', async () => {
      // Mock GetCommand for connection record — questionsRestricted: true
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender', questionsRestricted: true },
      });

      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', text: 'What is AWS?' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Questions restricted');

      // Verify QUESTIONS_RESTRICTED notification sent to sender
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('QUESTIONS_RESTRICTED');

      // Verify broadcast was NOT called (question not submitted)
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('allows question when sender does not have questionsRestricted flag', async () => {
      // Mock GetCommand for connection record — no questionsRestricted
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender' },
      });
      // Mock PutCommand for question storage
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', text: 'What is AWS?' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Question submitted');
      expect(mockBroadcast).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('returns 500 when DynamoDB update fails for muteAudio', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'muteAudio',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-target', userId: 'user_target' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });

    it('returns 500 when DynamoDB update fails for globalMuteAudio', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'globalMuteAudio',
        eventId: 'evt_abc123',
        data: { enabled: true },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });
});
