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
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

// Mock API Gateway Management API
const mockPostToConnection = jest.fn();
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({
    send: mockPostToConnection,
  })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

// Mock broadcast module
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

// Mock per-message auth check (issue #4) — the signaling dispatcher calls
// checkConnectionAuth before any handler. Without this mock, the auth
// check's internal DDB Get consumes the mockSend chain that handlers
// downstream rely on (specifically the senderConn lookup from #79),
// and handleSendDirectMessage's GetCommand then sees `undefined` and
// returns 403/500.
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

// Connection ID: alphanumeric
const arbConnectionId = fc.string({ minLength: 5, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_]+$/.test(s))
  .map((s) => `conn_${s}`);

// Display name
const arbDisplayName = fc.string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// Message text
const arbMessage = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// ISO timestamp arbitrary
const arbTimestamp = fc.integer({ min: 1600000000000, max: 1900000000000 })
  .map((ms) => new Date(ms).toISOString());

// Generate a set of connections with exactly one presenter and multiple attendees
function arbConnectionSet(eventId) {
  return fc.record({
    presenterConnId: arbConnectionId,
    presenterUserId: arbUserId,
    attendeeCount: fc.integer({ min: 1, max: 15 }),
  }).chain(({ presenterConnId, presenterUserId, attendeeCount }) => {
    return fc.array(
      fc.record({
        connectionId: arbConnectionId,
        userId: arbUserId,
      }),
      { minLength: attendeeCount, maxLength: attendeeCount }
    ).map((attendees) => {
      // Ensure unique connection IDs
      const seen = new Set([presenterConnId]);
      const uniqueAttendees = attendees.filter((a) => {
        if (seen.has(a.connectionId)) return false;
        seen.add(a.connectionId);
        return true;
      });

      const presenterConn = {
        connectionId: presenterConnId,
        userId: presenterUserId,
        eventId,
        role: 'presenter',
      };

      const attendeeConns = uniqueAttendees.map((a) => ({
        connectionId: a.connectionId,
        userId: a.userId,
        eventId,
        role: 'attendee',
      }));

      return {
        presenter: presenterConn,
        attendees: attendeeConns,
        all: [presenterConn, ...attendeeConns],
      };
    });
  });
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

describe('Messaging Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostToConnection.mockResolvedValue({});
  });

  /**
   * Property 3: Direct Messages Delivered Only to Presenter
   * **Validates: Requirements 6.2, 10.1**
   *
   * For any event with M participants (M > 1), when an attendee sends a direct
   * message, the message should be delivered to exactly one recipient (the presenter)
   * and no other participant should receive it.
   */
  describe('Property 3: Direct Messages Delivered Only to Presenter', () => {
    it('direct message is delivered only to presenter connections and no attendees', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbDisplayName,
          arbMessage,
          arbConnectionId,
          fc.integer({ min: 1, max: 10 }),
          async (eventId, senderUserId, displayName, message, senderConnId, attendeeCount) => {
            jest.clearAllMocks();
            mockPostToConnection.mockResolvedValue({});

            // Generate a presenter connection and multiple attendee connections
            const presenterConnId = `conn_presenter_${eventId.slice(4, 10)}`;
            const presenterUserId = `user_presenter_${eventId.slice(4, 10)}`;

            const attendeeConnections = Array.from({ length: attendeeCount }, (_, i) => ({
              connectionId: `conn_attendee_${i}_${eventId.slice(4, 10)}`,
              userId: `user_attendee_${i}`,
              eventId,
              role: 'attendee',
            }));

            const allConnections = [
              {
                connectionId: presenterConnId,
                userId: presenterUserId,
                eventId,
                role: 'presenter',
              },
              ...attendeeConnections,
            ];

            // Mock getConnectionsForEvent to return all connections
            mockSend.mockResolvedValueOnce({ Item: { connectionId: senderConnId, userId: senderUserId, displayName } }); // issue #79
            mockGetConnectionsForEvent.mockResolvedValueOnce(allConnections);

            const event = buildWebSocketEvent({
              action: 'sendDirectMessage',
              eventId,
              data: {
                userId: senderUserId,
                displayName,
                message,
              },
              connectionId: senderConnId,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // Verify getConnectionsForEvent was called with the correct eventId
            expect(mockGetConnectionsForEvent).toHaveBeenCalledWith(eventId);

            // Get all PostToConnectionCommand calls
            const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
            const postCalls = PostToConnectionCommand.mock.calls;

            // Extract connection IDs that received messages
            const recipientConnectionIds = postCalls.map((call) => call[0].ConnectionId);

            // The presenter should receive the direct message
            expect(recipientConnectionIds).toContain(presenterConnId);

            // The sender should receive a delivery confirmation
            expect(recipientConnectionIds).toContain(senderConnId);

            // No attendee connections (other than sender if sender is an attendee) should receive the direct message
            const attendeeConnIds = attendeeConnections.map((c) => c.connectionId);
            const nonSenderAttendeeConnIds = attendeeConnIds.filter((id) => id !== senderConnId);

            for (const attendeeConnId of nonSenderAttendeeConnIds) {
              expect(recipientConnectionIds).not.toContain(attendeeConnId);
            }

            // Verify the message sent to presenter is of type DIRECT_MESSAGE
            const presenterCall = postCalls.find((call) => call[0].ConnectionId === presenterConnId);
            expect(presenterCall).toBeDefined();
            const presenterPayload = JSON.parse(presenterCall[0].Data);
            expect(presenterPayload.type).toBe('DIRECT_MESSAGE');
            expect(presenterPayload.data.userId).toBe(senderUserId);
            expect(presenterPayload.data.message).toBe(message);

            // Verify the confirmation sent to sender is of type DIRECT_MESSAGE_CONFIRMED
            const senderCall = postCalls.find((call) => call[0].ConnectionId === senderConnId);
            expect(senderCall).toBeDefined();
            const senderPayload = JSON.parse(senderCall[0].Data);
            expect(senderPayload.type).toBe('DIRECT_MESSAGE_CONFIRMED');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('direct message is delivered to exactly the presenter connections (count check)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbUserId,
          arbDisplayName,
          arbMessage,
          arbConnectionId,
          async (eventId, senderUserId, displayName, message, senderConnId) => {
            jest.clearAllMocks();
            mockPostToConnection.mockResolvedValue({});

            // Single presenter, multiple attendees
            const presenterConnId = `conn_pres_${eventId.slice(4, 10)}`;
            const connections = [
              { connectionId: presenterConnId, userId: 'user_pres', eventId, role: 'presenter' },
              { connectionId: 'conn_att_1', userId: 'user_att_1', eventId, role: 'attendee' },
              { connectionId: 'conn_att_2', userId: 'user_att_2', eventId, role: 'attendee' },
              { connectionId: 'conn_att_3', userId: 'user_att_3', eventId, role: 'attendee' },
            ];

            mockSend.mockResolvedValueOnce({ Item: { connectionId: senderConnId, userId: senderUserId, displayName } }); // issue #79
            mockGetConnectionsForEvent.mockResolvedValueOnce(connections);

            const event = buildWebSocketEvent({
              action: 'sendDirectMessage',
              eventId,
              data: { userId: senderUserId, displayName, message },
              connectionId: senderConnId,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // PostToConnectionCommand should be called exactly twice:
            // once for the presenter, once for the sender confirmation
            const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
            expect(PostToConnectionCommand).toHaveBeenCalledTimes(2);

            // Verify the two recipients are presenter and sender
            const recipientIds = PostToConnectionCommand.mock.calls.map((c) => c[0].ConnectionId);
            expect(recipientIds).toContain(presenterConnId);
            expect(recipientIds).toContain(senderConnId);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 4: Messages Displayed in Chronological Order
   * **Validates: Requirements 6.3, 9.2**
   *
   * For any sequence of messages with timestamps, the displayed message list
   * should be sorted in non-decreasing order of timestamp.
   */
  describe('Property 4: Messages Displayed in Chronological Order', () => {
    it('group messages include timestamps and sequential sends have non-decreasing timestamps', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(
            fc.record({
              userId: arbUserId,
              displayName: arbDisplayName,
              message: arbMessage,
            }),
            { minLength: 2, maxLength: 10 }
          ),
          arbConnectionId,
          async (eventId, messages, senderConnId) => {
            jest.clearAllMocks();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Mock GetCommand to return chat enabled metadata
            mockSend.mockResolvedValue({ Item: { chatEnabled: true } });

            const timestamps = [];

            for (const msg of messages) {
              mockSend.mockResolvedValueOnce({ Item: { chatEnabled: true } });

              const event = buildWebSocketEvent({
                action: 'sendGroupMessage',
                eventId,
                data: {
                  userId: msg.userId,
                  displayName: msg.displayName,
                  message: msg.message,
                },
                connectionId: senderConnId,
              });

              const result = await handler(event);
              expect(result.statusCode).toBe(200);

              // Extract the timestamp from the broadcast call
              const lastBroadcastCall = mockBroadcast.mock.calls[mockBroadcast.mock.calls.length - 1];
              const broadcastPayload = lastBroadcastCall[1];

              expect(broadcastPayload.type).toBe('GROUP_MESSAGE');
              expect(broadcastPayload.data.timestamp).toBeDefined();

              timestamps.push(broadcastPayload.data.timestamp);
            }

            // Verify timestamps are in non-decreasing order
            for (let i = 1; i < timestamps.length; i++) {
              const prevTime = new Date(timestamps[i - 1]).getTime();
              const currTime = new Date(timestamps[i]).getTime();
              expect(currTime).toBeGreaterThanOrEqual(prevTime);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('direct messages include timestamps and sequential sends have non-decreasing timestamps', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.array(
            fc.record({
              userId: arbUserId,
              displayName: arbDisplayName,
              message: arbMessage,
            }),
            { minLength: 2, maxLength: 10 }
          ),
          arbConnectionId,
          async (eventId, messages, senderConnId) => {
            jest.clearAllMocks();
            mockPostToConnection.mockResolvedValue({});

            const presenterConnId = `conn_pres_${eventId.slice(4, 10)}`;
            const connections = [
              { connectionId: presenterConnId, userId: 'user_pres', eventId, role: 'presenter' },
              { connectionId: senderConnId, userId: 'user_sender', eventId, role: 'attendee' },
            ];

            const timestamps = [];

            for (const msg of messages) {
              // Issue #79: senderConn drives displayed identity. Use the
              // message's userId/displayName so the broadcast carries them.
              mockSend.mockResolvedValueOnce({ Item: { connectionId: senderConnId, userId: msg.userId, displayName: msg.displayName } });
              mockGetConnectionsForEvent.mockResolvedValueOnce(connections);

              const event = buildWebSocketEvent({
                action: 'sendDirectMessage',
                eventId,
                data: {
                  userId: msg.userId,
                  displayName: msg.displayName,
                  message: msg.message,
                },
                connectionId: senderConnId,
              });

              const result = await handler(event);
              expect(result.statusCode).toBe(200);

              // Extract the timestamp from the PostToConnectionCommand call to the presenter
              const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
              const presenterCalls = PostToConnectionCommand.mock.calls.filter(
                (call) => call[0].ConnectionId === presenterConnId
              );
              const lastPresenterCall = presenterCalls[presenterCalls.length - 1];
              const payload = JSON.parse(lastPresenterCall[0].Data);

              expect(payload.type).toBe('DIRECT_MESSAGE');
              expect(payload.data.timestamp).toBeDefined();

              timestamps.push(payload.data.timestamp);
            }

            // Verify timestamps are in non-decreasing order
            for (let i = 1; i < timestamps.length; i++) {
              const prevTime = new Date(timestamps[i - 1]).getTime();
              const currTime = new Date(timestamps[i]).getTime();
              expect(currTime).toBeGreaterThanOrEqual(prevTime);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
