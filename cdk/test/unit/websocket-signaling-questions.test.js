'use strict';

// Mock crypto
const mockUUID = 'q_test-uuid-1234-5678-abcdef';
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => mockUUID),
}));

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

// Mock broadcast
const mockBroadcast = jest.fn().mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });
jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: mockBroadcast,
  getConnectionsForEvent: jest.fn(),
}));

// Mock API Gateway Management API
const mockApiSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
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

function buildEvent({ action, eventId, data, userId, questionId, timestamp, text, connectionId = 'conn-123' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  if (userId) body.userId = userId;
  if (questionId) body.questionId = questionId;
  if (timestamp) body.timestamp = timestamp;
  if (text) body.text = text;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

// Issue #70: prepend a presenter Item to satisfy dispatcher authz on
// presenter-only actions (dismissQuestion, pinQuestion, unpinQuestion).
function presenterAuth() {
  mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123', role: 'presenter', eventId: 'evt_abc123' } });
}

describe('WebSocket Signaling Handler — Question Queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('submitQuestion', () => {
    it('stores question item in DynamoDB and broadcasts QUESTION_SUBMITTED', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-123' },
      });
      mockSend.mockResolvedValueOnce({}); // PutCommand

      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane', text: 'What is serverless?' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Question submitted');

      // Verify DynamoDB put
      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      expect(PutCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'TestTable',
          Item: expect.objectContaining({
            PK: 'EVENT#evt_abc123',
            eventId: 'evt_abc123',
            questionId: mockUUID,
            userId: 'user_xyz',
            displayName: 'Jane',
            text: 'What is serverless?',
            status: 'queued',
            type: 'QUESTION',
          }),
        })
      );

      // Verify SK format: QUESTION#{timestamp}#{questionId}
      const putCall = PutCommand.mock.calls[0][0];
      expect(putCall.Item.SK).toMatch(/^QUESTION#\d{4}-\d{2}-\d{2}T.*#q_test-uuid-1234-5678-abcdef$/);
      expect(putCall.Item.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'QUESTION_SUBMITTED',
        eventId: 'evt_abc123',
        data: expect.objectContaining({
          questionId: mockUUID,
          userId: 'user_xyz',
          displayName: 'Jane',
          text: 'What is serverless?',
          status: 'queued',
          submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      });
    });

    it('accepts userId and text from top-level body fields', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-123' },
      });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        userId: 'user_top',
        text: 'How does Lambda scale?',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      const putCall = PutCommand.mock.calls[0][0];
      expect(putCall.Item.userId).toBe('user_top');
      expect(putCall.Item.text).toBe('How does Lambda scale?');
    });

    it('returns 400 when userId is missing', async () => {
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { text: 'Some question' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing userId');
    });

    it('returns 400 when question text is missing', async () => {
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'Jane' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing question text');
    });

    it('generates a unique questionId using crypto.randomUUID', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-123' },
      });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', text: 'A question' },
      });

      await handler(event);

      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      const putCall = PutCommand.mock.calls[0][0];
      expect(putCall.Item.questionId).toBe(mockUUID);
    });

    it('returns 500 when DynamoDB put fails', async () => {
      // Mock GetCommand for connection record — no restrictions
      mockSend.mockResolvedValueOnce({
        Item: { connectionId: 'conn-123' },
      });
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', text: 'A question' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('answerQuestion', () => {
    it('updates question status to answered and broadcasts QUESTION_ANSWERED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'answerQuestion',
        eventId: 'evt_abc123',
        data: { questionId: 'q_123', timestamp: '2024-01-15T10:30:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Question answered');

      // Verify DynamoDB update
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: {
          PK: 'EVENT#evt_abc123',
          SK: 'QUESTION#2024-01-15T10:30:00Z#q_123',
        },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'answered' },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'QUESTION_ANSWERED',
        eventId: 'evt_abc123',
        data: {
          questionId: 'q_123',
          timestamp: '2024-01-15T10:30:00Z',
          answer: '',
        },
      });
    });

    it('accepts questionId and timestamp from top-level body fields', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'answerQuestion',
        eventId: 'evt_abc123',
        questionId: 'q_top',
        timestamp: '2024-01-15T11:00:00Z',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: {
          PK: 'EVENT#evt_abc123',
          SK: 'QUESTION#2024-01-15T11:00:00Z#q_top',
        },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'answered' },
      });
    });

    it('returns 400 when questionId is missing', async () => {
      const event = buildEvent({
        action: 'answerQuestion',
        eventId: 'evt_abc123',
        data: { timestamp: '2024-01-15T10:30:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing questionId or timestamp');
    });

    it('returns 400 when timestamp is missing', async () => {
      const event = buildEvent({
        action: 'answerQuestion',
        eventId: 'evt_abc123',
        data: { questionId: 'q_123' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing questionId or timestamp');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'answerQuestion',
        eventId: 'evt_abc123',
        data: { questionId: 'q_123', timestamp: '2024-01-15T10:30:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });

  describe('dismissQuestion', () => {
    beforeEach(() => {
      presenterAuth();
    });

    it('updates question status to dismissed and broadcasts QUESTION_DISMISSED', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand

      const event = buildEvent({
        action: 'dismissQuestion',
        eventId: 'evt_abc123',
        data: { questionId: 'q_456', timestamp: '2024-01-15T10:35:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Question dismissed');

      // Verify DynamoDB update
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: {
          PK: 'EVENT#evt_abc123',
          SK: 'QUESTION#2024-01-15T10:35:00Z#q_456',
        },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'dismissed' },
      });

      // Verify broadcast
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'QUESTION_DISMISSED',
        eventId: 'evt_abc123',
        data: {
          questionId: 'q_456',
          timestamp: '2024-01-15T10:35:00Z',
        },
      });
    });

    it('accepts questionId and timestamp from top-level body fields', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'dismissQuestion',
        eventId: 'evt_abc123',
        questionId: 'q_top',
        timestamp: '2024-01-15T12:00:00Z',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledWith({
        TableName: 'TestTable',
        Key: {
          PK: 'EVENT#evt_abc123',
          SK: 'QUESTION#2024-01-15T12:00:00Z#q_top',
        },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'dismissed' },
      });
    });

    it('returns 400 when questionId is missing', async () => {
      const event = buildEvent({
        action: 'dismissQuestion',
        eventId: 'evt_abc123',
        data: { timestamp: '2024-01-15T10:35:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing questionId or timestamp');
    });

    it('returns 400 when timestamp is missing', async () => {
      const event = buildEvent({
        action: 'dismissQuestion',
        eventId: 'evt_abc123',
        data: { questionId: 'q_456' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe('Missing questionId or timestamp');
    });

    it('returns 500 when DynamoDB update fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        action: 'dismissQuestion',
        eventId: 'evt_abc123',
        data: { questionId: 'q_456', timestamp: '2024-01-15T10:35:00Z' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(result.body).toBe('Internal server error');
    });
  });
});
