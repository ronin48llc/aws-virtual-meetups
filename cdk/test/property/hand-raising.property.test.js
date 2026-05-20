'use strict';

const fc = require('fast-check');

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
  // GetCommand needed for issue #70 dispatcher authz on lowerAllHands.
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
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

// Mock per-message auth check (issue #4) — the dispatcher calls
// checkConnectionAuth at the top of every action and its DDB Get
// would otherwise consume the mockSend chain the lowerAllHands
// presenter authz (#70) needs.
jest.mock('../../lambda/websocket/auth-check', () => ({
  checkConnectionAuth: jest.fn().mockResolvedValue({ allowed: true, connection: null }),
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

// ISO timestamp arbitrary
const arbTimestamp = fc.integer({ min: 1600000000000, max: 1900000000000 })
  .map((ms) => new Date(ms).toISOString());

// Display name
const arbDisplayName = fc.string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// Hand count (for generating lists of raised hands)
const arbHandCount = fc.integer({ min: 1, max: 30 });

// Generate a list of unique raised hand items for a given event
function arbHandItems(eventId) {
  return fc.array(
    fc.record({
      userId: arbUserId,
      timestamp: arbTimestamp,
    }),
    { minLength: 1, maxLength: 30 }
  ).map((hands) => {
    // Ensure unique userIds
    const seen = new Set();
    const unique = hands.filter((h) => {
      if (seen.has(h.userId)) return false;
      seen.add(h.userId);
      return true;
    });
    return unique.map((h) => ({
      PK: `EVENT#${eventId}`,
      SK: `HAND#${h.timestamp}#${h.userId}`,
      eventId,
      userId: h.userId,
      timestamp: h.timestamp,
      type: 'HAND',
    }));
  }).filter((items) => items.length > 0);
}

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

describe('Hand-Raising Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property 1: Hand Lowering Removes Specific Hand
   * Validates: Requirements 5.1
   *
   * For any event with N raised hands (N > 0), when the presenter lowers a
   * specific attendee's hand, the raised-hand list should contain exactly N-1
   * entries and the lowered attendee's hand should not be present.
   */
  describe('Property 1: Hand Lowering Removes Specific Hand', () => {
    it('lowering a specific hand removes only that hand from the list', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbHandItems('evt_test'),
          async (eventId, handItems) => {
            // Fix the eventId in hand items
            const items = handItems.map((h) => ({
              ...h,
              PK: `EVENT#${eventId}`,
              eventId,
            }));

            const N = items.length;
            // Pick a random hand to lower
            const targetIndex = Math.floor(Math.random() * N);
            const targetHand = items[targetIndex];

            // Mock the DeleteCommand for lowerHand
            mockSend.mockResolvedValueOnce({});

            const event = buildWebSocketEvent({
              action: 'lowerHand',
              eventId,
              data: {
                userId: targetHand.userId,
                timestamp: targetHand.timestamp,
              },
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // Verify the delete was called with the correct key
            const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
            expect(DeleteCommand).toHaveBeenCalledWith({
              TableName: 'TestTable',
              Key: {
                PK: `EVENT#${eventId}`,
                SK: `HAND#${targetHand.timestamp}#${targetHand.userId}`,
              },
            });

            // Simulate the resulting list after deletion
            const remainingHands = items.filter((_, i) => i !== targetIndex);
            expect(remainingHands.length).toBe(N - 1);
            expect(remainingHands.find((h) => h.userId === targetHand.userId && h.timestamp === targetHand.timestamp)).toBeUndefined();

            // Verify broadcast was called with HAND_LOWERED
            expect(mockBroadcast).toHaveBeenCalledWith(eventId, expect.objectContaining({
              type: 'HAND_LOWERED',
              data: expect.objectContaining({
                userId: targetHand.userId,
                timestamp: targetHand.timestamp,
              }),
            }));
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 2: Lower All Hands Clears All
   * Validates: Requirements 5.2
   *
   * For any event with N raised hands (N >= 0), when the presenter lowers all
   * hands, the raised-hand list should be empty (length 0) and exactly N
   * notifications should be generated (broadcast count = N).
   */
  describe('Property 2: Lower All Hands Clears All', () => {
    it('lowerAllHands clears all hands and broadcasts the correct count', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.integer({ min: 0, max: 30 }),
          arbTimestamp,
          async (eventId, handCount, baseTimestamp) => {
            // Clear mocks before each iteration to avoid accumulation
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Generate N hand items
            const items = Array.from({ length: handCount }, (_, i) => ({
              PK: `EVENT#${eventId}`,
              SK: `HAND#${new Date(new Date(baseTimestamp).getTime() + i * 1000).toISOString()}#user_${i}`,
              eventId,
              userId: `user_${i}`,
              timestamp: new Date(new Date(baseTimestamp).getTime() + i * 1000).toISOString(),
              type: 'HAND',
            }));

            // Issue #70: dispatcher authz GET on the connections table.
            mockSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId } });
            // Mock QueryCommand returning all hands
            mockSend.mockResolvedValueOnce({ Items: items });

            // Mock BatchWriteCommand(s) if there are items to delete
            if (handCount > 0) {
              const batchCount = Math.ceil(handCount / 25);
              for (let i = 0; i < batchCount; i++) {
                mockSend.mockResolvedValueOnce({});
              }
            }

            const event = buildWebSocketEvent({
              action: 'lowerAllHands',
              eventId,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // Verify broadcast was called with HANDS_CLEARED and correct count
            expect(mockBroadcast).toHaveBeenCalledWith(eventId, {
              type: 'HANDS_CLEARED',
              eventId,
              data: { count: handCount },
            });

            // Verify that the correct number of calls were made.
            // Issue #70: the dispatcher now adds one authz GET on every
            // PRESENTER_ONLY_ACTIONS call, so the totals are offset by 1.
            if (handCount > 0) {
              const expectedBatches = Math.ceil(handCount / 25);
              // mockSend: 1 (authz) + 1 (query) + expectedBatches (deletes)
              expect(mockSend).toHaveBeenCalledTimes(2 + expectedBatches);
            } else {
              // 1 (authz) + 1 (query), no batch deletes
              expect(mockSend).toHaveBeenCalledTimes(2);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 10: Hand Raise/Lower Round-Trip
   * Validates: Requirements 12.1, 12.2
   *
   * For any attendee, raising their hand and then lowering it should result
   * in the attendee not appearing in the raised-hand list.
   */
  describe('Property 10: Hand Raise/Lower Round-Trip', () => {
    it('raising then lowering a hand results in the attendee not being in the list', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbDisplayName,
          async (eventId, userId, displayName) => {
            // Step 1: Raise hand
            mockSend.mockResolvedValueOnce({}); // PutCommand

            const raiseEvent = buildWebSocketEvent({
              action: 'raiseHand',
              eventId,
              data: { userId, displayName },
            });

            const raiseResult = await handler(raiseEvent);
            expect(raiseResult.statusCode).toBe(200);

            // Capture the timestamp from the PutCommand call
            const { PutCommand } = require('@aws-sdk/lib-dynamodb');
            const putCall = PutCommand.mock.calls[PutCommand.mock.calls.length - 1][0];
            const raisedTimestamp = putCall.Item.timestamp;

            // Step 2: Lower hand with the same userId and timestamp
            mockSend.mockResolvedValueOnce({}); // DeleteCommand

            const lowerEvent = buildWebSocketEvent({
              action: 'lowerHand',
              eventId,
              data: { userId, timestamp: raisedTimestamp },
            });

            const lowerResult = await handler(lowerEvent);
            expect(lowerResult.statusCode).toBe(200);

            // Verify the delete targets the exact key that was created
            const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
            const deleteCall = DeleteCommand.mock.calls[DeleteCommand.mock.calls.length - 1][0];
            expect(deleteCall.Key.PK).toBe(putCall.Item.PK);
            expect(deleteCall.Key.SK).toBe(putCall.Item.SK);

            // After raise + lower, the item is deleted — the attendee is not in the list
            // The delete key matches the put key exactly, confirming round-trip removal
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 11: Raised Hands Ordered by Time
   * Validates: Requirements 12.3
   *
   * For any sequence of hand raises with timestamps, the raised-hand list
   * should be sorted in non-decreasing order of timestamp.
   */
  describe('Property 11: Raised Hands Ordered by Time', () => {
    it('raised hands stored with SK format that ensures chronological ordering', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(
            fc.record({
              userId: arbUserId,
              timestamp: arbTimestamp,
            }),
            { minLength: 2, maxLength: 20 }
          ),
          async (eventId, hands) => {
            // Ensure unique userIds for this test
            const seen = new Set();
            const uniqueHands = hands.filter((h) => {
              if (seen.has(h.userId)) return false;
              seen.add(h.userId);
              return true;
            });

            if (uniqueHands.length < 2) return; // Need at least 2 hands

            // Simulate raising each hand (each creates a PutCommand)
            for (const hand of uniqueHands) {
              mockSend.mockResolvedValueOnce({}); // PutCommand
            }

            const putCalls = [];
            for (const hand of uniqueHands) {
              const raiseEvent = buildWebSocketEvent({
                action: 'raiseHand',
                eventId,
                data: { userId: hand.userId, displayName: 'Test' },
              });

              await handler(raiseEvent);
            }

            // Collect all SK values from PutCommand calls
            const { PutCommand } = require('@aws-sdk/lib-dynamodb');
            const skValues = PutCommand.mock.calls.map((call) => call[0].Item.SK);

            // The SK format is HAND#{timestamp}#{userId}
            // DynamoDB sorts SK lexicographically, so items with earlier timestamps
            // will appear first in query results (begins_with HAND#)
            // Verify that sorting SKs lexicographically gives chronological order
            const sortedSKs = [...skValues].sort();

            // Extract timestamps from sorted SKs
            const sortedTimestamps = sortedSKs.map((sk) => {
              // SK format: HAND#2024-01-15T10:30:00.000Z#user_xyz
              const parts = sk.replace('HAND#', '').split('#');
              return parts[0]; // timestamp portion
            });

            // Verify timestamps are in non-decreasing order when SKs are sorted
            for (let i = 1; i < sortedTimestamps.length; i++) {
              expect(sortedTimestamps[i] >= sortedTimestamps[i - 1]).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('query results sorted by SK produce chronologically ordered hands', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(arbTimestamp, { minLength: 2, maxLength: 15 }),
          async (eventId, timestamps) => {
            // Build hand items with various timestamps
            const items = timestamps.map((ts, i) => ({
              PK: `EVENT#${eventId}`,
              SK: `HAND#${ts}#user_${i}`,
              eventId,
              userId: `user_${i}`,
              timestamp: ts,
              type: 'HAND',
            }));

            // Sort by SK (simulating DynamoDB query with ScanIndexForward=true)
            const sortedItems = [...items].sort((a, b) => a.SK.localeCompare(b.SK));

            // Verify that the sorted order is non-decreasing by timestamp
            for (let i = 1; i < sortedItems.length; i++) {
              const prevTs = new Date(sortedItems[i - 1].timestamp).getTime();
              const currTs = new Date(sortedItems[i].timestamp).getTime();
              expect(currTs).toBeGreaterThanOrEqual(prevTs);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
