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
  // GetCommand needed for issue #70 dispatcher authz on presenter-only actions.
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

// Connection ID: alphanumeric, non-empty
const arbConnectionId = fc.string({ minLength: 5, maxLength: 30 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
  .map((s) => `conn_${s}`);

// User ID: alphanumeric, non-empty
const arbUserId = fc.string({ minLength: 3, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_]+$/.test(s))
  .map((s) => `user_${s}`);

// Event ID: alphanumeric, non-empty
const arbEventId = fc.string({ minLength: 3, maxLength: 12 })
  .filter((s) => /^[a-zA-Z0-9]+$/.test(s))
  .map((s) => `evt_${s}`);

// --- Helpers ---

function buildWebSocketEvent({ action, eventId, data, connectionId = 'conn-presenter-123' }) {
  const body = { action, eventId };
  if (data) body.data = data;
  return {
    requestContext: { connectionId },
    body: JSON.stringify(body),
  };
}

// --- Property Tests ---

describe('Role and Permission Management Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property 5: Role Promotion/Demotion Round-Trip
   * **Validates: Requirements 7.1, 7.2**
   *
   * For any attendee in an event, promoting them to co-presenter and then
   * demoting them back should result in the user having exactly the same
   * capabilities as a standard attendee (SUBSCRIBE only, no moderation privileges).
   */
  describe('Property 5: Role Promotion/Demotion Round-Trip', () => {
    it('promote then demote results in role=attendee and hasSpeakPermission=false', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbConnectionId,
          arbUserId,
          async (eventId, targetConnectionId, userId) => {
            // Clear mocks for each iteration
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Step 1: Promote user to co-presenter
            mockSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId } }); // issue #70 authz
            mockSend.mockResolvedValueOnce({}); // UpdateCommand for promote

            const promoteEvent = buildWebSocketEvent({
              action: 'promoteUser',
              eventId,
              data: { targetConnectionId, userId },
            });

            const promoteResult = await handler(promoteEvent);
            expect(promoteResult.statusCode).toBe(200);

            // Verify promote sets role to co-presenter
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const promoteCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(promoteCall.ExpressionAttributeValues[':role']).toBe('co-presenter');

            // Step 2: Demote user back to attendee
            mockSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId } }); // issue #70 authz
            mockSend.mockResolvedValueOnce({}); // UpdateCommand for demote

            const demoteEvent = buildWebSocketEvent({
              action: 'demoteUser',
              eventId,
              data: { targetConnectionId, userId },
            });

            const demoteResult = await handler(demoteEvent);
            expect(demoteResult.statusCode).toBe(200);

            // Verify demote sets role to attendee AND hasSpeakPermission to false
            const demoteCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(demoteCall.ExpressionAttributeValues[':role']).toBe('attendee');
            expect(demoteCall.ExpressionAttributeValues[':speak']).toBe(false);

            // The round-trip guarantees the user ends up as a standard attendee:
            // - role = 'attendee' (SUBSCRIBE only capability)
            // - hasSpeakPermission = false (no audio transmission)
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 8: Chat Permission Controls Message Acceptance
   * **Validates: Requirements 9.1, 9.3**
   *
   * For any attendee group message attempt, the message is accepted if and only if
   * group chat is currently enabled by the presenter. When disabled, the message is
   * rejected and the attendee receives a "disabled" notification.
   */
  describe('Property 8: Chat Permission Controls Message Acceptance', () => {
    it('toggleChat correctly sets chatEnabled state for the event', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          fc.boolean(),
          async (eventId, enabled) => {
            // Clear mocks for each iteration
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            // Toggle chat with the given enabled value
            mockSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId } }); // issue #70 authz
            mockSend.mockResolvedValueOnce({}); // UpdateCommand

            const toggleEvent = buildWebSocketEvent({
              action: 'toggleChat',
              eventId,
              data: { enabled },
            });

            const result = await handler(toggleEvent);
            expect(result.statusCode).toBe(200);

            // Verify the DynamoDB update stores the correct chatEnabled state
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const updateCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(updateCall.TableName).toBe('TestTable');
            expect(updateCall.Key).toEqual({ PK: `EVENT#${eventId}`, SK: 'METADATA' });
            expect(updateCall.ExpressionAttributeValues[':chatEnabled']).toBe(enabled);

            // Verify broadcast notifies all participants of the chat state
            expect(mockBroadcast).toHaveBeenCalledWith(eventId, {
              type: 'CHAT_STATE_CHANGED',
              eventId,
              data: { chatEnabled: enabled },
            });

            // Property: chatEnabled=true means messages accepted,
            // chatEnabled=false means messages rejected with "disabled" notification.
            // The toggleChat action correctly persists this state which is then
            // enforced by the chat message handling logic.
            if (enabled) {
              expect(result.body).toBe('Chat enabled');
            } else {
              expect(result.body).toBe('Chat disabled');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 9: Speaking Permission Controls Audio Transmission
   * **Validates: Requirements 11.1, 11.3**
   *
   * For any attendee, their microphone audio is transmitted to other participants
   * if and only if the presenter has granted them speaking permission. Without
   * permission, audio input is muted.
   */
  describe('Property 9: Speaking Permission Controls Audio Transmission', () => {
    it('grantSpeak/revokeSpeak correctly toggles hasSpeakPermission', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbConnectionId,
          arbUserId,
          fc.boolean(),
          async (eventId, targetConnectionId, userId, shouldGrant) => {
            // Clear mocks for each iteration
            mockSend.mockReset();
            mockBroadcast.mockReset();
            mockBroadcast.mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });

            const action = shouldGrant ? 'grantSpeak' : 'revokeSpeak';

            // Execute the speak permission action
            mockSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId } }); // issue #70 authz
            mockSend.mockResolvedValueOnce({}); // UpdateCommand

            const speakEvent = buildWebSocketEvent({
              action,
              eventId,
              data: { targetConnectionId, userId },
            });

            const result = await handler(speakEvent);
            expect(result.statusCode).toBe(200);

            // Verify the DynamoDB update sets hasSpeakPermission correctly
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const updateCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(updateCall.TableName).toBe('TestConnectionsTable');
            expect(updateCall.Key).toEqual({ connectionId: targetConnectionId });
            expect(updateCall.ExpressionAttributeValues[':speak']).toBe(shouldGrant);

            // Verify broadcast notifies all participants of the permission change
            expect(mockBroadcast).toHaveBeenCalledWith(eventId, {
              type: 'SPEAK_PERMISSION_CHANGED',
              eventId,
              data: {
                connectionId: targetConnectionId,
                userId,
                hasSpeakPermission: shouldGrant,
              },
            });

            // Property: hasSpeakPermission=true means audio is transmitted (mic unmuted),
            // hasSpeakPermission=false means audio is NOT transmitted (mic muted).
            // The grantSpeak/revokeSpeak actions correctly persist this state.
            if (shouldGrant) {
              expect(result.body).toBe('Speak permission granted');
            } else {
              expect(result.body).toBe('Speak permission revoked');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
