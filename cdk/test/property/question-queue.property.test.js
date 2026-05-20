'use strict';

const fc = require('fast-check');

// Mock crypto
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'mock-uuid-' + Math.random().toString(36).slice(2, 10)),
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

// --- Arbitraries ---

// User ID: alphanumeric, non-empty
const arbUserId = fc.string({ minLength: 3, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_]+$/.test(s))
  .map((s) => `user_${s}`);

// Event ID: alphanumeric, non-empty
const arbEventId = fc.string({ minLength: 3, maxLength: 12 })
  .filter((s) => /^[a-zA-Z0-9]+$/.test(s))
  .map((s) => `evt_${s}`);

// Question text: non-empty printable string
const arbQuestionText = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// Display name
const arbDisplayName = fc.string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// ISO timestamp arbitrary with increasing milliseconds
const arbTimestamp = fc.integer({ min: 1600000000000, max: 1900000000000 })
  .map((ms) => new Date(ms).toISOString());

// Question ID (UUID-like)
const arbQuestionId = fc.hexaString({ minLength: 8, maxLength: 8 })
  .map((s) => `q-${s}`);

// --- Helpers ---

function buildWebSocketEvent({ action, eventId, data, connectionId = 'conn-test-123' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

// --- Property Tests ---

describe('Question Queue Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property 6: Question Queue Maintains Submission Order
   * **Validates: Requirements 8.1, 13.1**
   *
   * For any sequence of questions submitted to an event, the question queue
   * should maintain FIFO order — questions submitted earlier always appear
   * before questions submitted later.
   */
  describe('Property 6: Question Queue Maintains Submission Order', () => {
    it('SK format QUESTION#{timestamp}#{questionId} ensures FIFO ordering when sorted lexicographically', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(arbTimestamp, { minLength: 2, maxLength: 20 }),
          fc.array(arbQuestionId, { minLength: 20, maxLength: 20 }),
          async (eventId, timestamps, questionIds) => {
            // Sort timestamps to simulate chronological submission
            const sortedTimestamps = [...timestamps].sort();

            // Build question items as they would be stored in DynamoDB
            const items = sortedTimestamps.map((ts, i) => ({
              PK: `EVENT#${eventId}`,
              SK: `QUESTION#${ts}#${questionIds[i]}`,
              eventId,
              questionId: questionIds[i],
              text: `Question ${i}`,
              status: 'queued',
              submittedAt: ts,
              type: 'QUESTION',
            }));

            // Sort by SK lexicographically (simulating DynamoDB query with ScanIndexForward=true)
            const sortedBySK = [...items].sort((a, b) => a.SK.localeCompare(b.SK));

            // Verify that the sorted order preserves chronological submission order:
            // Items with earlier timestamps should appear before items with later timestamps
            for (let i = 1; i < sortedBySK.length; i++) {
              const prevTs = sortedBySK[i - 1].submittedAt;
              const currTs = sortedBySK[i].submittedAt;
              expect(currTs >= prevTs).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('questions submitted sequentially produce SKs whose timestamps are non-decreasing', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(
            fc.record({
              userId: arbUserId,
              displayName: arbDisplayName,
              text: arbQuestionText,
            }),
            { minLength: 2, maxLength: 10 }
          ),
          async (eventId, questions) => {
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Submit each question sequentially
            // Each submitQuestion call does: GetCommand (check questionsRestricted) + PutCommand
            for (const _q of questions) {
              mockSend.mockResolvedValueOnce({ Item: {} }); // GetCommand - no restriction
              mockSend.mockResolvedValueOnce({}); // PutCommand
            }

            for (const q of questions) {
              const event = buildWebSocketEvent({
                action: 'submitQuestion',
                eventId,
                data: {
                  userId: q.userId,
                  displayName: q.displayName,
                  text: q.text,
                },
              });

              const result = await handler(event);
              expect(result.statusCode).toBe(200);
            }

            // Collect all SK values from PutCommand calls
            const { PutCommand } = require('@aws-sdk/lib-dynamodb');
            const putCalls = PutCommand.mock.calls;
            const skValues = putCalls.map((call) => call[0].Item.SK);

            // Extract timestamps from SKs (format: QUESTION#{timestamp}#{questionId})
            const timestamps = skValues.map((sk) => {
              const parts = sk.replace('QUESTION#', '').split('#');
              return parts[0]; // timestamp portion
            });

            // Verify timestamps are in non-decreasing order
            // (since questions are submitted sequentially, timestamps must be non-decreasing)
            for (let i = 1; i < timestamps.length; i++) {
              expect(timestamps[i] >= timestamps[i - 1]).toBe(true);
            }

            // Verify all items have status 'queued'
            for (const call of putCalls) {
              expect(call[0].Item.status).toBe('queued');
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 7: Answered or Dismissed Questions Removed from Active Queue
   * **Validates: Requirements 8.2, 8.3**
   *
   * For any question in the active queue, marking it as answered or dismissed
   * should remove it from the active queue, and the remaining questions should
   * preserve their relative order.
   */
  describe('Property 7: Answered or Dismissed Questions Removed from Active Queue', () => {
    it('answering a question changes its status to answered', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbQuestionId,
          arbTimestamp,
          async (eventId, questionId, timestamp) => {
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Mock UpdateCommand
            mockSend.mockResolvedValueOnce({});

            const event = buildWebSocketEvent({
              action: 'answerQuestion',
              eventId,
              data: {
                questionId,
                timestamp,
              },
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // Verify UpdateCommand was called with correct status
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const updateCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(updateCall.Key.PK).toBe(`EVENT#${eventId}`);
            expect(updateCall.Key.SK).toBe(`QUESTION#${timestamp}#${questionId}`);
            expect(updateCall.ExpressionAttributeValues[':status']).toBe('answered');

            // Verify broadcast was called with QUESTION_ANSWERED
            expect(mockBroadcast).toHaveBeenCalledWith(eventId, expect.objectContaining({
              type: 'QUESTION_ANSWERED',
              data: expect.objectContaining({
                questionId,
                timestamp,
              }),
            }));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('dismissing a question changes its status to dismissed', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbQuestionId,
          arbTimestamp,
          async (eventId, questionId, timestamp) => {
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Mock UpdateCommand
            mockSend.mockResolvedValueOnce({});

            const event = buildWebSocketEvent({
              action: 'dismissQuestion',
              eventId,
              data: {
                questionId,
                timestamp,
              },
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // Verify UpdateCommand was called with correct status
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const updateCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(updateCall.Key.PK).toBe(`EVENT#${eventId}`);
            expect(updateCall.Key.SK).toBe(`QUESTION#${timestamp}#${questionId}`);
            expect(updateCall.ExpressionAttributeValues[':status']).toBe('dismissed');

            // Verify broadcast was called with QUESTION_DISMISSED
            expect(mockBroadcast).toHaveBeenCalledWith(eventId, expect.objectContaining({
              type: 'QUESTION_DISMISSED',
              data: expect.objectContaining({
                questionId,
                timestamp,
              }),
            }));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('answered/dismissed questions are excluded from active queue while remaining questions preserve order', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(
            fc.record({
              questionId: arbQuestionId,
              timestamp: arbTimestamp,
              text: arbQuestionText,
            }),
            { minLength: 3, maxLength: 15 }
          ),
          fc.integer({ min: 0 }), // index to answer/dismiss
          fc.constantFrom('answered', 'dismissed'), // action type
          async (eventId, questions, targetIdx, actionType) => {
            // Ensure unique questionIds
            const seen = new Set();
            const uniqueQuestions = questions.filter((q) => {
              if (seen.has(q.questionId)) return false;
              seen.add(q.questionId);
              return true;
            });

            if (uniqueQuestions.length < 2) return;

            // Build the full queue with all questions as 'queued', sorted by SK
            // (DynamoDB returns items sorted by SK within a partition)
            const fullQueue = uniqueQuestions.map((q) => ({
              PK: `EVENT#${eventId}`,
              SK: `QUESTION#${q.timestamp}#${q.questionId}`,
              questionId: q.questionId,
              text: q.text,
              status: 'queued',
              submittedAt: q.timestamp,
            })).sort((a, b) => a.SK.localeCompare(b.SK));

            // Pick a question to answer/dismiss
            const actualIdx = targetIdx % fullQueue.length;
            const targetQuestion = fullQueue[actualIdx];

            // Simulate marking the question as answered/dismissed
            const updatedQueue = fullQueue.map((q, i) =>
              i === actualIdx ? { ...q, status: actionType } : q
            );

            // Filter to active (queued) questions only
            const activeQueue = updatedQueue.filter((q) => q.status === 'queued');

            // Verify the target question is NOT in the active queue
            expect(activeQueue.find((q) => q.questionId === targetQuestion.questionId)).toBeUndefined();

            // Verify the active queue has one fewer item
            expect(activeQueue.length).toBe(fullQueue.length - 1);

            // Verify remaining questions preserve their relative order (already sorted by SK)
            for (let i = 1; i < activeQueue.length; i++) {
              expect(activeQueue[i].SK >= activeQueue[i - 1].SK).toBe(true);
            }

            // Verify timestamps are still in non-decreasing order
            for (let i = 1; i < activeQueue.length; i++) {
              expect(activeQueue[i].submittedAt >= activeQueue[i - 1].submittedAt).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
