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
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
  // GetCommand needed for the issue #70 dispatcher authz check on
  // lowerAllHands / acknowledgeHand / dismissHand.
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
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

function buildEvent({ action, eventId, data, userId, timestamp, connectionId = 'conn-123' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  if (userId) body.userId = userId;
  if (timestamp) body.timestamp = timestamp;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

// Issue #70: prepend a presenter Item to satisfy the dispatcher's authz
// check on presenter-only actions (lowerAllHands, acknowledgeHand,
// dismissHand). Tests for non-presenter actions don't call this.
function presenterAuth() {
  mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123', role: 'presenter' } });
}

describe('WebSocket Signaling Handler — Hand Raising', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('General routing', () => {
    it('returns 400 for invalid JSON body', async () => {
      const event = {
        requestContext: { connectionId: 'conn-123' },
        body: 'not-json{{{',
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Invalid JSON');
    });

    it('returns 400 when eventId is missing', async () => {
      const event = {
        requestContext: { connectionId: 'conn-123' },
        body: JSON.stringify({ action: 'raiseHand' }),
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing eventId');
    });

    it('returns 400 for unknown action', async () => {
      const event = buildEvent({ action: 'unknownAction', eventId: 'evt_abc123' });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('Unknown action');
    });
  });

  describe('raiseHand', () => {
    it('stores hand item in DynamoDB and broadcasts HAND_RAISED', async () => {
      mockSend.mockResolvedValueOnce({}); // PutCommand

      const event = buildEvent({
        action: 'raiseHand',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Hand raised');

      // Verify DynamoDB put
      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      expect(PutCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'TestTable',
          Item: expect.objectContaining({
            PK: 'EVENT#evt_abc123',
            eventId: 'evt_abc123',
            userId: 'user_xyz',
            displayName: 'Jane',
            type: 'HAND',
          }),
        })
      );

      // Verify SK format: HAND#{timestamp}#{userId}
      const putCall = PutCommand.mock.calls[0][0];
      expect(putCall.Item.SK).toMatch(/^HAND#\d{4}-\d{2}-\d{2}T.*#user_xyz$/);

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'HAND_RAISED',
        eventId: 'evt_abc123',
        data: expect.objectContaining({
          userId: 'user_xyz',
          displayName: 'Jane',
        }),
      });
    });

    it('accepts userId from top-level body field', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'raiseHand',
        eventId: 'evt_abc123',
        userId: 'user_top',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      const putCall = PutCommand.mock.calls[0][0];
      expect(putCall.Item.userId).toBe('user_top');
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'raiseHand',
        eventId: 'evt_abc123',
        data: { displayName: 'Jane' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId');
    });

    it('includes timestamp in broadcast data', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'raiseHand',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane' },
      });

      await handler(event);

      expect(mockBroadcast).toHaveBeenCalledWith(
        'evt_abc123',
        expect.objectContaining({
          data: expect.objectContaining({
            timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          }),
        })
      );
    });

    it('returns 500 when DynamoDB put fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'raiseHand',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('lowerHand', () => {
    it('deletes hand item from DynamoDB and broadcasts HAND_LOWERED', async () => {
      mockSend.mockResolvedValueOnce({}); // DeleteCommand

      const event = buildEvent({
        action: 'lowerHand',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', timestamp: '2024-01-15T10:30:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Hand lowered');

      // Verify DynamoDB delete
      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(DeleteCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: {
          PK: 'EVENT#evt_abc123',
          SK: 'HAND#2024-01-15T10:30:00Z#user_xyz',
        },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'HAND_LOWERED',
        eventId: 'evt_abc123',
        data: {
          userId: 'user_xyz',
          timestamp: '2024-01-15T10:30:00Z',
        },
      });
    });

    it('accepts userId and timestamp from top-level body fields', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'lowerHand',
        eventId: 'evt_abc123',
        userId: 'user_top',
        timestamp: '2024-01-15T11:00:00Z',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(DeleteCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: {
          PK: 'EVENT#evt_abc123',
          SK: 'HAND#2024-01-15T11:00:00Z#user_top',
        },
      });
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'lowerHand',
        eventId: 'evt_abc123',
        data: { timestamp: '2024-01-15T10:30:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId or timestamp');
    });

    it('returns 400 when timestamp is missing', async () => {
      const event = buildEvent({
        action: 'lowerHand',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId or timestamp');
    });

    it('returns 500 when DynamoDB delete fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'lowerHand',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', timestamp: '2024-01-15T10:30:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('lowerAllHands', () => {
    beforeEach(() => {
      // lowerAllHands is in PRESENTER_ONLY_ACTIONS (issue #70). Each test
      // here needs the dispatcher's authz GET satisfied first.
      presenterAuth();
    });

    it('queries all HAND# items, batch deletes them, and broadcasts HANDS_CLEARED', async () => {
      // Mock query returning 2 hand items
      mockSend.mockResolvedValueOnce({
        Items: [
          { PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:30:00Z#user_1' },
          { PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:31:00Z#user_2' },
        ],
      });
      // Mock batch delete
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'lowerAllHands',
        eventId: 'evt_abc123',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('All hands lowered');

      // Verify query with begins_with
      const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
      expect(QueryCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'TestTable',
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': 'EVENT#evt_abc123',
            ':skPrefix': 'HAND#',
          },
        })
      );

      // Verify batch delete
      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).toHaveBeenCalledWith({
        RequestItems: {
          TestTable: [
            { DeleteRequest: { Key: { PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:30:00Z#user_1' } } },
            { DeleteRequest: { Key: { PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:31:00Z#user_2' } } },
          ],
        },
      });

      // Verify broadcast with count
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'HANDS_CLEARED',
        eventId: 'evt_abc123',
        data: { count: 2 },
      });
    });

    it('handles empty hands list without batch delete', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const event = buildEvent({
        action: 'lowerAllHands',
        eventId: 'evt_abc123',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // BatchWriteCommand should NOT be called
      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).not.toHaveBeenCalled();

      // Broadcast should still be called with count 0
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'HANDS_CLEARED',
        eventId: 'evt_abc123',
        data: { count: 0 },
      });
    });

    it('paginates through query results', async () => {
      // First page
      mockSend.mockResolvedValueOnce({
        Items: [{ PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:30:00Z#user_1' }],
        LastEvaluatedKey: { PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:30:00Z#user_1' },
      });
      // Second page
      mockSend.mockResolvedValueOnce({
        Items: [{ PK: 'EVENT#evt_abc123', SK: 'HAND#2024-01-15T10:31:00Z#user_2' }],
      });
      // Batch delete
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'lowerAllHands',
        eventId: 'evt_abc123',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Should have queried twice
      const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
      expect(QueryCommand).toHaveBeenCalledTimes(2);

      // Broadcast count should be 2 (from both pages)
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'HANDS_CLEARED',
        eventId: 'evt_abc123',
        data: { count: 2 },
      });
    });

    it('chunks batch deletes for more than 25 items', async () => {
      // Generate 30 hand items
      const items = Array.from({ length: 30 }, (_, i) => ({
        PK: 'EVENT#evt_abc123',
        SK: `HAND#2024-01-15T10:${String(i).padStart(2, '0')}:00Z#user_${i}`,
      }));

      mockSend.mockResolvedValueOnce({ Items: items });
      // Two batch deletes (25 + 5)
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'lowerAllHands',
        eventId: 'evt_abc123',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Should have 2 batch write calls
      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).toHaveBeenCalledTimes(2);

      // First batch should have 25 items
      const firstBatch = BatchWriteCommand.mock.calls[0][0];
      expect(firstBatch.RequestItems.TestTable).toHaveLength(25);

      // Second batch should have 5 items
      const secondBatch = BatchWriteCommand.mock.calls[1][0];
      expect(secondBatch.RequestItems.TestTable).toHaveLength(5);

      // Broadcast count should be 30
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'HANDS_CLEARED',
        eventId: 'evt_abc123',
        data: { count: 30 },
      });
    });

    it('returns 500 when query fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'lowerAllHands',
        eventId: 'evt_abc123',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });
});
