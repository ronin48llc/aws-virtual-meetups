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
  PutCommand: jest.fn((params) => ({ type: 'Put', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
}));

// Mock Lambda client for email invocation
const mockLambdaSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
}));

// Mock scheduler-utils
const mockCreateReminderSchedules = jest.fn().mockResolvedValue(undefined);
const mockDeleteReminderSchedules = jest.fn().mockResolvedValue(undefined);
jest.mock('../../lambda/shared/scheduler-utils', () => ({
  createReminderSchedules: mockCreateReminderSchedules,
  deleteReminderSchedules: mockDeleteReminderSchedules,
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';
process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:VirtualMeetup-EmailSender';
process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/VirtualMeetup-SchedulerRole';

const { handler } = require('../../lambda/event-crud/index');

function buildEvent({ method, resource, body, pathParameters, claims }) {
  const event = {
    httpMethod: method,
    resource,
    body: body ? JSON.stringify(body) : null,
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
  'custom:role': 'organizer',
};

const futureDate = new Date(Date.now() + 86400000).toISOString();

describe('Event CRUD Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLambdaSend.mockResolvedValue({});
    mockCreateReminderSchedules.mockResolvedValue(undefined);
    mockDeleteReminderSchedules.mockResolvedValue(undefined);
  });

  describe('POST /events - Create Event', () => {
    it('creates an event with valid data and returns 201', async () => {
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: { title: 'Test Event', description: 'A test', scheduledStart: futureDate },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.eventId).toMatch(/^evt_/);
      expect(body.title).toBe('Test Event');
      expect(body.description).toBe('A test');
      expect(body.scheduledStart).toBe(futureDate);
      expect(body.status).toBe('scheduled');
      expect(body.url).toBe(`/events/${body.eventId}`);
      expect(body.ownerUserId).toBe('user-123');
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: { title: 'Test', description: 'Desc', scheduledStart: futureDate },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 400 when required fields are missing', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: { title: 'Test' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Missing required fields');
    });

    it('returns 400 when scheduledStart is in the past', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: { title: 'Test', description: 'Desc', scheduledStart: pastDate },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('future');
    });

    it('returns 400 when scheduledStart is invalid', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: { title: 'Test', description: 'Desc', scheduledStart: 'not-a-date' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('valid ISO 8601');
    });

    it('returns 400 when body is empty', async () => {
      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    describe('length bounds (issue #32)', () => {
      it('rejects title longer than 200 chars with 400', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events',
          body: {
            title: 'x'.repeat(201),
            description: 'ok',
            scheduledStart: futureDate,
          },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toMatch(/title/);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('accepts title exactly at the 200-char cap', async () => {
        mockSend.mockResolvedValueOnce({});
        const event = buildEvent({
          method: 'POST',
          resource: '/events',
          body: {
            title: 'x'.repeat(200),
            description: 'ok',
            scheduledStart: futureDate,
          },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(201);
      });

      it('rejects description longer than 5000 chars with 400', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events',
          body: {
            title: 'ok',
            description: 'x'.repeat(5001),
            scheduledStart: futureDate,
          },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toMatch(/description/);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('rejects empty title (zero-length after trim) with 400', async () => {
        const event = buildEvent({
          method: 'POST',
          resource: '/events',
          body: {
            title: '   ',
            description: 'ok',
            scheduledStart: futureDate,
          },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
      });
    });
  });

  describe('GET /events - List Events', () => {
    it('returns upcoming events sorted by start time', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            eventId: 'evt_001',
            title: 'Event 1',
            description: 'Desc 1',
            scheduledStart: '2025-06-01T10:00:00Z',
            status: 'scheduled',
            url: '/events/evt_001',
            ownerUserId: 'user-1',
            createdAt: '2025-01-01T00:00:00Z',
          },
          {
            eventId: 'evt_002',
            title: 'Event 2',
            description: 'Desc 2',
            scheduledStart: '2025-07-01T10:00:00Z',
            status: 'scheduled',
            url: '/events/evt_002',
            ownerUserId: 'user-2',
            createdAt: '2025-01-02T00:00:00Z',
          },
        ],
      });

      const event = buildEvent({ method: 'GET', resource: '/events' });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.events).toHaveLength(2);
      expect(body.events[0].eventId).toBe('evt_001');
      expect(body.events[1].eventId).toBe('evt_002');
    });

    it('returns empty list when no upcoming events', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const event = buildEvent({ method: 'GET', resource: '/events' });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.events).toEqual([]);
    });

    it('does not require authentication', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const event = buildEvent({ method: 'GET', resource: '/events' });
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('GET /events/{id} - Get Event', () => {
    it('returns event details for a valid ID', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          title: 'My Event',
          description: 'Description',
          scheduledStart: futureDate,
          status: 'scheduled',
          url: '/events/evt_abc',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.eventId).toBe('evt_abc');
      expect(body.title).toBe('My Event');
    });

    it('returns 404 when event not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_nonexistent' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('does not require authentication', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          title: 'My Event',
          description: 'Description',
          scheduledStart: futureDate,
          status: 'scheduled',
          url: '/events/evt_abc',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });

    it('returns displayMode "signup" and countdown for scheduled events', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          title: 'My Event',
          description: 'Description',
          scheduledStart: futureDate,
          status: 'scheduled',
          url: '/events/evt_abc',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.displayMode).toBe('signup');
      expect(body.countdown).toBeGreaterThan(0);
      expect(body.title).toBe('My Event');
      expect(body.scheduledStart).toBe(futureDate);
    });

    it('returns displayMode "live" for live events without countdown', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_live',
          title: 'Live Event',
          description: 'Currently live',
          scheduledStart: '2025-01-01T10:00:00Z',
          status: 'live',
          url: '/events/evt_live',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T10:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_live' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.displayMode).toBe('live');
      expect(body.countdown).toBeUndefined();
    });

    it('returns displayMode "ended" for ended events', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_ended',
          title: 'Ended Event',
          description: 'This event has ended',
          scheduledStart: '2025-01-01T10:00:00Z',
          status: 'ended',
          url: '/events/evt_ended',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T12:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_ended' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.displayMode).toBe('ended');
      expect(body.countdown).toBeUndefined();
    });

    it('returns displayMode "ended" with recordingUrl for ended events with recording', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_recorded',
          title: 'Recorded Event',
          description: 'Has a recording',
          scheduledStart: '2025-01-01T10:00:00Z',
          status: 'ended',
          url: '/events/evt_recorded',
          ownerUserId: 'user-123',
          hlsPlaybackUrl: 'https://cdn.example.com/recordings/evt_recorded/master.m3u8',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T12:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_recorded' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.displayMode).toBe('ended');
      expect(body.recordingUrl).toBe('https://cdn.example.com/recordings/evt_recorded/master.m3u8');
    });

    it('returns displayMode "cancelled" for cancelled events', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_cancelled',
          title: 'Cancelled Event',
          description: 'This was cancelled',
          scheduledStart: '2025-06-01T10:00:00Z',
          status: 'cancelled',
          url: '/events/evt_cancelled',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-05T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_cancelled' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.displayMode).toBe('cancelled');
      expect(body.countdown).toBeUndefined();
    });

    it('returns countdown of 0 when scheduled start has passed but status is still scheduled', async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_past',
          title: 'Past Scheduled',
          description: 'Start time passed',
          scheduledStart: pastDate,
          status: 'scheduled',
          url: '/events/evt_past',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'GET',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_past' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.displayMode).toBe('signup');
      expect(body.countdown).toBe(0);
    });
  });

  describe('PUT /events/{id} - Update Event', () => {
    it('updates event metadata and preserves URL', async () => {
      // First call: GetCommand to verify ownership
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          ownerUserId: 'user-123',
          url: '/events/evt_abc',
        },
      });
      // Second call: UpdateCommand
      mockSend.mockResolvedValueOnce({
        Attributes: {
          eventId: 'evt_abc',
          title: 'Updated Title',
          description: 'Updated Desc',
          scheduledStart: futureDate,
          status: 'scheduled',
          url: '/events/evt_abc',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-15T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
        body: { title: 'Updated Title', description: 'Updated Desc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.title).toBe('Updated Title');
      expect(body.url).toBe('/events/evt_abc');
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
        body: { title: 'Updated' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 403 when not the owner', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          ownerUserId: 'other-user',
        },
      });

      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
        body: { title: 'Updated' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 404 when event not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_nonexistent' },
        body: { title: 'Updated' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('updates GSI sort keys when scheduledStart changes', async () => {
      const newFutureDate = new Date(Date.now() + 172800000).toISOString();
      mockSend.mockResolvedValueOnce({
        Item: { eventId: 'evt_abc', ownerUserId: 'user-123' },
      });
      mockSend.mockResolvedValueOnce({
        Attributes: {
          eventId: 'evt_abc',
          title: 'Event',
          description: 'Desc',
          scheduledStart: newFutureDate,
          status: 'scheduled',
          url: '/events/evt_abc',
          ownerUserId: 'user-123',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-15T00:00:00Z',
        },
      });

      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
        body: { scheduledStart: newFutureDate },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Verify UpdateCommand was called with GSI sort key updates
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      const updateCall = UpdateCommand.mock.calls[0][0];
      expect(updateCall.UpdateExpression).toContain('GSI1SK');
      expect(updateCall.UpdateExpression).toContain('GSI2SK');
    });

    describe('length bounds (issue #32)', () => {
      it('rejects too-long title on PUT with 400', async () => {
        mockSend.mockResolvedValueOnce({
          Item: { eventId: 'evt_abc', ownerUserId: 'user-123', status: 'scheduled' },
        });
        const event = buildEvent({
          method: 'PUT',
          resource: '/events/{id}',
          pathParameters: { id: 'evt_abc' },
          body: { title: 'x'.repeat(201) },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toMatch(/title/);
      });

      it('rejects too-long description on PUT with 400', async () => {
        mockSend.mockResolvedValueOnce({
          Item: { eventId: 'evt_abc', ownerUserId: 'user-123', status: 'scheduled' },
        });
        const event = buildEvent({
          method: 'PUT',
          resource: '/events/{id}',
          pathParameters: { id: 'evt_abc' },
          body: { description: 'x'.repeat(5001) },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).message).toMatch(/description/);
      });

      it('skips length validation when title/description are absent on PUT', async () => {
        mockSend.mockResolvedValueOnce({
          Item: { eventId: 'evt_abc', ownerUserId: 'user-123', status: 'scheduled', scheduledStart: futureDate },
        });
        mockSend.mockResolvedValueOnce({ Attributes: {} });
        const event = buildEvent({
          method: 'PUT',
          resource: '/events/{id}',
          pathParameters: { id: 'evt_abc' },
          body: { scheduledStart: futureDate },
          claims: validClaims,
        });
        const result = await handler(event);
        expect(result.statusCode).toBe(200);
      });
    });
  });

  describe('DELETE /events/{id} - Delete Event', () => {
    it('marks event as cancelled and removes from listing', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { eventId: 'evt_abc', ownerUserId: 'user-123' },
      });
      mockSend.mockResolvedValueOnce({});

      const event = buildEvent({
        method: 'DELETE',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.message).toBe('Event deleted');
      expect(body.eventId).toBe('evt_abc');
    });

    it('returns 401 when unauthenticated', async () => {
      const event = buildEvent({
        method: 'DELETE',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('returns 403 when not the owner', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { eventId: 'evt_abc', ownerUserId: 'other-user' },
      });

      const event = buildEvent({
        method: 'DELETE',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_abc' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(403);
    });

    it('returns 404 when event not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const event = buildEvent({
        method: 'DELETE',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_nonexistent' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });
  });

  describe('Unsupported routes', () => {
    it('returns 400 for unsupported method/resource', async () => {
      const event = buildEvent({ method: 'PATCH', resource: '/events' });
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB failure'));

      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: { title: 'Test', description: 'Desc', scheduledStart: futureDate },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
    });
  });
});
