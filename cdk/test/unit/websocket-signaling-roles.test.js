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
  // GetCommand also covers the issue #70 dispatcher authz check.
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
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

// Issue #4: signaling.js calls checkConnectionAuth at the top of every
// request. In unit tests we always want it to allow through; specific
// expiry/reject paths are covered in websocket-signaling-tokenexp.test.js.
jest.mock('../../lambda/websocket/auth-check', () => ({
  checkConnectionAuth: jest.fn().mockResolvedValue({ allowed: true, connection: null }),
}));

// Promote / grant now mint a PUBLISH-capable IVS stage token via
// CreateParticipantToken and deliver it to the target connection only. Mock
// the IVS Real-Time client so the token is deterministic.
const mockIvsSend = jest.fn().mockResolvedValue({
  participantToken: { token: 'STAGE-TOKEN', participantId: 'pid-1', expirationTime: new Date('2099-01-01T00:00:00Z') },
});
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsSend })),
  DisconnectParticipantCommand: jest.fn((params) => ({ type: 'DisconnectParticipant', params })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
}));

// IVS Chat client is constructed at module load; unused on these paths.
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
  DisconnectUserCommand: jest.fn((params) => ({ type: 'DisconnectUser', params })),
}));

// API Gateway Management API — sendToConnection delivers the token to the
// promoted/granted connection only (never on the event-wide broadcast).
const mockApiSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
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
    // Issue #70: dispatcher now does a sender-connection GET to enforce
    // presenter-only authz on every moderation action in this file.
    // Prepend a presenter Item so each test's existing mockResolvedValueOnce
    // chain continues to satisfy its own assertions for the action-specific
    // calls that follow.
    mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123', role: 'presenter', eventId: 'evt_abc123' } });
  });

  describe('presenter-only authz (issue #70)', () => {
    const PRESENTER_ONLY = [
      'promoteUser', 'demoteUser', 'grantSpeak', 'revokeSpeak',
      'toggleChat', 'kickUser', 'banUser',
    ];

    for (const action of PRESENTER_ONLY) {
      it(`returns 403 when ${action} is called by a non-presenter connection`, async () => {
        // Drop the outer beforeEach's prepended presenter Item so the
        // attendee mock is the FIRST thing the authz Get sees.
        mockSend.mockReset();
        mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-attacker', role: 'attendee' } });

        const event = {
          requestContext: { connectionId: 'conn-attacker' },
          body: JSON.stringify({
            action,
            eventId: 'evt_abc123',
            data: { targetConnectionId: 'conn-victim', userId: 'user-victim', enabled: true },
          }),
        };
        const result = await handler(event);
        expect(result.statusCode).toBe(403);
        // No DDB write/update for the action itself — only the authz Get fired.
        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    }

    it('returns 403 when senderConn record is missing entirely', async () => {
      mockSend.mockReset();
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = {
        requestContext: { connectionId: 'conn-ghost' },
        body: JSON.stringify({
          action: 'promoteUser',
          eventId: 'evt_abc123',
          data: { targetConnectionId: 'conn-victim', userId: 'user-victim' },
        }),
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 403 when senderConn.eventId does not match body.eventId (issue #75)', async () => {
      mockSend.mockReset();
      // Sender is a presenter but on a DIFFERENT event.
      mockSend.mockResolvedValueOnce({ Item: { role: 'presenter', eventId: 'evt_OTHER' } });

      const event = {
        requestContext: { connectionId: 'conn-attacker' },
        body: JSON.stringify({
          action: 'promoteUser',
          eventId: 'evt_VICTIM',
          data: { targetConnectionId: 'conn-victim', userId: 'user-victim' },
        }),
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      expect(result.body).toMatch(/different event/);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('promoteUser', () => {
    it('promotes to co-presenter, mints a PUBLISH token, and delivers it to the target only', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand (role -> co-presenter)
      // mintStageToken reads the event's stageArn + the target's fresh state.
      mockSend.mockResolvedValueOnce({ Item: { stageArn: 'arn:aws:ivs:us-east-1:1:stage/s1' } }); // event metadata
      mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-attendee-1', userId: 'user_xyz', displayName: 'Ann', role: 'co-presenter' } }); // connection

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

      // A PUBLISH+SUBSCRIBE token is minted for the target on the event stage.
      const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        stageArn: 'arn:aws:ivs:us-east-1:1:stage/s1',
        userId: 'user_xyz',
        capabilities: ['PUBLISH', 'SUBSCRIBE'],
      }));

      // The event-wide label change EXCLUDES the target — the token must never
      // ride the broadcast.
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'ROLE_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-attendee-1',
          userId: 'user_xyz',
          newRole: 'co-presenter',
        },
      }, { excludeConnectionId: 'conn-attendee-1' });

      // The token is delivered to the promoted connection alone.
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-attendee-1',
        Data: JSON.stringify({
          type: 'ROLE_CHANGED',
          eventId: 'evt_abc123',
          data: {
            connectionId: 'conn-attendee-1',
            userId: 'user_xyz',
            newRole: 'co-presenter',
            stageToken: 'STAGE-TOKEN',
          },
        }),
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
    it('reverts to attendee, mints a SUBSCRIBE-only token, and delivers it to the target only', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand (role -> attendee, speak false)
      mockSend.mockResolvedValueOnce({ Item: { stageArn: 'arn:aws:ivs:us-east-1:1:stage/s1' } }); // event metadata
      mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-copresenter-1', userId: 'user_abc', displayName: 'Bo', role: 'attendee', hasSpeakPermission: false } }); // connection

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

      // The replacement token is SUBSCRIBE-only — the demoted user can no
      // longer publish.
      const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user_abc',
        capabilities: ['SUBSCRIBE'],
      }));

      // Verify broadcast excludes the target (token rides the targeted send).
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'ROLE_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-copresenter-1',
          userId: 'user_abc',
          newRole: 'attendee',
        },
      }, { excludeConnectionId: 'conn-copresenter-1' });

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-copresenter-1',
        Data: JSON.stringify({
          type: 'ROLE_CHANGED',
          eventId: 'evt_abc123',
          data: {
            connectionId: 'conn-copresenter-1',
            userId: 'user_abc',
            newRole: 'attendee',
            stageToken: 'STAGE-TOKEN',
          },
        }),
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
    it('grants speak, mints a PUBLISH token, and delivers it to the target only', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand (hasSpeakPermission true)
      mockSend.mockResolvedValueOnce({ Item: { stageArn: 'arn:aws:ivs:us-east-1:1:stage/s1' } }); // event metadata
      mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-attendee-1', userId: 'user_xyz', displayName: 'Cy', role: 'attendee', hasSpeakPermission: true } }); // connection

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

      // A speak-granted attendee gets PUBLISH capability (role stays attendee).
      const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user_xyz',
        capabilities: ['PUBLISH', 'SUBSCRIBE'],
      }));

      // Verify broadcast excludes the target.
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'SPEAK_PERMISSION_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-attendee-1',
          userId: 'user_xyz',
          hasSpeakPermission: true,
        },
      }, { excludeConnectionId: 'conn-attendee-1' });

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-attendee-1',
        Data: JSON.stringify({
          type: 'SPEAK_PERMISSION_CHANGED',
          eventId: 'evt_abc123',
          data: {
            connectionId: 'conn-attendee-1',
            userId: 'user_xyz',
            hasSpeakPermission: true,
            stageToken: 'STAGE-TOKEN',
          },
        }),
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
    it('revokes speak, mints a SUBSCRIBE-only token, and delivers it to the target only', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateCommand (hasSpeakPermission false)
      mockSend.mockResolvedValueOnce({ Item: { stageArn: 'arn:aws:ivs:us-east-1:1:stage/s1' } }); // event metadata
      mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-attendee-1', userId: 'user_xyz', displayName: 'Di', role: 'attendee', hasSpeakPermission: false } }); // connection

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

      // The replacement token drops PUBLISH.
      const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user_xyz',
        capabilities: ['SUBSCRIBE'],
      }));

      // Verify broadcast excludes the target.
      expect(mockBroadcast).toHaveBeenCalledWith('evt_abc123', {
        type: 'SPEAK_PERMISSION_CHANGED',
        eventId: 'evt_abc123',
        data: {
          connectionId: 'conn-attendee-1',
          userId: 'user_xyz',
          hasSpeakPermission: false,
        },
      }, { excludeConnectionId: 'conn-attendee-1' });

      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
      expect(PostToConnectionCommand).toHaveBeenCalledWith({
        ConnectionId: 'conn-attendee-1',
        Data: JSON.stringify({
          type: 'SPEAK_PERMISSION_CHANGED',
          eventId: 'evt_abc123',
          data: {
            connectionId: 'conn-attendee-1',
            userId: 'user_xyz',
            hasSpeakPermission: false,
            stageToken: 'STAGE-TOKEN',
          },
        }),
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
