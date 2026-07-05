'use strict';

// Regression tests for caption broadcast. The client wraps every action
// payload under `data` ({action, eventId, data: {...}}); the handler
// previously destructured text/language from the top level, rejecting
// EVERY caption with 400 — attendees never left "Waiting for presenter
// to enable captions".

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
}));

const mockBroadcast = jest.fn().mockResolvedValue({ sent: 2, failed: 0, cleaned: 0 });
const mockGetConnectionsForEvent = jest.fn();
jest.mock('../../lambda/websocket/broadcast', () => ({
  broadcast: mockBroadcast,
  getConnectionsForEvent: mockGetConnectionsForEvent,
}));

jest.mock('../../lambda/websocket/rate-limiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, count: 1 }),
  RATE_LIMIT: 60,
  RATE_WINDOW_SECONDS: 60,
}));

jest.mock('../../lambda/websocket/auth-check', () => ({
  checkConnectionAuth: jest.fn().mockResolvedValue({ allowed: true, connection: null }),
}));

const mockApiSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.execute-api.us-east-1.amazonaws.com/prod';

const { handler } = require('../../lambda/websocket/signaling');

function buildCaptionEvent(body, connectionId = 'conn-presenter') {
  return {
    requestContext: { connectionId, routeKey: 'broadcastCaption' },
    body: JSON.stringify(body),
  };
}

describe('broadcastCaption payload handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConnectionsForEvent.mockResolvedValue([
      { connectionId: 'conn-presenter', role: 'presenter', eventId: 'evt_1' },
      { connectionId: 'conn-attendee', role: 'attendee', eventId: 'evt_1' },
    ]);
  });

  it('accepts the client wire shape (fields nested under data) and broadcasts CAPTION', async () => {
    const event = buildCaptionEvent({
      action: 'broadcastCaption',
      eventId: 'evt_1',
      data: { text: 'Hello everyone', language: 'en', isFinal: true },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    expect(mockBroadcast).toHaveBeenCalledWith('evt_1', expect.objectContaining({
      type: 'CAPTION',
      data: expect.objectContaining({ text: 'Hello everyone', language: 'en' }),
    }));
  });

  it('still accepts top-level fields (legacy shape)', async () => {
    const event = buildCaptionEvent({
      action: 'broadcastCaption',
      eventId: 'evt_1',
      text: 'Top level',
      language: 'en',
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it('rejects captions with no text', async () => {
    const event = buildCaptionEvent({
      action: 'broadcastCaption',
      eventId: 'evt_1',
      data: { language: 'en' },
    });

    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('rejects captions from non-presenters', async () => {
    const event = buildCaptionEvent({
      action: 'broadcastCaption',
      eventId: 'evt_1',
      data: { text: 'sneaky', language: 'en' },
    }, 'conn-attendee');

    const result = await handler(event);
    expect(result.statusCode).toBe(403);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
