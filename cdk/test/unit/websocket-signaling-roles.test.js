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
}));

// Mock broadcast
const mockBroadcast = jest.fn().mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });
jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: mockBroadcast,
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

describe('WebSocket Signaling Handler — Role Management and Chat Control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('promoteUser', () => {
    it('updates connection role to co-presenter and broadcasts ROLE_CHANGED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'promoteUser',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-attendee-1', userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('User promoted');

      // Verify DynamoDB update on connections table
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-attendee-1' },
        UpdateExpression: 'SET #role = :role',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': 'co-presenter' },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'ROLE_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-attendee-1',
          userId: 'user_xyz',
          newRole: 'co-presenter',
        },
      });
    });

    it('accepts targetConnectionId from top-level body field', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'promoteUser',
        eventId: 'evt_abc123',
        targetConnectionId: 'conn-attendee-2',
        userId: 'user_top',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { connectionId: 'conn-attendee-2' },
        })
      );
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'promoteUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'promoteUser',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-attendee-1', userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('demoteUser', () => {
    it('reverts connection role to attendee, revokes speak permission, and broadcasts ROLE_CHANGED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'demoteUser',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-copresenter-1', userId: 'user_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('User demoted');

      // Verify DynamoDB update sets role to attendee and hasSpeakPermission to false
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-copresenter-1' },
        UpdateExpression: 'SET #role = :role, #hasSpeakPermission = :speak',
        ExpressionAttributeNames: { '#role': 'role', '#hasSpeakPermission': 'hasSpeakPermission' },
        ExpressionAttributeValues: { ':role': 'attendee', ':speak': false },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'ROLE_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-copresenter-1',
          userId: 'user_abc',
          newRole: 'attendee',
        },
      });
    });

    it('accepts targetConnectionId from top-level body field', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'demoteUser',
        eventId: 'evt_abc123',
        targetConnectionId: 'conn-copresenter-2',
        userId: 'user_top',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { connectionId: 'conn-copresenter-2' },
        })
      );
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'demoteUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'demoteUser',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-copresenter-1', userId: 'user_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('grantSpeak', () => {
    it('updates hasSpeakPermission to true and broadcasts SPEAK_PERMISSION_CHANGED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'grantSpeak',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-attendee-1', userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Speak permission granted');

      // Verify DynamoDB update
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-attendee-1' },
        UpdateExpression: 'SET #hasSpeakPermission = :speak',
        ExpressionAttributeNames: { '#hasSpeakPermission': 'hasSpeakPermission' },
        ExpressionAttributeValues: { ':speak': true },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'SPEAK_PERMISSION_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-attendee-1',
          userId: 'user_xyz',
          hasSpeakPermission: true,
        },
      });
    });

    it('accepts targetConnectionId from top-level body field', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'grantSpeak',
        eventId: 'evt_abc123',
        targetConnectionId: 'conn-attendee-3',
        userId: 'user_top',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { connectionId: 'conn-attendee-3' },
        })
      );
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'grantSpeak',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'grantSpeak',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-attendee-1', userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('revokeSpeak', () => {
    it('updates hasSpeakPermission to false and broadcasts SPEAK_PERMISSION_CHANGED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'revokeSpeak',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-attendee-1', userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Speak permission revoked');

      // Verify DynamoDB update
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-attendee-1' },
        UpdateExpression: 'SET #hasSpeakPermission = :speak',
        ExpressionAttributeNames: { '#hasSpeakPermission': 'hasSpeakPermission' },
        ExpressionAttributeValues: { ':speak': false },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'SPEAK_PERMISSION_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-attendee-1',
          userId: 'user_xyz',
          hasSpeakPermission: false,
        },
      });
    });

    it('accepts targetConnectionId from top-level body field', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'revokeSpeak',
        eventId: 'evt_abc123',
        targetConnectionId: 'conn-attendee-4',
        userId: 'user_top',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { connectionId: 'conn-attendee-4' },
        })
      );
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'revokeSpeak',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'revokeSpeak',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-attendee-1', userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('toggleChat', () => {
    it('stores chatEnabled=true on event metadata and broadcasts CHAT_STATE_CHANGED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'toggleChat',
        eventId: 'evt_abc123',
        data: { enabled: true },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Chat enabled');

      // Verify DynamoDB update on main table (event metadata)
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'METADATA' },
        UpdateExpression: 'SET #chatEnabled = :chatEnabled',
        ExpressionAttributeNames: { '#chatEnabled': 'chatEnabled' },
        ExpressionAttributeValues: { ':chatEnabled': true },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'CHAT_STATE_CHANGED',
        eventId: 'evt_abc123',
        data: {
          chatEnabled: true,
        },
      });
    });

    it('stores chatEnabled=false on event metadata and broadcasts CHAT_STATE_CHANGED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'toggleChat',
        eventId: 'evt_abc123',
        data: { enabled: false },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Chat disabled');

      // Verify DynamoDB update
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'METADATA' },
        UpdateExpression: 'SET #chatEnabled = :chatEnabled',
        ExpressionAttributeNames: { '#chatEnabled': 'chatEnabled' },
        ExpressionAttributeValues: { ':chatEnabled': false },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'CHAT_STATE_CHANGED',
        eventId: 'evt_abc123',
        data: {
          chatEnabled: false,
        },
      });
    });

    it('returns 400 when enabled field is missing', async () => {
      const event = buildEvent({
        action: 'toggleChat',
        eventId: 'evt_abc123',
        data: {},
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing or invalid enabled field');
    });

    it('returns 400 when enabled field is not a boolean', async () => {
      const event = buildEvent({
        action: 'toggleChat',
        eventId: 'evt_abc123',
        data: { enabled: 'yes' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing or invalid enabled field');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'toggleChat',
        eventId: 'evt_abc123',
        data: { enabled: true },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });
});
