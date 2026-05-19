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

// Mock IVS Real-Time client
const mockIvsRealTimeSend = jest.fn();
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsRealTimeSend })),
  DisconnectParticipantCommand: jest.fn((params) => ({ type: 'DisconnectParticipant', params })),
}), { virtual: true });

// Mock IVS Chat client
const mockIvsChatSend = jest.fn();
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: mockIvsChatSend })),
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

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler } = require('../../lambda/websocket/signaling');

function buildEvent({ action, eventId, data, userId, targetConnectionId, connectionId = 'conn-presenter', reason, bannedBy }) {
  const body = { action, eventId };
  if (data) body.data = data;
  if (userId) body.userId = userId;
  if (targetConnectionId) body.targetConnectionId = targetConnectionId;
  if (reason) body.reason = reason;
  if (bannedBy) body.bannedBy = bannedBy;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

describe('WebSocket Signaling Handler — Kick and Ban (Abuse Management)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostToConnection.mockResolvedValue({});
    mockIvsRealTimeSend.mockResolvedValue({});
    mockIvsChatSend.mockResolvedValue({});
  });

  describe('kickUser', () => {
    it('disconnects user from IVS Stage, IVS Chat, sends USER_KICKED, deletes connection, and broadcasts', async () => {
      // GetCommand for event metadata
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: 'EVENT#evt_abc123',
          SK: 'METADATA',
          ivsStageArn: 'arn:aws:ivs:us-east-1:123456789:stage/abc',
          ivsChatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/xyz',
        },
      });
      // DeleteCommand for connection
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'kickUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad', targetConnectionId: 'conn-bad-user', reason: 'Disruptive behavior' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('User kicked');

      // Verify IVS Stage disconnect
      const { DisconnectParticipantCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(DisconnectParticipantCommand).toHaveBeenCalledWith({
        stageArn: 'arn:aws:ivs:us-east-1:123456789:stage/abc',
        participantId: 'user_bad',
        reason: 'Disruptive behavior',
      });
      expect(mockIvsRealTimeSend).toHaveBeenCalled();

      // Verify IVS Chat disconnect
      const { DisconnectUserCommand } = require('@aws-sdk/client-ivschat');
      expect(DisconnectUserCommand).toHaveBeenCalledWith({
        roomIdentifier: 'arn:aws:ivschat:us-east-1:123456789:room/xyz',
        userId: 'user_bad',
        reason: 'Disruptive behavior',
      });
      expect(mockIvsChatSend).toHaveBeenCalled();

      // Verify USER_KICKED message sent to target connection
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-bad-user',
        Data: JSON.stringify({
          type: 'USER_KICKED',
          eventId: 'evt_abc123',
          data: { userId: 'user_bad', reason: 'Disruptive behavior' },
        }),
      });

      // Verify connection deleted from DDB
      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(DeleteCommand).toHaveBeenCalledWith({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-bad-user' },
      });

      // Verify broadcast to remaining participants
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'USER_KICKED',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad', reason: 'Disruptive behavior' },
      });
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'kickUser',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-bad-user' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId');
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'kickUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId');
    });

    it('continues kick flow even if IVS Stage disconnect fails', async () => {
      mockIvsRealTimeSend.mockRejectedValueOnce(new Error('IVS Stage error'));
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: 'EVENT#evt_abc123',
          SK: 'METADATA',
          ivsStageArn: 'arn:aws:ivs:us-east-1:123456789:stage/abc',
          ivsChatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/xyz',
        },
      });
      mockSend.mockResolvedValueOnce({}); // DeleteCommand

      const event = buildEvent({
        action: 'kickUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad', targetConnectionId: 'conn-bad-user' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('User kicked');
    });

    it('uses default reason when none provided', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA' },
      });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'kickUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad', targetConnectionId: 'conn-bad-user' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', expect.objectContaining({
        data: expect.objectContaining({ reason: 'Kicked by presenter' }),
      }));
    });
  });

  describe('banUser', () => {
    it('executes kick flow and writes BAN item to DynamoDB', async () => {
      // GetCommand for event metadata (kick flow)
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: 'EVENT#evt_abc123',
          SK: 'METADATA',
          ivsStageArn: 'arn:aws:ivs:us-east-1:123456789:stage/abc',
          ivsChatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/xyz',
        },
      });
      // DeleteCommand for connection (kick flow)
      mockSend.mockResolvedValueOnce({});
      // PutCommand for BAN item
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'banUser',
        eventId: 'evt_abc123',
        data: {
          userId: 'user_bad',
          targetConnectionId: 'conn-bad-user',
          reason: 'Repeated abuse',
          bannedBy: 'user_presenter',
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('User banned');

      // Verify BAN item written to DynamoDB
      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      expect(PutCommand).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'TestTable',
        Item: expect.objectContaining({
          PK: 'EVENT#evt_abc123',
          SK: 'BAN#user_bad',
          eventId: 'evt_abc123',
          userId: 'user_bad',
          bannedBy: 'user_presenter',
          reason: 'Repeated abuse',
          type: 'BAN',
        }),
      }));

      // Verify broadcast USER_BANNED
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'USER_BANNED',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad', reason: 'Repeated abuse' },
      });
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'banUser',
        eventId: 'evt_abc123',
        data: { targetConnectionId: 'conn-bad-user' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId');
    });

    it('returns 400 when targetConnectionId is missing', async () => {
      const event = buildEvent({
        action: 'banUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing targetConnectionId');
    });

    it('returns 500 when DynamoDB PutCommand fails for ban item', async () => {
      // GetCommand for event metadata
      mockSend.mockResolvedValueOnce({ Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA' } });
      // DeleteCommand for connection
      mockSend.mockResolvedValueOnce({});
      // PutCommand fails
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'banUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad', targetConnectionId: 'conn-bad-user', reason: 'Abuse' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('unbanUser', () => {
    it('deletes BAN item from DynamoDB', async () => {
      mockSend.mockResolvedValueOnce({}); // DeleteCommand

      const event = buildEvent({
        action: 'unbanUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('User unbanned');

      // Verify DeleteCommand called with correct key
      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(DeleteCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'BAN#user_bad' },
      });
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'unbanUser',
        eventId: 'evt_abc123',
        data: {},
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId');
    });

    it('accepts userId from top-level body field', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'unbanUser',
        eventId: 'evt_abc123',
        userId: 'user_top_level',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(DeleteCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'BAN#user_top_level' },
      });
    });

    it('returns 500 when DynamoDB delete fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'unbanUser',
        eventId: 'evt_abc123',
        data: { userId: 'user_bad' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('listBans', () => {
    it('queries all BAN items and sends list to requester', async () => {
      // QueryCommand returns ban items
      mockSend.mockResolvedValueOnce({
        Items: [
          { PK: 'EVENT#evt_abc123', SK: 'BAN#user_1', userId: 'user_1', bannedBy: 'presenter', reason: 'Spam', timestamp: '2024-01-15T10:00:00Z' },
          { PK: 'EVENT#evt_abc123', SK: 'BAN#user_2', userId: 'user_2', bannedBy: 'presenter', reason: 'Abuse', timestamp: '2024-01-15T11:00:00Z' },
        ],
        LastEvaluatedKey: undefined,
      });

      const event = buildEvent({
        action: 'listBans',
        eventId: 'evt_abc123',
        connectionId: 'conn-presenter',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Ban list sent');

      // Verify query with correct prefix
      const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
      expect(QueryCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': 'EVENT#evt_abc123',
          ':skPrefix': 'BAN#',
        },
      });

      // Verify message sent to requester
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-presenter',
        Data: JSON.stringify({
          type: 'BAN_LIST',
          eventId: 'evt_abc123',
          data: {
            bans: [
              { userId: 'user_1', bannedBy: 'presenter', reason: 'Spam', timestamp: '2024-01-15T10:00:00Z' },
              { userId: 'user_2', bannedBy: 'presenter', reason: 'Abuse', timestamp: '2024-01-15T11:00:00Z' },
            ],
          },
        }),
      });
    });

    it('returns empty ban list when no bans exist', async () => {
      mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

      const event = buildEvent({
        action: 'listBans',
        eventId: 'evt_abc123',
        connectionId: 'conn-presenter',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-presenter',
        Data: JSON.stringify({
          type: 'BAN_LIST',
          eventId: 'evt_abc123',
          data: { bans: [] },
        }),
      });
    });

    it('handles paginated results', async () => {
      // First page
      mockSend.mockResolvedValueOnce({
        Items: [
          { PK: 'EVENT#evt_abc123', SK: 'BAN#user_1', userId: 'user_1', bannedBy: 'p', reason: 'r1', timestamp: 't1' },
        ],
        LastEvaluatedKey: { PK: 'EVENT#evt_abc123', SK: 'BAN#user_1' },
      });
      // Second page
      mockSend.mockResolvedValueOnce({
        Items: [
          { PK: 'EVENT#evt_abc123', SK: 'BAN#user_2', userId: 'user_2', bannedBy: 'p', reason: 'r2', timestamp: 't2' },
        ],
        LastEvaluatedKey: undefined,
      });

      const event = buildEvent({
        action: 'listBans',
        eventId: 'evt_abc123',
        connectionId: 'conn-presenter',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-presenter',
        Data: JSON.stringify({
          type: 'BAN_LIST',
          eventId: 'evt_abc123',
          data: {
            bans: [
              { userId: 'user_1', bannedBy: 'p', reason: 'r1', timestamp: 't1' },
              { userId: 'user_2', bannedBy: 'p', reason: 'r2', timestamp: 't2' },
            ],
          },
        }),
      });
    });

    it('returns 500 when DynamoDB query fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'listBans',
        eventId: 'evt_abc123',
        connectionId: 'conn-presenter',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });
});
