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

function buildEvent({ action, eventId, data, userId, message, displayName, connectionId = 'conn-sender' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  if (userId) body.userId = userId;
  if (message) body.message = message;
  if (displayName) body.displayName = displayName;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

describe('WebSocket Signaling Handler — Chat Messaging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiSend.mockResolvedValue({});
  });

  describe('sendGroupMessage', () => {
    it('broadcasts message to all participants when chat is enabled', async () => {
      // Mock GetCommand for connection record — no restrictions
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
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello everyone!' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Message sent');

      // Verify metadata fetch
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      expect(GetCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: { PK: 'EVENT#evt_abc123', SK: 'METADATA' },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'GROUP_MESSAGE',
        eventId: 'evt_abc123',
        data: expect.objectContaining({
          userId: 'user_xyz',
          displayName: 'Jane',
          message: 'Hello everyone!',
        }),
      });
    });

    it('includes timestamp in broadcast message for chronological ordering', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender' },
      });
      mockSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA', chatEnabled: true },
      });

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Test message' },
      });

      await handler(event);

      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123',
        expect.objectContaining({
          data: expect.objectContaining({
            timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          }),
        })
      );
    });

    it('rejects message with CHAT_DISABLED notification when chat is disabled', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender' },
      });
      // Mock GetCommand for event metadata — chatEnabled: false
      mockSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA', chatEnabled: false },
      });

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello!' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Chat disabled');

      // Verify CHAT_DISABLED notification sent to sender
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-sender',
        Data: expect.any(String),
      });

      // Verify the notification payload
      const sentData = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentData.type).toBe('CHAT_DISABLED');
      expect(sentData.eventId).toBe('evt_abc123');

      // Verify broadcast was NOT called
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('defaults chatEnabled to true when metadata has no chatEnabled field', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender' },
      });
      // Mock GetCommand — metadata without chatEnabled field
      mockSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA', title: 'My Event' },
      });

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello!' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Message sent');

      // Broadcast should be called (chat defaults to enabled)
      expect(mockBroadcast).toHaveBeenCalled();
    });

    it('accepts userId and message from top-level body fields', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-sender' },
      });
      mockSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc123', SK: 'METADATA', chatEnabled: true },
      });

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        userId: 'user_top',
        message: 'Top-level message',
        displayName: 'TopUser',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123',
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user_top',
            message: 'Top-level message',
            displayName: 'TopUser',
          }),
        })
      );
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { message: 'Hello!' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId');
    });

    it('returns 400 when message is missing', async () => {
      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing message');
    });

    it('returns 500 when DynamoDB get fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'sendGroupMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', message: 'Hello!' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('sendDirectMessage', () => {
    it('routes message only to presenter connections and confirms delivery', async () => {
      // Mock getConnectionsForEvent returning multiple connections
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
        { connectionId: 'conn-attendee-1', role: 'attendee', eventId: 'evt_abc123' },
        { connectionId: 'conn-attendee-2', role: 'attendee', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Private question' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Direct message sent');

      // Verify getConnectionsForEvent was called
      expect(mockGetConnectionsForEvent).toHaveBeenCalledWith('evt_abc123');

      // Verify PostToConnectionCommand was called for presenter + sender confirmation = 2 calls
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(2);

      // First call: message to presenter
      const presenterMsg = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(presenterMsg.type).toBe('DIRECT_MESSAGE');
      expect(presenterMsg.data.userId).toBe('user_xyz');
      expect(presenterMsg.data.displayName).toBe('Jane');
      expect(presenterMsg.data.message).toBe('Private question');
      expect(PostToConnectionCommand.mock.calls[0][0].ConnectionId).toBe('conn-presenter-1');

      // Second call: delivery confirmation to sender
      const confirmMsg = JSON.parse(PostToConnectionCommand.mock.calls[1][0].Data);
      expect(confirmMsg.type).toBe('DIRECT_MESSAGE_CONFIRMED');
      expect(confirmMsg.eventId).toBe('evt_abc123');
      expect(PostToConnectionCommand.mock.calls[1][0].ConnectionId).toBe('conn-sender');
    });

    it('includes timestamp in direct message for chronological ordering', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello presenter' },
        connectionId: 'conn-sender',
      });

      await handler(event);

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      const presenterMsg = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(presenterMsg.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const confirmMsg = JSON.parse(PostToConnectionCommand.mock.calls[1][0].Data);
      expect(confirmMsg.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('sends to multiple presenter connections', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
        { connectionId: 'conn-presenter-2', role: 'presenter', eventId: 'evt_abc123' },
        { connectionId: 'conn-attendee-1', role: 'attendee', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // 2 presenter messages + 1 confirmation = 3 calls
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(3);

      // Verify both presenters received the message
      expect(PostToConnectionCommand.mock.calls[0][0].ConnectionId).toBe('conn-presenter-1');
      expect(PostToConnectionCommand.mock.calls[1][0].ConnectionId).toBe('conn-presenter-2');
      // Confirmation to sender
      expect(PostToConnectionCommand.mock.calls[2][0].ConnectionId).toBe('conn-sender');
    });

    it('does not send message to attendee connections', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
        { connectionId: 'conn-attendee-1', role: 'attendee', eventId: 'evt_abc123' },
        { connectionId: 'conn-attendee-2', role: 'attendee', eventId: 'evt_abc123' },
        { connectionId: 'conn-copresenter-1', role: 'co-presenter', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Secret' },
        connectionId: 'conn-sender',
      });

      await handler(event);

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      // Only presenter + sender confirmation = 2 calls
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(2);

      const connectionIds = PostToConnectionCommand.mock.calls.map(c => c[0].ConnectionId);
      expect(connectionIds).not.toContain('conn-attendee-1');
      expect(connectionIds).not.toContain('conn-attendee-2');
      expect(connectionIds).not.toContain('conn-copresenter-1');
    });

    it('still sends confirmation even when no presenter connections found', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-attendee-1', role: 'attendee', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello?' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Only confirmation to sender
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      expect(PostToConnectionCommand.mock.calls[0][0].ConnectionId).toBe('conn-sender');
    });

    it('accepts userId and message from top-level body fields', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        userId: 'user_top',
        message: 'Top-level DM',
        displayName: 'TopUser',
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      const presenterMsg = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(presenterMsg.data.userId).toBe('user_top');
      expect(presenterMsg.data.message).toBe('Top-level DM');
      expect(presenterMsg.data.displayName).toBe('TopUser');
    });

    it('sends message successfully when userId is not provided (uses connectionId as fallback)', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
      ]);

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { message: 'Hello!' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Direct message sent');
    });

    it('returns 400 when message is missing', async () => {
      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing message');
    });

    it('returns 500 when getConnectionsForEvent fails', async () => {
      mockGetConnectionsForEvent.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', message: 'Hello!' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });

    it('continues sending to other presenters if one fails', async () => {
      mockGetConnectionsForEvent.mockResolvedValueOnce([
        { connectionId: 'conn-presenter-1', role: 'presenter', eventId: 'evt_abc123' },
        { connectionId: 'conn-presenter-2', role: 'presenter', eventId: 'evt_abc123' },
      ]);

      // First presenter send fails, second succeeds, confirmation succeeds
      mockApiSend
        .mockRejectedValueOnce(new Error('Gone'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'sendDirectMessage',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', message: 'Hello' },
        connectionId: 'conn-sender',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Should still attempt to send to second presenter and confirmation
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(3);
    });
  });
});
