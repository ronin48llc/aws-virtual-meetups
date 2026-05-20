'use strict';

// Regression test for issue #85: the WS getAttendeeList response, and the
// ATTENDEE_JOINED broadcast triggered on $connect, must NOT include any
// attendee's email address. Public to any participant; a leak would let
// any attendee harvest the full event's email list.

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  BatchWriteCommand: jest.fn((params) => ({ type: 'BatchWrite', params })),
}));

const mockApiSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiSend })),
  PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
}));

const mockBroadcast = jest.fn().mockResolvedValue({ sent: 0, failed: 0, cleaned: 0 });
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

process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
process.env.WEBSOCKET_ENDPOINT = 'https://test.example.com/prod';

const { handler: signalingHandler } = require('../../lambda/websocket/signaling');
const { handler: connectHandler } = require('../../lambda/websocket/connect');

describe('Attendee list / ATTENDEE_JOINED — no email leak (issue #85)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApiSend.mockResolvedValue({});
    mockBroadcast.mockResolvedValue({ sent: 0, failed: 0, cleaned: 0 });
  });

  test('getAttendeeList response carries no email field for any attendee', async () => {
    mockGetConnectionsForEvent.mockResolvedValueOnce([
      { connectionId: 'conn-a', userId: 'user-a', displayName: 'Alice', email: 'alice@example.com', role: 'attendee', eventId: 'evt_x' },
      { connectionId: 'conn-b', userId: 'user-b', displayName: 'Bob',   email: 'bob@example.com',   role: 'presenter', eventId: 'evt_x' },
    ]);

    const event = {
      requestContext: { connectionId: 'conn-caller' },
      body: JSON.stringify({ action: 'getAttendeeList', eventId: 'evt_x' }),
    };
    const result = await signalingHandler(event);
    expect(result.statusCode).toBe(200);

    const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
    const sent = JSON.parse(PostToConnectionCommand.mock.calls[0][0].Data);
    expect(sent.type).toBe('ATTENDEE_LIST');
    expect(sent.data.attendees).toHaveLength(2);
    for (const att of sent.data.attendees) {
      expect(att).not.toHaveProperty('email');
      expect(att.displayName).toBeTruthy(); // displayName still present
    }
  });

  test('$connect ATTENDEE_JOINED broadcast carries no email field', async () => {
    // Ban check — no ban
    mockSend.mockResolvedValueOnce({ Item: undefined });
    // EventConnections Query — no existing connections
    mockSend.mockResolvedValueOnce({ Items: [] });
    // PutCommand — store new connection
    mockSend.mockResolvedValueOnce({});

    const event = {
      requestContext: { connectionId: 'conn-new' },
      queryStringParameters: {
        token: 'jwt',
        eventId: 'evt_x',
        userId: 'user-new',
        displayName: 'Newcomer',
        email: 'newcomer@example.com',
        role: 'attendee',
      },
    };

    const result = await connectHandler(event);
    expect(result.statusCode).toBe(200);

    // Inspect the broadcast call — must NOT carry email.
    expect(mockBroadcast).toHaveBeenCalledWith(
      'evt_x',
      expect.objectContaining({
        type: 'ATTENDEE_JOINED',
        data: expect.objectContaining({
          userId: 'user-new',
          displayName: 'Newcomer',
          role: 'attendee',
          connectionId: 'conn-new',
        }),
      }),
      expect.anything(),
    );
    const broadcastCall = mockBroadcast.mock.calls[0][1];
    expect(broadcastCall.data).not.toHaveProperty('email');
  });
});
