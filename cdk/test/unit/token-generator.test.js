'use strict';

// Mock AWS SDK clients
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
}));
jest.mock('@aws-sdk/client-ivs-realtime', () => ({
  IVSRealTimeClient: jest.fn(() => ({ send: mockIvsRealTimeSend })),
  CreateParticipantTokenCommand: jest.fn((params) => ({ type: 'CreateParticipantToken', params })),
}));
jest.mock('@aws-sdk/client-ivschat', () => ({
  IvschatClient: jest.fn(() => ({ send: mockIvsChatSend })),
  CreateChatTokenCommand: jest.fn((params) => ({ type: 'CreateChatToken', params })),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';

const { handler } = require('../../lambda/token-generator/index');

function buildEvent({ method, resource, pathParameters, claims }) {
  const event = {
    httpMethod: method,
    resource,
    pathParameters: pathParameters || null,
    requestContext: {},
  };
  if (claims) {
    event.requestContext.authorizer = { claims };
  }
  return event;
}

const validClaims = {
  sub: 'user-123',
  email: 'test@example.com',
  'custom:displayName': 'Test User',
  email_verified: 'true',
};

const liveEvent = {
  PK: 'EVENT#evt_abc',
  SK: 'METADATA',
  eventId: 'evt_abc',
  title: 'Test Event',
  status: 'live',
  ownerUserId: 'owner-456',
  stageArn: 'arn:aws:ivs:us-east-1:123456789:stage/test-stage',
  chatRoomArn: 'arn:aws:ivschat:us-east-1:123456789:room/test-room',
};

const stageTokenResponse = {
  participantToken: {
    token: 'stage-token-abc123',
    participantId: 'participant-xyz',
    expirationTime: '2024-12-31T23:59:59Z',
  },
};

const chatTokenResponse = {
  token: 'chat-token-def456',
  sessionExpirationTime: '2024-12-31T23:59:59Z',
  tokenExpirationTime: '2024-12-31T12:00:00Z',
};

describe('Token Generator Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /events/{id}/join - Join Event', () => {
    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 403 when email is not verified (string "false")', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: { ...validClaims, email_verified: 'false' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Email verification required');
    });

    it('returns 403 when email_verified claim is missing', async () => {
      const claimsWithoutVerified = { ...validClaims };
      delete claimsWithoutVerified.email_verified;

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: claimsWithoutVerified,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Email verification required');
    });

    it('allows access when email_verified is boolean true', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      mockDdbSend.mockResolvedValueOnce({ Item: undefined }); // ban check
      mockDdbSend.mockResolvedValueOnce({ Items: [] }); // connection
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: { ...validClaims, email_verified: true },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });

    it('allows access when email_verified is string "true"', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      mockDdbSend.mockResolvedValueOnce({ Item: undefined }); // ban check
      mockDdbSend.mockResolvedValueOnce({ Items: [] }); // connection
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: { ...validClaims, email_verified: 'true' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });

    it('returns 400 when event ID is missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: null,
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID is required');
    });

    it('returns 404 when event not found', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_nonexistent' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('returns 400 when event is not live', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: { ...liveEvent, status: 'scheduled' },
      });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('not currently live');
    });

    it('returns 403 when user is banned from the event', async () => {
      // GetCommand: fetch event (live)
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // GetCommand: ban check - ban exists
      mockDdbSend.mockResolvedValueOnce({
        Item: { PK: 'EVENT#evt_abc', SK: 'BAN#user-123', userId: 'user-123', bannedAt: '2024-01-01T00:00:00Z' },
      });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('You are banned from this event');
    });

    it('proceeds to generate tokens when user is not banned', async () => {
      // GetCommand: fetch event (live)
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // GetCommand: ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      // QueryCommand: find user connection
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: false }],
      });
      // IVS CreateParticipantToken
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      // IVS Chat CreateChatToken
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.stageToken.token).toBe('stage-token-abc123');
    });

    it('returns 500 when stageArn is missing', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: { ...liveEvent, stageArn: undefined },
      });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('streaming resources not available');
    });

    it('generates tokens for presenter with PUBLISH+SUBSCRIBE and DISCONNECT_USER', async () => {
      // GetCommand: fetch event
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // GetCommand: ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      // QueryCommand: find user connection (presenter)
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-123', role: 'presenter', hasSpeakPermission: false }],
      });
      // IVS CreateParticipantToken
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      // IVS Chat CreateChatToken
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.stageToken.token).toBe('stage-token-abc123');
      expect(body.chatToken.token).toBe('chat-token-def456');
      expect(body.capabilities.stage).toEqual(['PUBLISH', 'SUBSCRIBE']);
      expect(body.capabilities.chat).toEqual(['SEND_MESSAGE', 'DISCONNECT_USER']);
      expect(body.role).toBe('presenter');

      // Verify CreateParticipantToken was called with correct capabilities
      const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        stageArn: liveEvent.stageArn,
        userId: 'user-123',
        capabilities: ['PUBLISH', 'SUBSCRIBE'],
        duration: 720,
      }));

      // Verify CreateChatToken was called with correct capabilities
      const { CreateChatTokenCommand } = require('@aws-sdk/client-ivschat');
      expect(CreateChatTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        roomIdentifier: liveEvent.chatRoomArn,
        userId: 'user-123',
        capabilities: ['SEND_MESSAGE', 'DISCONNECT_USER'],
        sessionDurationInMinutes: 180,
      }));
    });

    it('generates tokens for co-presenter with PUBLISH+SUBSCRIBE and DISCONNECT_USER', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-2', eventId: 'evt_abc', userId: 'user-123', role: 'co-presenter', hasSpeakPermission: false }],
      });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.capabilities.stage).toEqual(['PUBLISH', 'SUBSCRIBE']);
      expect(body.capabilities.chat).toEqual(['SEND_MESSAGE', 'DISCONNECT_USER']);
      expect(body.role).toBe('co-presenter');
    });

    it('generates tokens for attendee with speak permission with PUBLISH+SUBSCRIBE', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-3', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: true }],
      });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.capabilities.stage).toEqual(['PUBLISH', 'SUBSCRIBE']);
      expect(body.capabilities.chat).toEqual(['SEND_MESSAGE']);
      expect(body.role).toBe('attendee');
    });

    it('generates tokens for regular attendee with SUBSCRIBE only', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-4', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: false }],
      });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.capabilities.stage).toEqual(['SUBSCRIBE']);
      expect(body.capabilities.chat).toEqual(['SEND_MESSAGE']);
      expect(body.role).toBe('attendee');
    });

    it('defaults to attendee role when no connection found', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      // No connection found
      mockDdbSend.mockResolvedValueOnce({ Items: [] });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.capabilities.stage).toEqual(['SUBSCRIBE']);
      expect(body.capabilities.chat).toEqual(['SEND_MESSAGE']);
      expect(body.role).toBe('attendee');
    });

    it('returns correct token structure in response', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: false }],
      });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      // Stage token structure
      expect(body.stageToken).toHaveProperty('token');
      expect(body.stageToken).toHaveProperty('participantId');
      expect(body.stageToken).toHaveProperty('expirationTime');
      // Chat token structure
      expect(body.chatToken).toHaveProperty('token');
      expect(body.chatToken).toHaveProperty('sessionExpirationTime');
      expect(body.chatToken).toHaveProperty('tokenExpirationTime');
      // Capabilities
      expect(body.capabilities).toHaveProperty('stage');
      expect(body.capabilities).toHaveProperty('chat');
      // Role
      expect(body).toHaveProperty('role');
    });

    it('passes displayName as attribute to IVS tokens', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: false }],
      });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockResolvedValueOnce(chatTokenResponse);

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      await handler(event);

      const { CreateParticipantTokenCommand } = require('@aws-sdk/client-ivs-realtime');
      expect(CreateParticipantTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        attributes: expect.objectContaining({
          displayName: 'test@example.com',
          role: 'attendee',
        }),
      }));

      const { CreateChatTokenCommand } = require('@aws-sdk/client-ivschat');
      expect(CreateChatTokenCommand).toHaveBeenCalledWith(expect.objectContaining({
        attributes: expect.objectContaining({
          displayName: 'test@example.com',
          role: 'attendee',
        }),
      }));
    });
  });

  describe('Unsupported routes', () => {
    it('returns 400 for unsupported method/resource', async () => {
      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Unsupported route');
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
    });

    it('returns 500 when IVS stage token creation fails', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: false }],
      });
      mockIvsRealTimeSend.mockRejectedValueOnce(new Error('IVS error'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
    });

    it('returns 500 when IVS chat token creation fails', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: liveEvent });
      // Ban check - no ban
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc', userId: 'user-123', role: 'attendee', hasSpeakPermission: false }],
      });
      mockIvsRealTimeSend.mockResolvedValueOnce(stageTokenResponse);
      mockIvsChatSend.mockRejectedValueOnce(new Error('IVS Chat error'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/join',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
    });
  });
});
