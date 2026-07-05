'use strict';

// Attendance tracking at join time. Walk-ins get a signup record with
// source:'auto-join' AND attendedAt; pre-registered RSVPs get attendedAt
// stamped on their existing record (if_not_exists keeps the first join).
// This is what powers the organizer's show-rate stats — without it, RSVP
// no-shows and attendees are indistinguishable.
//
// Separate file from token-generator.test.js: that file's lib-dynamodb mock
// deliberately omits Put/Update (its Once-queues predate auto-register), so
// exercising the write path there would shift every queued mock.

const mockDdbSend = jest.fn();
const mockIvsRealTimeSend = jest.fn();
const mockIvsChatSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDdbSend })),
  },
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
}));
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsRealTimeSend })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
}));
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: mockIvsChatSend })),
  CreateChatTokenCommand: jest.fn((params) => ({ type: 'CreateChatToken', params })),
}));

process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';

const { handler } = require('../../lambda/token-generator/index');

const liveEvent = {
  PK: 'EVENT#evt_abc',
  SK: 'METADATA',
  status: 'live',
  ownerUserId: 'owner-1',
  stageArn: 'arn:aws:ivs:us-east-1:123456789:stage/test-stage',
  chatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/test-room',
};

function buildJoinEvent() {
  return {
    httpMethod: 'POST',
    resource: '/events/{id}/join',
    pathParameters: { id: 'evt_abc' },
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: 'user-9', email: 'jane.doe@example.com', name: 'Jane Doe', email_verified: 'true' } },
      },
    },
  };
}

function queueTokenResponses() {
  mockIvsRealTimeSend.mockResolvedValueOnce({
    participantToken: { token: 'stage-token', participantId: 'p1', expirationTime: new Date() },
  });
  mockIvsChatSend.mockResolvedValueOnce({
    token: 'chat-token', sessionExpirationTime: new Date(), tokenExpirationTime: new Date(),
  });
}

describe('join-time attendance tracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDdbSend.mockReset();
    mockIvsRealTimeSend.mockReset();
    mockIvsChatSend.mockReset();
  });

  it('walk-ins get a signup record with source auto-join AND attendedAt', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });   // event
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });   // ban check
    mockDdbSend.mockResolvedValue({});                        // auto-register put + rest
    queueTokenResponses();

    const result = await handler(buildJoinEvent());
    expect(result.statusCode).toBe(200);

    const put = mockDdbSend.mock.calls.map((c) => c[0]).find((cmd) => cmd && cmd.type === 'Put');
    expect(put).toBeDefined();
    expect(put.params.Item.source).toBe('auto-join');
    expect(put.params.Item.attendedAt).toBeDefined();
    // Privacy: the record's displayName is the name claim, not the email.
    expect(put.params.Item.displayName).toBe('Jane Doe');
  });

  it('pre-registered RSVPs get attendedAt stamped via if_not_exists on join', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });   // event
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });   // ban check
    const condFail = new Error('exists');
    condFail.name = 'ConditionalCheckFailedException';
    mockDdbSend.mockRejectedValueOnce(condFail);              // auto-register put — already RSVP'd
    mockDdbSend.mockResolvedValue({});                        // attendance update + rest
    queueTokenResponses();

    const result = await handler(buildJoinEvent());
    expect(result.statusCode).toBe(200);

    const update = mockDdbSend.mock.calls.map((c) => c[0]).find((cmd) => cmd && cmd.type === 'Update');
    expect(update).toBeDefined();
    expect(update.params.UpdateExpression).toContain('if_not_exists(attendedAt');
  });
});
