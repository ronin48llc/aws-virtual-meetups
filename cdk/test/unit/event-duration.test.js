'use strict';

/**
 * Unit tests for Event Duration feature.
 * Covers: duration computation/validation, event-crud integration,
 * auto-stop/warning handlers, extend endpoint, and email template rendering.
 */

// ============================================================
// Section 1: Duration Computation and Validation Tests (Task 13.1)
// ============================================================

describe('Duration Computation and Validation', () => {
  // Import directly — no mocking needed for pure utility functions
  const { computeDurationFields, validateDurationFields } = require('../../lambda/shared/validation');

  describe('computeDurationFields', () => {
    const scheduledStart = '2024-06-15T10:00:00.000Z';

    it('computes scheduledEnd from durationMinutes = 30', () => {
      const result = computeDurationFields(scheduledStart, { durationMinutes: 30 });
      expect(result).not.toBeNull();
      expect(result.durationMinutes).toBe(30);
      expect(result.scheduledEnd).toBe('2024-06-15T10:30:00.000Z');
    });

    it('computes scheduledEnd from durationMinutes = 60', () => {
      const result = computeDurationFields(scheduledStart, { durationMinutes: 60 });
      expect(result).not.toBeNull();
      expect(result.durationMinutes).toBe(60);
      expect(result.scheduledEnd).toBe('2024-06-15T11:00:00.000Z');
    });

    it('computes scheduledEnd from durationMinutes = 480 (max)', () => {
      const result = computeDurationFields(scheduledStart, { durationMinutes: 480 });
      expect(result).not.toBeNull();
      expect(result.durationMinutes).toBe(480);
      expect(result.scheduledEnd).toBe('2024-06-15T18:00:00.000Z');
    });

    it('computes durationMinutes from scheduledEnd', () => {
      const result = computeDurationFields(scheduledStart, { scheduledEnd: '2024-06-15T11:30:00.000Z' });
      expect(result).not.toBeNull();
      expect(result.scheduledEnd).toBe('2024-06-15T11:30:00.000Z');
      expect(result.durationMinutes).toBe(90);
    });

    it('returns null for open-ended events (no duration fields)', () => {
      const result = computeDurationFields(scheduledStart, {});
      expect(result).toBeNull();
    });

    it('returns null when both fields are undefined', () => {
      const result = computeDurationFields(scheduledStart, { title: 'Test' });
      expect(result).toBeNull();
    });

    it('throws ValidationError when both scheduledEnd and durationMinutes are provided', () => {
      expect(() => {
        computeDurationFields(scheduledStart, {
          scheduledEnd: '2024-06-15T11:00:00.000Z',
          durationMinutes: 60,
        });
      }).toThrow('Only one of scheduledEnd or durationMinutes may be provided');
    });

    it('thrown error has name ValidationError', () => {
      try {
        computeDurationFields(scheduledStart, {
          scheduledEnd: '2024-06-15T11:00:00.000Z',
          durationMinutes: 60,
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err.name).toBe('ValidationError');
      }
    });
  });

  describe('validateDurationFields', () => {
    const scheduledStart = '2024-06-15T10:00:00.000Z';

    it('accepts valid scheduledEnd and durationMinutes', () => {
      const result = validateDurationFields('2024-06-15T11:00:00.000Z', 60, scheduledStart);
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('accepts minimum durationMinutes = 1', () => {
      const result = validateDurationFields('2024-06-15T10:01:00.000Z', 1, scheduledStart);
      expect(result.valid).toBe(true);
    });

    it('accepts maximum durationMinutes = 480', () => {
      const result = validateDurationFields('2024-06-15T18:00:00.000Z', 480, scheduledStart);
      expect(result.valid).toBe(true);
    });

    it('rejects scheduledEnd that is not a valid ISO 8601 date', () => {
      const result = validateDurationFields('not-a-date', 60, scheduledStart);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('valid ISO 8601');
    });

    it('rejects scheduledEnd that is before scheduledStart', () => {
      const result = validateDurationFields('2024-06-15T09:00:00.000Z', 60, scheduledStart);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('after scheduledStart');
    });

    it('rejects scheduledEnd that equals scheduledStart', () => {
      const result = validateDurationFields(scheduledStart, 0, scheduledStart);
      expect(result.valid).toBe(false);
    });

    it('rejects durationMinutes = 0', () => {
      const result = validateDurationFields('2024-06-15T11:00:00.000Z', 0, scheduledStart);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('positive integer');
    });

    it('rejects negative durationMinutes', () => {
      const result = validateDurationFields('2024-06-15T11:00:00.000Z', -10, scheduledStart);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('positive integer');
    });

    it('rejects durationMinutes exceeding 480', () => {
      const result = validateDurationFields('2024-06-16T10:00:00.000Z', 481, scheduledStart);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('480');
    });

    it('rejects non-integer durationMinutes', () => {
      const result = validateDurationFields('2024-06-15T11:00:00.000Z', 30.5, scheduledStart);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('positive integer');
    });

    it('rejects null scheduledEnd', () => {
      const result = validateDurationFields(null, 60, scheduledStart);
      expect(result.valid).toBe(false);
    });
  });
});


// ============================================================
// Section 2: Event-CRUD Duration Integration Tests (Task 13.2)
// ============================================================

describe('Event-CRUD Duration Integration', () => {
  let handler;
  let mockSend;
  let mockLambdaSend;
  let mockCreateReminderSchedules;
  let mockDeleteReminderSchedules;
  let mockDeleteAutoStopSchedule;
  let mockDeleteWarningSchedules;

  beforeAll(() => {
    // Reset modules to get fresh mocks for this describe block
    jest.resetModules();

    mockSend = jest.fn();
    mockLambdaSend = jest.fn().mockResolvedValue({});
    mockCreateReminderSchedules = jest.fn().mockResolvedValue(undefined);
    mockDeleteReminderSchedules = jest.fn().mockResolvedValue(undefined);
    mockDeleteAutoStopSchedule = jest.fn().mockResolvedValue(undefined);
    mockDeleteWarningSchedules = jest.fn().mockResolvedValue(undefined);

    jest.doMock('@aws-sdk/client-dynamodb', () => ({
      DynamoDBClient: jest.fn(() => ({})),
    }));
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockSend })),
      },
      PutCommand: jest.fn((params) => ({ type: 'Put', params })),
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
    }));
    jest.doMock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
      InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
    }));
    jest.doMock('../../lambda/shared/scheduler-utils', () => ({
      createReminderSchedules: mockCreateReminderSchedules,
      deleteReminderSchedules: mockDeleteReminderSchedules,
      deleteAutoStopSchedule: mockDeleteAutoStopSchedule,
      deleteWarningSchedules: mockDeleteWarningSchedules,
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:EmailSender';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    handler = require('../../lambda/event-crud/index').handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLambdaSend.mockResolvedValue({});
  });

  const futureDate = '2099-06-15T10:00:00.000Z';
  const validClaims = {
    sub: 'user-123',
    email: 'test@example.com',
    'custom:role': 'organizer',
  };

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

  describe('Create event with scheduledEnd', () => {
    it('stores scheduledEnd and computes durationMinutes in response', async () => {
      mockSend.mockResolvedValueOnce({}); // PutCommand

      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: {
          title: 'Duration Event',
          description: 'Test',
          scheduledStart: futureDate,
          scheduledEnd: '2099-06-15T11:00:00.000Z',
        },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.scheduledEnd).toBe('2099-06-15T11:00:00.000Z');
      expect(body.durationMinutes).toBe(60);
    });
  });

  describe('Create event with durationMinutes', () => {
    it('computes scheduledEnd and stores durationMinutes in response', async () => {
      mockSend.mockResolvedValueOnce({}); // PutCommand

      const event = buildEvent({
        method: 'POST',
        resource: '/events',
        body: {
          title: 'Duration Event',
          description: 'Test',
          scheduledStart: futureDate,
          durationMinutes: 90,
        },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.durationMinutes).toBe(90);
      expect(body.scheduledEnd).toBe('2099-06-15T11:30:00.000Z');
    });
  });

  describe('Update with scheduledStart change triggering recomputation', () => {
    it('recomputes scheduledEnd when scheduledStart changes and event has durationMinutes', async () => {
      const newFutureDate = '2099-07-01T14:00:00.000Z';

      // GetCommand: existing event with durationMinutes
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          ownerUserId: 'user-123',
          scheduledStart: futureDate,
          scheduledEnd: '2099-06-15T11:30:00.000Z',
          durationMinutes: 90,
          status: 'scheduled',
        },
      });
      // UpdateCommand
      mockSend.mockResolvedValueOnce({
        Attributes: {
          eventId: 'evt_abc',
          title: 'Event',
          description: 'Desc',
          scheduledStart: newFutureDate,
          scheduledEnd: '2099-07-01T15:30:00.000Z',
          durationMinutes: 90,
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

      const body = JSON.parse(result.body);
      expect(body.scheduledEnd).toBe('2099-07-01T15:30:00.000Z');
      expect(body.durationMinutes).toBe(90);
    });
  });

  describe('Rejection of duration updates on live events', () => {
    it('returns 400 when updating scheduledEnd on a live event', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_live',
          ownerUserId: 'user-123',
          status: 'live',
          scheduledEnd: '2099-06-15T11:00:00.000Z',
          durationMinutes: 60,
        },
      });

      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_live' },
        body: { scheduledEnd: '2099-06-15T12:00:00.000Z' },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);

      const body = JSON.parse(result.body);
      expect(body.message).toContain('Cannot update duration on a live event');
      expect(body.message).toContain('extend');
    });

    it('returns 400 when updating durationMinutes on a live event', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_live',
          ownerUserId: 'user-123',
          status: 'live',
          scheduledEnd: '2099-06-15T11:00:00.000Z',
          durationMinutes: 60,
        },
      });

      const event = buildEvent({
        method: 'PUT',
        resource: '/events/{id}',
        pathParameters: { id: 'evt_live' },
        body: { durationMinutes: 120 },
        claims: validClaims,
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);

      const body = JSON.parse(result.body);
      expect(body.message).toContain('Cannot update duration on a live event');
    });
  });
});


// ============================================================
// Section 3: Auto-Stop and Warning Handler Tests (Task 13.3)
// ============================================================

describe('Auto-Stop and Warning Handlers', () => {
  let handler;
  let mockDdbSend;
  let mockApiGwSend;

  beforeAll(() => {
    jest.resetModules();

    mockDdbSend = jest.fn();
    mockApiGwSend = jest.fn().mockResolvedValue({});

    jest.doMock('@aws-sdk/client-dynamodb', () => ({
      DynamoDBClient: jest.fn(() => ({})),
    }));
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockDdbSend })),
      },
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
    }));
    jest.doMock('@aws-sdk/client-ivs-realtime', () => ({
      IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
      CreateStageCommand: jest.fn((params) => ({ type: 'CreateStage', params })),
      DeleteStageCommand: jest.fn((params) => ({ type: 'DeleteStage', params })),
      StartCompositionCommand: jest.fn((params) => ({ type: 'StartComposition', params })),
    }));
    jest.doMock('@aws-sdk/client-ivschat', () => ({
      IvschatClient: jest.fn(() => ({ send: jest.fn() })),
      CreateRoomCommand: jest.fn((params) => ({ type: 'CreateRoom', params })),
    }));
    jest.doMock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
      InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
    }));
    jest.doMock('@aws-sdk/client-apigatewaymanagementapi', () => ({
      ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiGwSend })),
      PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
    }));
    jest.doMock('../../lambda/shared/scheduler-utils', () => ({
      createAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      deleteAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      createWarningSchedules: jest.fn().mockResolvedValue(undefined),
      deleteWarningSchedules: jest.fn().mockResolvedValue(undefined),
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
    process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
    process.env.SESSION_MANAGER_ARN = 'arn:aws:lambda:us-east-1:123456789:function:SessionManager';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    handler = require('../../lambda/session-manager/index').handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiGwSend.mockResolvedValue({});
  });

  describe('handleAutoStop with live event', () => {
    it('stops the event and broadcasts EVENT_ENDED', async () => {
      // GetCommand: event is live
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'live',
          ownerUserId: 'user-123',
          scheduledEnd: '2099-06-15T11:00:00.000Z',
        },
      });
      // UpdateCommand: set status to ended
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: get connections for broadcast
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc' }],
      });

      const result = await handler({
        action: 'auto-stop',
        eventId: 'evt_abc',
      });

      expect(result.status).toBe('stopped');
      expect(result.eventId).toBe('evt_abc');
      expect(result.endedAt).toBeDefined();

      // Verify broadcast was sent
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleAutoStop with non-live event', () => {
    it('skips stop for ended event (no-op)', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'ended',
          ownerUserId: 'user-123',
        },
      });

      const result = await handler({
        action: 'auto-stop',
        eventId: 'evt_abc',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('not_live');
      // No UpdateCommand or broadcast should have been called
      expect(mockDdbSend).toHaveBeenCalledTimes(1); // Only the GetCommand
    });

    it('skips stop for scheduled event (stale trigger)', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'scheduled',
          ownerUserId: 'user-123',
        },
      });

      const result = await handler({
        action: 'auto-stop',
        eventId: 'evt_abc',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('not_live');
    });

    it('skips stop when event not found', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const result = await handler({
        action: 'auto-stop',
        eventId: 'evt_nonexistent',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('event_not_found');
    });
  });

  describe('handleTimeWarning', () => {
    it('broadcasts TIME_WARNING for 5min warning type', async () => {
      const futureEnd = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'live',
          scheduledEnd: futureEnd,
        },
      });
      // QueryCommand: get connections
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc' }],
      });

      const result = await handler({
        action: 'time-warning',
        eventId: 'evt_abc',
        warningType: '5min',
      });

      expect(result.status).toBe('warned');
      expect(result.messageType).toBe('TIME_WARNING');
      expect(result.warningType).toBe('5min');
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });

    it('broadcasts FINAL_WARNING for 1min warning type', async () => {
      const futureEnd = new Date(Date.now() + 1 * 60 * 1000).toISOString();
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'live',
          scheduledEnd: futureEnd,
        },
      });
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-2', eventId: 'evt_abc' }],
      });

      const result = await handler({
        action: 'time-warning',
        eventId: 'evt_abc',
        warningType: '1min',
      });

      expect(result.status).toBe('warned');
      expect(result.messageType).toBe('FINAL_WARNING');
      expect(result.warningType).toBe('1min');
    });

    it('skips warning for non-live event', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'ended',
          scheduledEnd: '2099-06-15T11:00:00.000Z',
        },
      });

      const result = await handler({
        action: 'time-warning',
        eventId: 'evt_abc',
        warningType: '5min',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('not_live');
    });
  });

  describe('Handler routing for direct invocation vs HTTP', () => {
    it('routes auto-stop action for direct invocation (no httpMethod)', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const result = await handler({
        action: 'auto-stop',
        eventId: 'evt_abc',
      });

      // Should be handled as auto-stop (skipped because event not found)
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('event_not_found');
    });

    it('routes time-warning action for direct invocation', async () => {
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const result = await handler({
        action: 'time-warning',
        eventId: 'evt_abc',
        warningType: '5min',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('event_not_found');
    });

    it('returns error for unknown direct invocation action', async () => {
      const result = await handler({
        action: 'unknown-action',
        eventId: 'evt_abc',
      });

      expect(result.status).toBe('error');
      expect(result.reason).toBe('unknown_action');
    });

    it('routes HTTP POST /events/{id}/extend as HTTP request', async () => {
      // This should be treated as an HTTP request, not a direct invocation
      mockDdbSend.mockResolvedValueOnce({ Item: undefined });

      const event = {
        httpMethod: 'POST',
        resource: '/events/{id}/extend',
        pathParameters: { id: 'evt_abc' },
        body: JSON.stringify({ additionalMinutes: 15 }),
        requestContext: {
          authorizer: {
            claims: { sub: 'user-123', email: 'test@example.com', 'custom:role': 'organizer' },
          },
        },
      };

      const result = await handler(event);
      // Should return 404 because event not found (not treated as direct invocation)
      expect(result.statusCode).toBe(404);
    });
  });
});


// ============================================================
// Section 4: Extend Endpoint Tests (Task 13.4)
// ============================================================

describe('Extend Event Duration Endpoint', () => {
  let handler;
  let mockDdbSend;
  let mockApiGwSend;
  let mockCreateAutoStopSchedule;
  let mockDeleteAutoStopSchedule;
  let mockCreateWarningSchedules;
  let mockDeleteWarningSchedules;

  beforeAll(() => {
    jest.resetModules();

    mockDdbSend = jest.fn();
    mockApiGwSend = jest.fn().mockResolvedValue({});
    mockCreateAutoStopSchedule = jest.fn().mockResolvedValue(undefined);
    mockDeleteAutoStopSchedule = jest.fn().mockResolvedValue(undefined);
    mockCreateWarningSchedules = jest.fn().mockResolvedValue(undefined);
    mockDeleteWarningSchedules = jest.fn().mockResolvedValue(undefined);

    jest.doMock('@aws-sdk/client-dynamodb', () => ({
      DynamoDBClient: jest.fn(() => ({})),
    }));
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockDdbSend })),
      },
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
    }));
    jest.doMock('@aws-sdk/client-ivs-realtime', () => ({
      IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
      CreateStageCommand: jest.fn((params) => ({ type: 'CreateStage', params })),
      DeleteStageCommand: jest.fn((params) => ({ type: 'DeleteStage', params })),
      StartCompositionCommand: jest.fn((params) => ({ type: 'StartComposition', params })),
    }));
    jest.doMock('@aws-sdk/client-ivschat', () => ({
      IvschatClient: jest.fn(() => ({ send: jest.fn() })),
      CreateRoomCommand: jest.fn((params) => ({ type: 'CreateRoom', params })),
    }));
    jest.doMock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
      InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
    }));
    jest.doMock('@aws-sdk/client-apigatewaymanagementapi', () => ({
      ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockApiGwSend })),
      PostToConnectionCommand: jest.fn((params) => ({ type: 'PostToConnection', params })),
    }));
    jest.doMock('../../lambda/shared/scheduler-utils', () => ({
      createAutoStopSchedule: mockCreateAutoStopSchedule,
      deleteAutoStopSchedule: mockDeleteAutoStopSchedule,
      createWarningSchedules: mockCreateWarningSchedules,
      deleteWarningSchedules: mockDeleteWarningSchedules,
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
    process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
    process.env.SESSION_MANAGER_ARN = 'arn:aws:lambda:us-east-1:123456789:function:SessionManager';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    handler = require('../../lambda/session-manager/index').handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiGwSend.mockResolvedValue({});
  });

  const validClaims = {
    sub: 'user-123',
    email: 'test@example.com',
    'custom:role': 'organizer',
  };

  function buildExtendEvent(eventId, body) {
    return {
      httpMethod: 'POST',
      resource: '/events/{id}/extend',
      pathParameters: { id: eventId },
      body: JSON.stringify(body),
      requestContext: {
        authorizer: { claims: validClaims },
      },
    };
  }

  describe('Extend happy path', () => {
    it('extends duration, updates DynamoDB, reschedules, and broadcasts', async () => {
      const currentEnd = '2099-06-15T11:00:00.000Z';

      // GetCommand: live event with duration
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'live',
          ownerUserId: 'user-123',
          scheduledEnd: currentEnd,
          durationMinutes: 60,
        },
      });
      // UpdateCommand
      mockDdbSend.mockResolvedValueOnce({});
      // QueryCommand: connections for broadcast
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc' }],
      });

      const event = buildExtendEvent('evt_abc', { additionalMinutes: 30 });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.eventId).toBe('evt_abc');
      expect(body.newScheduledEnd).toBe('2099-06-15T11:30:00.000Z');
      expect(body.additionalMinutes).toBe(30);
      expect(body.newDurationMinutes).toBe(90);
      expect(body.remainingSeconds).toBeGreaterThan(0);

      // Verify scheduler calls
      expect(mockDeleteAutoStopSchedule).toHaveBeenCalledWith('evt_abc');
      expect(mockDeleteWarningSchedules).toHaveBeenCalledWith('evt_abc');
      expect(mockCreateAutoStopSchedule).toHaveBeenCalledWith(
        'evt_abc',
        '2099-06-15T11:30:00.000Z',
        process.env.SESSION_MANAGER_ARN,
        process.env.SCHEDULER_ROLE_ARN
      );
      expect(mockCreateWarningSchedules).toHaveBeenCalledWith(
        'evt_abc',
        '2099-06-15T11:30:00.000Z',
        process.env.SESSION_MANAGER_ARN,
        process.env.SCHEDULER_ROLE_ARN
      );

      // Verify broadcast
      expect(mockApiGwSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('Extend validation', () => {
    it('rejects non-positive additionalMinutes (zero)', async () => {
      const event = buildExtendEvent('evt_abc', { additionalMinutes: 0 });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('additionalMinutes must be a positive integer');
    });

    it('rejects negative additionalMinutes', async () => {
      const event = buildExtendEvent('evt_abc', { additionalMinutes: -5 });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('additionalMinutes must be a positive integer');
    });

    it('rejects non-integer additionalMinutes', async () => {
      const event = buildExtendEvent('evt_abc', { additionalMinutes: 15.5 });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('additionalMinutes must be a positive integer');
    });

    it('rejects when total duration would exceed 480 minutes', async () => {
      // GetCommand: live event with 450 minutes already
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'live',
          ownerUserId: 'user-123',
          scheduledEnd: '2099-06-15T17:30:00.000Z',
          durationMinutes: 450,
        },
      });

      const event = buildExtendEvent('evt_abc', { additionalMinutes: 31 });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('480');
    });
  });

  describe('Extend rejected for non-live events', () => {
    it('rejects extend for scheduled event', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'scheduled',
          ownerUserId: 'user-123',
          scheduledEnd: '2099-06-15T11:00:00.000Z',
          durationMinutes: 60,
        },
      });

      const event = buildExtendEvent('evt_abc', { additionalMinutes: 15 });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('live event');
    });

    it('rejects extend for ended event', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'ended',
          ownerUserId: 'user-123',
          scheduledEnd: '2099-06-15T11:00:00.000Z',
          durationMinutes: 60,
        },
      });

      const event = buildExtendEvent('evt_abc', { additionalMinutes: 15 });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('live event');
    });
  });

  describe('DURATION_EXTENDED broadcast payload', () => {
    it('broadcasts correct DURATION_EXTENDED message structure', async () => {
      const { PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

      const currentEnd = '2099-06-15T11:00:00.000Z';

      mockDdbSend.mockResolvedValueOnce({
        Item: {
          eventId: 'evt_abc',
          status: 'live',
          ownerUserId: 'user-123',
          scheduledEnd: currentEnd,
          durationMinutes: 60,
        },
      });
      mockDdbSend.mockResolvedValueOnce({});
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ connectionId: 'conn-1', eventId: 'evt_abc' }],
      });

      const event = buildExtendEvent('evt_abc', { additionalMinutes: 30 });
      await handler(event);

      // Verify the broadcast payload
      expect(PostToConnectionCommand).toHaveBeenCalledTimes(1);
      const broadcastCall = PostToConnectionCommand.mock.calls[0][0];
      const payload = JSON.parse(broadcastCall.Data);

      expect(payload.type).toBe('DURATION_EXTENDED');
      expect(payload.eventId).toBe('evt_abc');
      expect(payload.data.newScheduledEnd).toBe('2099-06-15T11:30:00.000Z');
      expect(payload.data.additionalMinutes).toBe(30);
      expect(payload.data.newDurationMinutes).toBe(90);
      expect(payload.data.remainingSeconds).toBeGreaterThan(0);
    });
  });
});


// ============================================================
// Section 5: Email Template Duration Rendering Tests (Task 13.5)
// ============================================================

describe('Email Template Duration Rendering', () => {
  const { renderTemplate, formatDurationMinutes } = require('../../lambda/email-sender/templates');

  describe('event-created template includes duration info', () => {
    it('includes scheduledEnd and durationMinutes in HTML and text', () => {
      const result = renderTemplate('event-created', {
        eventTitle: 'AWS CDK Deep Dive',
        eventDescription: 'Learn CDK patterns',
        scheduledStart: '2024-06-15T10:00:00.000Z',
        scheduledEnd: '2024-06-15T11:30:00.000Z',
        durationMinutes: 90,
        eventUrl: '/events/evt_abc',
      });

      expect(result.subject).toContain('AWS CDK Deep Dive');
      // HTML should contain duration info
      expect(result.html).toContain('1h 30m');
      expect(result.html).toContain('Scheduled End');
      // Text should contain duration info
      expect(result.text).toContain('1h 30m');
      expect(result.text).toContain('Scheduled End');
    });

    it('omits duration info for open-ended events', () => {
      const result = renderTemplate('event-created', {
        eventTitle: 'Open Discussion',
        eventDescription: 'No time limit',
        scheduledStart: '2024-06-15T10:00:00.000Z',
        eventUrl: '/events/evt_open',
      });

      expect(result.html).not.toContain('Duration:');
      expect(result.html).not.toContain('Scheduled End');
      expect(result.text).not.toContain('Duration:');
    });
  });

  describe('reminder templates include duration info', () => {
    it('day-before-reminder includes expected duration', () => {
      const result = renderTemplate('day-before-reminder', {
        eventTitle: 'Morning Standup',
        scheduledStart: '2024-06-15T09:00:00.000Z',
        durationMinutes: 30,
        eventUrl: '/events/evt_standup',
      });

      expect(result.html).toContain('30m');
      expect(result.html).toContain('Expected Duration');
      expect(result.text).toContain('30m');
      expect(result.text).toContain('Expected Duration');
    });

    it('hour-before-reminder includes expected duration', () => {
      const result = renderTemplate('hour-before-reminder', {
        eventTitle: 'Workshop',
        scheduledStart: '2024-06-15T14:00:00.000Z',
        durationMinutes: 120,
        eventUrl: '/events/evt_workshop',
      });

      expect(result.html).toContain('2h');
      expect(result.html).toContain('Expected Duration');
      expect(result.text).toContain('2h');
      expect(result.text).toContain('Expected Duration');
    });

    it('reminder templates omit duration for open-ended events', () => {
      const result = renderTemplate('day-before-reminder', {
        eventTitle: 'Open Event',
        scheduledStart: '2024-06-15T09:00:00.000Z',
        eventUrl: '/events/evt_open',
      });

      expect(result.html).not.toContain('Expected Duration');
      expect(result.text).not.toContain('Expected Duration');
    });
  });

  describe('event-started template includes end time', () => {
    it('includes expected end time when scheduledEnd is present', () => {
      const result = renderTemplate('event-started', {
        eventTitle: 'Live Session',
        scheduledEnd: '2024-06-15T11:00:00.000Z',
        eventUrl: '/events/evt_live',
      });

      expect(result.html).toContain('Expected end time');
      expect(result.text).toContain('Expected End Time');
    });

    it('omits end time for open-ended events', () => {
      const result = renderTemplate('event-started', {
        eventTitle: 'Open Session',
        eventUrl: '/events/evt_open',
      });

      expect(result.html).not.toContain('Expected end time');
      expect(result.text).not.toContain('Expected End Time');
    });
  });

  describe('recap template shows actual duration', () => {
    it('computes actual duration from startedAt and endedAt', () => {
      const result = renderTemplate('recap', {
        eventTitle: 'Completed Event',
        playbackUrl: '/playback/evt_done',
        startedAt: '2024-06-15T10:00:00.000Z',
        endedAt: '2024-06-15T11:15:00.000Z',
        durationMinutes: 60, // planned was 60 min
      });

      // Actual duration: 75 minutes = 1h 15m
      expect(result.html).toContain('1h 15m');
      expect(result.text).toContain('1h 15m');
      // Planned duration
      expect(result.html).toContain('Planned Duration');
      expect(result.html).toContain('1h');
      expect(result.text).toContain('Planned Duration');
    });

    it('shows actual duration without planned when no durationMinutes', () => {
      const result = renderTemplate('recap', {
        eventTitle: 'Open Event Recap',
        playbackUrl: '/playback/evt_open',
        startedAt: '2024-06-15T10:00:00.000Z',
        endedAt: '2024-06-15T10:45:00.000Z',
      });

      // Actual duration: 45 minutes
      expect(result.html).toContain('45m');
      expect(result.text).toContain('45m');
      expect(result.html).not.toContain('Planned Duration');
    });

    it('falls back to duration field when startedAt/endedAt not available', () => {
      const result = renderTemplate('recap', {
        eventTitle: 'Legacy Event',
        playbackUrl: '/playback/evt_legacy',
        duration: 3600, // 1 hour in seconds
      });

      expect(result.html).toContain('1h');
      expect(result.text).toContain('1h');
    });
  });

  describe('formatDurationMinutes helper', () => {
    it('formats hours and minutes', () => {
      expect(formatDurationMinutes(90)).toBe('1h 30m');
    });

    it('formats hours only', () => {
      expect(formatDurationMinutes(120)).toBe('2h');
    });

    it('formats minutes only', () => {
      expect(formatDurationMinutes(45)).toBe('45m');
    });

    it('returns N/A for zero', () => {
      expect(formatDurationMinutes(0)).toBe('N/A');
    });

    it('returns N/A for null', () => {
      expect(formatDurationMinutes(null)).toBe('N/A');
    });
  });
});
