'use strict';

// Mock the JWT verifier so connect.js trusts the test query-string token.
// Tests can override mockVerifyIdToken.mockResolvedValueOnce(...) to exercise
// the failure path (returns null).
const mockVerifyIdToken = jest.fn();
jest.mock('../../lambda/shared/jwt-verifier', () => ({
  verifyIdToken: mockVerifyIdToken,
}));

// Default: every test sees a verifier that returns claims matching the
// userId/email/exp the existing tests expect. Individual tests override
// via mockResolvedValueOnce.
beforeEach(() => {
  mockVerifyIdToken.mockResolvedValue({
    sub: 'user-456',
    email: 'user-456@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  });
});

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
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
}));
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

// Set env before requiring handlers
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.TABLE_NAME = 'TestTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler: connectHandler } = require('../../lambda/websocket/connect');
const { handler: disconnectHandler } = require('../../lambda/websocket/disconnect');
const { broadcast, getConnectionsForEvent } = require('../../lambda/websocket/broadcast');

function buildConnectEvent({ queryStringParameters, connectionId = 'conn-123' }) {
  return {
    requestContext: { connectionId },
    queryStringParameters,
  };
}

function buildDisconnectEvent({ connectionId = 'conn-123' }) {
  return {
    requestContext: { connectionId },
  };
}

describe('WebSocket Connect Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores connection with valid parameters and returns 200', async () => {
    // Ban check - no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // PutCommand for connection
    mockSend.mockResolvedValueOnce({});

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
        role: 'attendee',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('Connected');

    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    expect(PutCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'TestConnectionsTable',
        Item: expect.objectContaining({
          connectionId: 'conn-123',
          eventId: 'evt_abc123',
          userId: 'user-456',
          role: 'attendee',
        }),
      })
    );
  });

  it('stores connection with connectedAt and ttl fields', async () => {
    // Ban check - no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // PutCommand
    mockSend.mockResolvedValueOnce({});

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
        role: 'presenter',
      },
    });

    await connectHandler(event);

    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const putCall = PutCommand.mock.calls[0][0];
    expect(putCall.Item.connectedAt).toBeDefined();
    expect(putCall.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('defaults role to attendee when not provided', async () => {
    // Ban check - no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // PutCommand
    mockSend.mockResolvedValueOnce({});

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(200);

    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const putCall = PutCommand.mock.calls[0][0];
    expect(putCall.Item.role).toBe('attendee');
  });

  it('accepts co-presenter role', async () => {
    // Ban check - no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // PutCommand
    mockSend.mockResolvedValueOnce({});

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
        role: 'co-presenter',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(200);

    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const putCall = PutCommand.mock.calls[0][0];
    expect(putCall.Item.role).toBe('co-presenter');
  });

  it('returns 401 when user is banned from the event', async () => {
    // Ban check - ban exists
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'EVENT#evt_abc123', SK: 'BAN#user-456', userId: 'user-456', bannedAt: '2024-01-01T00:00:00Z' },
    });

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
        role: 'attendee',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(401);
    expect(result.body).toBe('You are banned from this event');
  });

  it('allows connection when user is not banned', async () => {
    // Ban check - no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // PutCommand
    mockSend.mockResolvedValueOnce({});

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
        role: 'attendee',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('Connected');
  });

  it('returns 401 when token is missing', async () => {
    const event = buildConnectEvent({
      queryStringParameters: {
        eventId: 'evt_abc123',
        userId: 'user-456',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(401);
    expect(result.body).toContain('Unauthorized');
  });

  it('returns 401 when eventId is missing', async () => {
    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        userId: 'user-456',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 when token verification fails (issue #4)', async () => {
    // Override the default verifier mock for this test only — returning
    // null means the JWT was invalid or expired.
    mockVerifyIdToken.mockResolvedValueOnce(null);

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'forged-or-expired-token',
        eventId: 'evt_abc123',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(401);
    expect(result.body).toMatch(/invalid token/i);
  });

  it('uses claims.sub for userId — never the query string (issue #4)', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      sub: 'verified-user-from-jwt',
      email: 'verified@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    // Ban check
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // Query for stale connections
    mockSend.mockResolvedValueOnce({ Items: [] });
    // Put for new connection
    mockSend.mockResolvedValueOnce({});
    // Broadcast Query
    mockSend.mockResolvedValue({ Items: [] });

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token',
        eventId: 'evt_abc123',
        userId: 'attacker-claimed-id', // should be ignored
      },
    });

    await connectHandler(event);

    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const putCall = PutCommand.mock.calls[0][0];
    expect(putCall.Item.userId).toBe('verified-user-from-jwt');
    expect(putCall.Item.userId).not.toBe('attacker-claimed-id');
  });

  it('stores tokenExp on the connection record for per-message validation (issue #4)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 1800;
    mockVerifyIdToken.mockResolvedValueOnce({
      sub: 'user-456',
      email: 'user-456@example.com',
      exp,
    });
    mockSend.mockResolvedValueOnce({ Item: undefined });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValue({ Items: [] });

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token',
        eventId: 'evt_abc123',
      },
    });

    await connectHandler(event);

    const { PutCommand } = require('@aws-sdk/lib-dynamodb');
    const putCall = PutCommand.mock.calls[0][0];
    expect(putCall.Item.tokenExp).toBe(exp);
  });

  it('returns 401 when queryStringParameters is null', async () => {
    const event = buildConnectEvent({
      queryStringParameters: null,
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(401);
  });

  it('returns 401 when role is invalid', async () => {
    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
        role: 'admin',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(401);
    expect(result.body).toContain('invalid role');
  });

  it('returns 500 when DynamoDB put fails', async () => {
    // Ban check - no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // PutCommand fails
    mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(500);
    expect(result.body).toContain('Internal server error');
  });

  it('paginates the existing-connections dedup query — finds and deletes a stale connection on page 2 (issue #68)', async () => {
    // 1. Ban check
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // 2. Query page 1 — different user's connection + LastEvaluatedKey
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-other-1', userId: 'other-user', eventId: 'evt_abc123' },
      ],
      LastEvaluatedKey: { connectionId: 'conn-other-1', eventId: 'evt_abc123' },
    });
    // 3. Query page 2 — our user's stale connection, no LastEvaluatedKey (terminates)
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-stale', userId: 'user-456', eventId: 'evt_abc123' },
      ],
    });
    // 4. DeleteCommand for the stale connection
    mockSend.mockResolvedValueOnce({});
    // 5. PutCommand for the new connection
    mockSend.mockResolvedValueOnce({});

    const event = buildConnectEvent({
      queryStringParameters: {
        token: 'valid-token-123',
        eventId: 'evt_abc123',
        userId: 'user-456',
      },
    });

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(200);

    // Verify DeleteCommand was issued for the page-2 stale connection.
    const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    expect(DeleteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'TestConnectionsTable',
        Key: { connectionId: 'conn-stale' },
      }),
    );

    // First two QueryCommands against EventConnections are the dedup loop:
    // page 1 with no ExclusiveStartKey, page 2 with the first page's LEK.
    // (A third QueryCommand is fired later by the ATTENDEE_JOINED broadcast
    // for the same GSI; not part of the dedup loop, so don't assert on it.)
    const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
    const queryCalls = QueryCommand.mock.calls.filter((c) => c[0] && c[0].IndexName === 'EventConnections');
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    expect(queryCalls[0][0].ExclusiveStartKey).toBeUndefined();
    expect(queryCalls[1][0].ExclusiveStartKey).toEqual({ connectionId: 'conn-other-1', eventId: 'evt_abc123' });
  });
});

describe('WebSocket Disconnect Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes connection from table and returns 200', async () => {
    mockSend.mockResolvedValueOnce({});

    const event = buildDisconnectEvent({ connectionId: 'conn-789' });

    const result = await disconnectHandler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('Disconnected');

    const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    expect(DeleteCommand).toHaveBeenCalledWith({
      TableName: 'TestConnectionsTable',
      Key: { connectionId: 'conn-789' },
    });
  });

  it('returns 200 even when DynamoDB delete fails (best-effort)', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

    const event = buildDisconnectEvent({ connectionId: 'conn-789' });

    const result = await disconnectHandler(event);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('Disconnected');
  });
});

describe('WebSocket Broadcast Utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries EventConnections GSI and sends message to all connections', async () => {
    // Mock query for connections
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-1', role: 'presenter' },
        { connectionId: 'conn-2', eventId: 'evt_abc', userId: 'user-2', role: 'attendee' },
      ],
    });
    // Mock PostToConnection calls
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const result = await broadcast('evt_abc', { type: 'HAND_RAISED', userId: 'user-2' });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.cleaned).toBe(0);
  });

  it('excludes specified connectionId from broadcast', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-1', role: 'presenter' },
        { connectionId: 'conn-2', eventId: 'evt_abc', userId: 'user-2', role: 'attendee' },
      ],
    });
    // Only one PostToConnection call (conn-1 excluded)
    mockSend.mockResolvedValueOnce({});

    const result = await broadcast('evt_abc', { type: 'TEST' }, { excludeConnectionId: 'conn-1' });

    expect(result.sent).toBe(1);
  });

  it('handles GoneException by cleaning stale connections', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-1', role: 'presenter' },
      ],
    });
    // PostToConnection throws GoneException
    const goneError = new Error('Gone');
    goneError.statusCode = 410;
    goneError.name = 'GoneException';
    mockSend.mockRejectedValueOnce(goneError);
    // DeleteCommand for cleanup
    mockSend.mockResolvedValueOnce({});

    const result = await broadcast('evt_abc', { type: 'TEST' });

    expect(result.sent).toBe(0);
    expect(result.cleaned).toBe(1);
  });

  it('handles empty connections list', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await broadcast('evt_abc', { type: 'TEST' });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.cleaned).toBe(0);
  });

  it('getConnectionsForEvent paginates through results', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ connectionId: 'conn-1', eventId: 'evt_abc' }],
      LastEvaluatedKey: { connectionId: 'conn-1' },
    });
    mockSend.mockResolvedValueOnce({
      Items: [{ connectionId: 'conn-2', eventId: 'evt_abc' }],
    });

    const connections = await getConnectionsForEvent('evt_abc');

    expect(connections).toHaveLength(2);
    expect(connections[0].connectionId).toBe('conn-1');
    expect(connections[1].connectionId).toBe('conn-2');

    const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
    expect(QueryCommand).toHaveBeenCalledTimes(2);
  });

  it('serializes object messages to JSON', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-1', role: 'attendee' },
      ],
    });
    mockSend.mockResolvedValueOnce({});

    await broadcast('evt_abc', { type: 'CHAT_MESSAGE', text: 'Hello' });

    const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
    expect(PostToConnectionCommand).toHaveBeenCalledWith({
      ConnectionId: 'conn-1',
      Data: JSON.stringify({ type: 'CHAT_MESSAGE', text: 'Hello' }),
    });
  });

  it('counts non-Gone errors as failed', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-1', role: 'attendee' },
      ],
    });
    // PostToConnection throws a non-Gone error
    mockSend.mockRejectedValueOnce(new Error('Throttled'));

    const result = await broadcast('evt_abc', { type: 'TEST' });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.cleaned).toBe(0);
  });
});
