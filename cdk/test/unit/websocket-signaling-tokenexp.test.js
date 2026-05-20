'use strict';

/**
 * Tests for the per-message tokenExp check in signaling.js (issue #4).
 * Specifically: signaling.js consults checkConnectionAuth and rejects
 * with 401 when the connection's stored tokenExp has passed.
 *
 * Here we mock checkConnectionAuth directly with the three outcomes we
 * care about — allowed, expired, ddb-error — rather than priming mockSend.
 */

const mockCheckConnectionAuth = jest.fn();
jest.mock('../../lambda/websocket/auth-check', () => ({
  checkConnectionAuth: mockCheckConnectionAuth,
}));

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
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
}));

jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: jest.fn().mockResolvedValue({ sent: 0, failed: 0, cleaned: 0 }),
  getConnectionsForEvent: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../lambda/websocket/rate-limiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }),
  RATE_LIMIT: 60,
  RATE_WINDOW_SECONDS: 60,
}));

process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler } = require('../../lambda/websocket/signaling');

function buildEvent({ action = 'raiseHand', eventId = 'evt_abc123', connectionId = 'conn-123', data = {} } = {}) {
  return {
    requestContext: { connectionId },
    body: JSON.stringify({ action, eventId, data }),
  };
}

describe('signaling.js — per-message tokenExp check (issue #4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
  });

  it('rejects with 401 when checkConnectionAuth says token-expired', async () => {
    mockCheckConnectionAuth.mockResolvedValueOnce({ allowed: false, reason: 'token-expired' });

    const result = await handler(buildEvent());
    expect(result.statusCode).toBe(401);
    expect(result.body).toMatch(/token expired/i);
    expect(mockCheckConnectionAuth).toHaveBeenCalledWith('conn-123');
  });

  it('continues to action dispatch when checkConnectionAuth allows', async () => {
    mockCheckConnectionAuth.mockResolvedValueOnce({ allowed: true, connection: { connectionId: 'conn-123' } });
    mockSend.mockResolvedValueOnce({}); // PutCommand for raiseHand
    mockSend.mockResolvedValue({ Items: [] }); // QueryCommand for broadcast lookup

    const result = await handler(buildEvent({ data: { userId: 'user-456', displayName: 'Test User' } }));
    expect(result.statusCode).toBe(200);
  });

  it('continues when checkConnectionAuth allows with a null connection (DDB blip path)', async () => {
    mockCheckConnectionAuth.mockResolvedValueOnce({ allowed: true, connection: null });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(buildEvent({ data: { userId: 'user-456', displayName: 'Test User' } }));
    expect(result.statusCode).toBe(200);
  });
});

// auth-check.js itself is exercised via the same mockSend (set up at the
// top of this file) — no jest.resetModules dance.

describe('auth-check.js — checkConnectionAuth (issue #4)', () => {
  // Need un-mocked auth-check for this suite; load it via require.requireActual.
  const { checkConnectionAuth } = jest.requireActual('../../lambda/websocket/auth-check');

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
  });

  it('rejects an expired token', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { connectionId: 'conn-123', tokenExp: Math.floor(Date.now() / 1000) - 60 },
    });
    const result = await checkConnectionAuth('conn-123');
    expect(result).toEqual({ allowed: false, reason: 'token-expired' });
  });

  it('allows a non-expired token', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { connectionId: 'conn-123', tokenExp: Math.floor(Date.now() / 1000) + 3600 },
    });
    const result = await checkConnectionAuth('conn-123');
    expect(result.allowed).toBe(true);
    expect(result.connection.connectionId).toBe('conn-123');
  });

  it('allows when the record has no tokenExp (legacy connections)', async () => {
    mockSend.mockResolvedValueOnce({ Item: { connectionId: 'conn-123' } });
    const result = await checkConnectionAuth('conn-123');
    expect(result.allowed).toBe(true);
  });

  it('allows when the record cannot be loaded (DDB blip)', async () => {
    mockSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    const result = await checkConnectionAuth('conn-123');
    expect(result).toEqual({ allowed: true, connection: null });
  });

  it('allows with a null connection when no record is found', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await checkConnectionAuth('conn-123');
    expect(result).toEqual({ allowed: true, connection: null });
  });
});
