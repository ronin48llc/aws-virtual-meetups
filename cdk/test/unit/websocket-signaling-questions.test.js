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

// Issue #4: signaling.js calls checkConnectionAuth at the top of every
// request. In unit tests we always want it to allow through; specific
// expiry/reject paths are covered in websocket-signaling-tokenexp.test.js.
jest.mock('../../lambda/websocket/auth-check', () => ({
  checkConnectionAuth: jest.fn().mockResolvedValue({ allowed: true, connection: null }),
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
  mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123', role: 'presenter' } });
}

describe('WebSocket Signaling Handler — Question Queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('centralized displayName length check (issue #60)', () => {
    it('rejects any handler when displayName exceeds 100 chars, before handler logic runs', async () => {
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'x'.repeat(101), text: 'Short Q' },
      });
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatch(/displayName/);
      // No DDB call should have been issued — the dispatcher rejects first.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('accepts displayName exactly at 100 chars', async () => {
      mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123' } });
      mockSend.mockResolvedValueOnce({});
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', displayName: 'x'.repeat(100), text: 'Short Q' },
      });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });

    it('skips the check when displayName is absent', async () => {
      mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123' } });
      mockSend.mockResolvedValueOnce({});
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', text: 'Short Q' },
      });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
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

    it('returns 400 when question text exceeds the 1000-char cap (issue #48)', async () => {
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', text: 'x'.repeat(1001) },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatch(/1-1000 characters/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns 400 when question text is whitespace-only (issue #48)', async () => {
      const event = buildEvent({
        action: 'submitQuestion',
        eventId: 'evt_abc123',
        data: { userId: 'user_xyz', text: '    ' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
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

    it('returns 400 when answer exceeds the 2000-char cap (issue #48)', async () => {
      const event = buildEvent({
        action: 'answerQuestion',
        eventId: 'evt_abc123',
        data: {
          questionId: 'q_123',
          timestamp: '2024-01-15T10:30:00Z',
          answer: 'x'.repeat(2001),
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatch(/2000 characters/);
      expect(mockSend).not.toHaveBeenCalled();
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

  describe('getQuestionQueue pagination (issue #66)', () => {
    it('paginates QUESTION# queries and accumulates across pages before sending', async () => {
      // Page 1: 1 queued + LastEvaluatedKey
      mockSend.mockResolvedValueOnce({
        Items: [
          { questionId: 'q1', userId: 'u1', displayName: 'A', text: 'Q1', status: 'queued', submittedAt: '2024-01-01T10:00:00Z' },
        ],
        LastEvaluatedKey: { PK: 'EVENT#evt_abc', SK: 'QUESTION#2024-01-01T10:00:00Z#q1' },
      });
      // Page 2: 1 queued + 1 answered, no LastEvaluatedKey (terminates)
      mockSend.mockResolvedValueOnce({
        Items: [
          { questionId: 'q2', userId: 'u2', displayName: 'B', text: 'Q2', status: 'queued', submittedAt: '2024-01-01T10:01:00Z' },
          { questionId: 'q3', userId: 'u3', displayName: 'C', text: 'Q3', status: 'answered', submittedAt: '2024-01-01T10:02:00Z' },
        ],
      });
      // PostToConnectionCommand — assume success.
      mockApiSend.mockResolvedValueOnce({});

      const event = buildEvent({
        action: 'getQuestionQueue',
        eventId: 'evt_abc123',
      });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // The push must include both pages: 2 queued + 1 answered.
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      const sentPayload = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
      expect(sentPayload.type).toBe('QUESTION_QUEUE');
      expect(sentPayload.data.questions).toHaveLength(2);
      expect(sentPayload.data.answered).toHaveLength(1);
      expect(sentPayload.data.count).toBe(2);

      // Second Query must have carried the first page's ExclusiveStartKey.
      const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
      const queryCalls = QueryCommand.mock.calls.filter(
        (c) => c[0] && c[0].ExpressionAttributeValues && c[0].ExpressionAttributeValues[':skPrefix'] === 'QUESTION#',
      );
      expect(queryCalls.length).toBe(2);
      expect(queryCalls[0][0].ExclusiveStartKey).toBeUndefined();
      expect(queryCalls[1][0].ExclusiveStartKey).toEqual({ PK: 'EVENT#evt_abc', SK: 'QUESTION#2024-01-01T10:00:00Z#q1' });
    });
  });
});
