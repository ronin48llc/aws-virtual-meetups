'use strict';

// Mock AWS SDK
const mockSend = jest.fn();
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:VirtualMeetup-EmailSender';

const { handler } = require('../../lambda/signup/index');

function buildEvent({ method, resource, body, pathParameters, queryStringParameters, claims }) {
  const event = {
    httpMethod: method,
    resource,
    body: body ? JSON.stringify(body) : null,
    pathParameters: pathParameters || null,
    queryStringParameters: queryStringParameters || null,
    requestContext: {},
  };
  if (claims) {
    event.requestContext.authorizer = { claims };
  }
  return event;
}

const validClaims = {
  sub: 'user-123',
  email: 'user@example.com',
  'custom:displayName': 'Test User',
};

const ownerClaims = {
  sub: 'owner-456',
  email: 'owner@example.com',
  'custom:displayName': 'Event Owner',
};

const existingEvent = {
  eventId: 'evt_abc123',
  title: 'Test Event',
  description: 'A test event',
  scheduledStart: '2025-12-01T10:00:00Z',
  status: 'scheduled',
  ownerUserId: 'owner-456',
};

describe('Sign-Up Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLambdaSend.mockResolvedValue({});
  });

  describe('POST /events/{id}/signup - Register for Event', () => {
    it('registers a user for an event and returns 201', async () => {
      // First call: GetCommand to verify event exists
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      // Second call: PutCommand to store sign-up
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.message).toBe('Successfully registered for event');
      expect(body.eventId).toBe('evt_abc123');
      expect(body.userId).toBe('user-123');
      expect(body.displayName).toBe('Test User');
      expect(body.email).toBe('user@example.com');
      expect(body.registeredAt).toBeDefined();
    });

    it('stores sign-up with correct DynamoDB keys', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      await handler(event);

      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      expect(PutCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'TestTable',
          Item: expect.objectContaining({
            PK: 'EVENT#evt_abc123',
            SK: 'SIGNUP#user-123',
            userId: 'user-123',
            displayName: 'Test User',
            email: 'user@example.com',
          }),
        })
      );
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 404 when event does not exist', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_nonexistent' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('returns 400 when required fields are missing', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });

      // Issue #77: only displayName is required from the body now;
      // email comes from the JWT claims. So missing-displayName is the
      // single body-required-field case.
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: {},
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);

      const body = JSON.parse(result.body);
      expect(body.message).toContain('Missing required fields');
      expect(body.message).toContain('displayName');
    });

    it('returns 400 when authenticated user has no email claim (issue #77)', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User' },
        // Claims without email — shouldn't happen with Cognito, but guard anyway.
        claims: { sub: 'user-123', 'custom:role': 'organizer' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toMatch(/email claim/);
    });

    it('uses claims.email even when body.email differs (issue #77 — email-spam fix)', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'victim@example.com' }, // attacker
        claims: validClaims, // claims.email = 'user@example.com'
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      // The response (and downstream DDB write + email invocation) uses the
      // claim email, NOT the body email.
      expect(body.email).toBe('user@example.com');
      expect(body.email).not.toBe('victim@example.com');
    });

    it('returns 400 when body is empty', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('returns 400 when event ID is missing from path', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: null,
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Event ID is required');
    });
  });

  describe('POST /events/{id}/signup - Email Integration', () => {
    it('invokes email Lambda with signup-confirmation after successful sign-up', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      await handler(event);

      const { InvokeCommand } = require('@aws-sdk/client-lambda');
      expect(InvokeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          FunctionName: process.env.EMAIL_LAMBDA_ARN,
          InvocationType: 'Event',
        })
      );

      const invokeCall = InvokeCommand.mock.calls[0][0];
      const payload = JSON.parse(invokeCall.Payload);
      expect(payload.type).toBe('signup-confirmation');
      expect(payload.eventId).toBe('evt_abc123');
      expect(payload.recipientEmail).toBe('user@example.com');
      expect(payload.recipientName).toBe('Test User');
      expect(payload.eventTitle).toBe('Test Event');
      expect(payload.scheduledStart).toBe('2025-12-01T10:00:00Z');
      expect(payload.eventUrl).toBe('/events/evt_abc123');
    });

    it('does not block sign-up response when email Lambda invocation fails', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      mockSend.mockResolvedValueOnce({});
      mockLambdaSend.mockRejectedValueOnce(new Error('Lambda invoke failed'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.message).toBe('Successfully registered for event');
    });
  });

  describe('GET /events/{id}/signups - List Sign-Ups', () => {
    it('returns sign-ups for event owner', async () => {
      // First call: GetCommand to verify event and ownership
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      // Second call: QueryCommand to list sign-ups
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            PK: 'EVENT#evt_abc123',
            SK: 'SIGNUP#user-001',
            userId: 'user-001',
            displayName: 'Alice',
            email: 'alice@example.com',
            registeredAt: '2025-01-10T10:00:00Z',
          },
          {
            PK: 'EVENT#evt_abc123',
            SK: 'SIGNUP#user-002',
            userId: 'user-002',
            displayName: 'Bob',
            email: 'bob@example.com',
            registeredAt: '2025-01-11T10:00:00Z',
          },
        ],
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/signups',
        pathParameters: { id: 'evt_abc123' },
        claims: ownerClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.eventId).toBe('evt_abc123');
      expect(body.signups).toHaveLength(2);
      expect(body.count).toBe(2);
      expect(body.signups[0].userId).toBe('user-001');
      expect(body.signups[0].displayName).toBe('Alice');
      expect(body.signups[0].email).toBe('alice@example.com');
      expect(body.signups[0].registeredAt).toBe('2025-01-10T10:00:00Z');
      expect(body.signups[1].userId).toBe('user-002');
    });

    it('returns empty list when no sign-ups exist', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      mockSend.mockResolvedValueOnce({ Items: [] });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/signups',
        pathParameters: { id: 'evt_abc123' },
        claims: ownerClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.signups).toEqual([]);
      expect(body.count).toBe(0);
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/signups',
        pathParameters: { id: 'evt_abc123' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 403 when not the event owner', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/signups',
        pathParameters: { id: 'evt_abc123' },
        claims: validClaims, // user-123, not the owner (owner-456)
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);

      const body = JSON.parse(result.body);
      expect(body.message).toContain('event owner');
    });

    it('returns 404 when event does not exist', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/signups',
        pathParameters: { id: 'evt_nonexistent' },
        claims: ownerClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('queries DynamoDB with correct key condition', async () => {
      mockSend.mockResolvedValueOnce({ Item: existingEvent });
      mockSend.mockResolvedValueOnce({ Items: [] });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}/signups',
        pathParameters: { id: 'evt_abc123' },
        claims: ownerClaims,
      });

      await handler(event);

      const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
      expect(QueryCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'TestTable',
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': 'EVENT#evt_abc123',
            ':skPrefix': 'SIGNUP#',
          },
        })
      );
    });

    describe('pagination (issue #56)', () => {
      function lastQueryParams() {
        for (let i = mockSend.mock.calls.length - 1; i >= 0; i--) {
          const cmd = mockSend.mock.calls[i][0];
          if (cmd && cmd.type === 'Query') return cmd.params;
        }
        throw new Error('no QueryCommand was issued');
      }

      it('applies a default Limit of 100 when none is supplied', async () => {
        mockSend.mockResolvedValueOnce({ Item: existingEvent });
        mockSend.mockResolvedValueOnce({ Items: [] });
        const event = buildEvent({
          method: 'GET',
          resource: '/events/{id}/signups',
          pathParameters: { id: 'evt_abc123' },
          claims: ownerClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(200);
        expect(lastQueryParams().Limit).toBe(100);
      });

      it('honors an explicit ?limit within the cap', async () => {
        mockSend.mockResolvedValueOnce({ Item: existingEvent });
        mockSend.mockResolvedValueOnce({ Items: [] });
        const event = buildEvent({
          method: 'GET',
          resource: '/events/{id}/signups',
          pathParameters: { id: 'evt_abc123' },
          queryStringParameters: { limit: '25' },
          claims: ownerClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(200);
        expect(lastQueryParams().Limit).toBe(25);
      });

      it('rejects ?limit above the cap with 400', async () => {
        mockSend.mockResolvedValueOnce({ Item: existingEvent });
        const event = buildEvent({
          method: 'GET',
          resource: '/events/{id}/signups',
          pathParameters: { id: 'evt_abc123' },
          queryStringParameters: { limit: '99999' },
          claims: ownerClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
      });

      it('rejects non-positive-integer ?limit with 400', async () => {
        for (const bad of ['0', 'abc', '-1', '1.5']) {
          mockSend.mockClear();
          mockSend.mockResolvedValueOnce({ Item: existingEvent });
          const event = buildEvent({
            method: 'GET',
            resource: '/events/{id}/signups',
            pathParameters: { id: 'evt_abc123' },
            queryStringParameters: { limit: bad },
            claims: ownerClaims,
          });
          const result = await handler(event);
          expect(result.statusCode).toBe(400);
        }
      });

      it('returns nextCursor when DynamoDB returns a LastEvaluatedKey', async () => {
        const lastKey = { PK: 'EVENT#evt_abc123', SK: 'SIGNUP#user-100' };
        mockSend.mockResolvedValueOnce({ Item: existingEvent });
        mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });

        const event = buildEvent({
          method: 'GET',
          resource: '/events/{id}/signups',
          pathParameters: { id: 'evt_abc123' },
          claims: ownerClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(typeof body.nextCursor).toBe('string');
        const decoded = JSON.parse(Buffer.from(body.nextCursor, 'base64url').toString('utf8'));
        expect(decoded).toEqual(lastKey);
      });

      it('forwards a valid ?cursor as ExclusiveStartKey on the Query', async () => {
        const startKey = { PK: 'EVENT#evt_abc123', SK: 'SIGNUP#user-050' };
        const cursor = Buffer.from(JSON.stringify(startKey), 'utf8').toString('base64url');
        mockSend.mockResolvedValueOnce({ Item: existingEvent });
        mockSend.mockResolvedValueOnce({ Items: [] });

        const event = buildEvent({
          method: 'GET',
          resource: '/events/{id}/signups',
          pathParameters: { id: 'evt_abc123' },
          queryStringParameters: { cursor },
          claims: ownerClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(200);
        expect(lastQueryParams().ExclusiveStartKey).toEqual(startKey);
      });

      it('rejects a malformed ?cursor with 400', async () => {
        mockSend.mockResolvedValueOnce({ Item: existingEvent });
        const event = buildEvent({
          method: 'GET',
          resource: '/events/{id}/signups',
          pathParameters: { id: 'evt_abc123' },
          queryStringParameters: { cursor: 'not-valid!!!' },
          claims: ownerClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
      });
    });
  });

  describe('Unsupported routes', () => {
    it('returns 400 for unsupported method/resource', async () => {
      const event = buildEvent({
        method: 'DELETE',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected DynamoDB errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);

      const body = JSON.parse(result.body);
      expect(body.error).toBe('Internal Server Error');
    });
  });

  // This test uses jest.resetModules() so it must run last to avoid corrupting mock state
  describe('POST /events/{id}/signup - Email Lambda ARN not configured', () => {
    it('does not invoke email Lambda when EMAIL_LAMBDA_ARN is not set', async () => {
      const originalArn = process.env.EMAIL_LAMBDA_ARN;
      delete process.env.EMAIL_LAMBDA_ARN;

      jest.resetModules();
      jest.mock('@aws-sdk/client-dynamodb', () => ({
        DynamoDBClient: jest.fn(() => ({})),
      }));
      const mockSendLocal = jest.fn();
      jest.mock('@aws-sdk/lib-dynamodb', () => ({
        DynamoDBDocumentClient: {
          from: jest.fn(() => ({ send: mockSendLocal })),
        },
        PutCommand: jest.fn((params) => ({ type: 'Put', params })),
        GetCommand: jest.fn((params) => ({ type: 'Get', params })),
        QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
      }));
      const mockLambdaSendLocal = jest.fn();
      jest.mock('@aws-sdk/client-lambda', () => ({
        LambdaClient: jest.fn(() => ({ send: mockLambdaSendLocal })),
        InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
      }));

      const { handler: handlerLocal } = require('../../lambda/signup/index');

      mockSendLocal.mockResolvedValueOnce({ Item: existingEvent });
      mockSendLocal.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events/{id}/signup',
        pathParameters: { id: 'evt_abc123' },
        body: { displayName: 'Test User', email: 'user@example.com' },
        claims: validClaims,
      });

      const result = await handlerLocal(event);
      expect(result.statusCode).toBe(201);
      expect(mockLambdaSendLocal).not.toHaveBeenCalled();

      process.env.EMAIL_LAMBDA_ARN = originalArn;
    });
  });
});
