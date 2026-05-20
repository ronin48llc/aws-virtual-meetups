'use strict';

const fc = require('fast-check');
const { computeDurationFields, validateDurationFields, ValidationError } = require('../../lambda/shared/validation');

// --- Configuration ---
const FC_OPTIONS = { numRuns: 100, seed: Date.now() };

// --- Generators ---

// Generate valid scheduledStart (future ISO date)
const arbScheduledStart = fc.date({ min: new Date(), max: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) })
  .map(d => d.toISOString());

// Generate valid durationMinutes (1-480)
const arbDurationMinutes = fc.integer({ min: 1, max: 480 });

// --- Property Tests ---

describe('Event Duration Property Tests', () => {
  /**
   * Property 1: Duration computation round-trip
   * Feature: event-duration, Property 1: Duration computation round-trip
   * **Validates: Requirements 1.1, 1.2, 3.1, 3.2, 3.3**
   *
   * For any valid scheduledStart (ISO 8601 date) and for any positive integer
   * durationMinutes in [1, 480], computing scheduledEnd = scheduledStart + durationMinutes * 60000
   * and then computing derivedDuration = (scheduledEnd - scheduledStart) / 60000
   * should yield the original durationMinutes value.
   */
  describe('Property 1: Duration computation round-trip', () => {
    it('computing scheduledEnd from durationMinutes and back yields the original durationMinutes', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          arbDurationMinutes,
          (scheduledStart, durationMinutes) => {
            // Step 1: Compute scheduledEnd from durationMinutes
            const result = computeDurationFields(scheduledStart, { durationMinutes });

            expect(result).not.toBeNull();
            expect(result.durationMinutes).toBe(durationMinutes);
            expect(result.scheduledEnd).toBeDefined();

            // Step 2: Compute derivedDuration from scheduledEnd back
            const roundTrip = computeDurationFields(scheduledStart, { scheduledEnd: result.scheduledEnd });

            expect(roundTrip).not.toBeNull();
            expect(roundTrip.durationMinutes).toBe(durationMinutes);
            expect(roundTrip.scheduledEnd).toBe(result.scheduledEnd);
          }
        ),
        FC_OPTIONS
      );
    });
  });

  /**
   * Property 2: Mutual exclusivity rejection
   * Feature: event-duration, Property 2: Mutual exclusivity rejection
   * **Validates: Requirements 1.3**
   *
   * For any request body that contains both a non-null scheduledEnd and a non-null
   * durationMinutes, the computeDurationFields function should throw a validation error.
   */
  describe('Property 2: Mutual exclusivity rejection', () => {
    it('throws ValidationError when both scheduledEnd and durationMinutes are provided', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          arbDurationMinutes,
          arbScheduledStart,
          (scheduledStart, durationMinutes, scheduledEnd) => {
            // Both scheduledEnd and durationMinutes are non-null truthy values
            expect(() => {
              computeDurationFields(scheduledStart, { scheduledEnd, durationMinutes });
            }).toThrow(ValidationError);
          }
        ),
        FC_OPTIONS
      );
    });
  });

  /**
   * Property 3: scheduledEnd after scheduledStart validation
   * Feature: event-duration, Property 3: scheduledEnd after scheduledStart validation
   * **Validates: Requirements 2.2, 2.5**
   *
   * For any pair of ISO 8601 dates where scheduledEnd <= scheduledStart, the duration
   * validation function should reject the input. Conversely, for any pair where
   * scheduledEnd > scheduledStart, the validation should accept the input.
   */
  describe('Property 3: scheduledEnd after scheduledStart validation', () => {
    it('rejects when scheduledEnd <= scheduledStart', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          fc.integer({ min: 0, max: 480 }),
          (scheduledStart, offsetMinutes) => {
            const startDate = new Date(scheduledStart);
            // Generate scheduledEnd that is at or before scheduledStart
            const endDate = new Date(startDate.getTime() - offsetMinutes * 60000);
            const scheduledEnd = endDate.toISOString();

            // Use a valid durationMinutes so only the date ordering causes rejection
            const durationMinutes = 60;

            const result = validateDurationFields(scheduledEnd, durationMinutes, scheduledStart);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('scheduledEnd must be after scheduledStart');
          }
        ),
        FC_OPTIONS
      );
    });

    it('accepts when scheduledEnd > scheduledStart', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          fc.integer({ min: 1, max: 480 }),
          (scheduledStart, durationMinutes) => {
            const startDate = new Date(scheduledStart);
            // Generate scheduledEnd that is strictly after scheduledStart
            const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
            const scheduledEnd = endDate.toISOString();

            const result = validateDurationFields(scheduledEnd, durationMinutes, scheduledStart);
            expect(result.valid).toBe(true);
            expect(result.error).toBeNull();
          }
        ),
        FC_OPTIONS
      );
    });
  });

  /**
   * Property 4: durationMinutes range validation
   * Feature: event-duration, Property 4: durationMinutes range validation
   * **Validates: Requirements 2.3, 2.4, 2.6**
   *
   * For any numeric value n, the duration validation function should accept n if and only if
   * n is a positive integer and 1 <= n <= 480. Non-integers, zero, negative numbers, and
   * values exceeding 480 should all be rejected.
   */
  describe('Property 4: durationMinutes range validation', () => {
    // Generator for invalid durationMinutes (outside valid range)
    const _arbInvalidDuration = fc.oneof(
      fc.integer({ min: -1000, max: 0 }),
      fc.integer({ min: 481, max: 10000 }),
      fc.double().filter(n => !Number.isInteger(n))
    );

    it('accepts valid durationMinutes in [1, 480]', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          arbDurationMinutes,
          (scheduledStart, durationMinutes) => {
            const startDate = new Date(scheduledStart);
            // Provide a valid scheduledEnd that is after scheduledStart so only durationMinutes is tested
            const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
            const scheduledEnd = endDate.toISOString();

            const result = validateDurationFields(scheduledEnd, durationMinutes, scheduledStart);
            expect(result.valid).toBe(true);
            expect(result.error).toBeNull();
          }
        ),
        FC_OPTIONS
      );
    });

    it('rejects durationMinutes <= 0', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          fc.integer({ min: -1000, max: 0 }),
          (scheduledStart, durationMinutes) => {
            const startDate = new Date(scheduledStart);
            // Provide a valid scheduledEnd that is after scheduledStart
            const endDate = new Date(startDate.getTime() + 60 * 60000); // 1 hour after start
            const scheduledEnd = endDate.toISOString();

            const result = validateDurationFields(scheduledEnd, durationMinutes, scheduledStart);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('durationMinutes must be a positive integer');
          }
        ),
        FC_OPTIONS
      );
    });

    it('rejects durationMinutes > 480', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          fc.integer({ min: 481, max: 10000 }),
          (scheduledStart, durationMinutes) => {
            const startDate = new Date(scheduledStart);
            // Provide a valid scheduledEnd that is after scheduledStart
            const endDate = new Date(startDate.getTime() + 60 * 60000); // 1 hour after start
            const scheduledEnd = endDate.toISOString();

            const result = validateDurationFields(scheduledEnd, durationMinutes, scheduledStart);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('durationMinutes must not exceed 480 (8 hours)');
          }
        ),
        FC_OPTIONS
      );
    });

    it('rejects non-integer durationMinutes', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          fc.double().filter(n => !Number.isInteger(n)),
          (scheduledStart, durationMinutes) => {
            const startDate = new Date(scheduledStart);
            // Provide a valid scheduledEnd that is after scheduledStart
            const endDate = new Date(startDate.getTime() + 60 * 60000); // 1 hour after start
            const scheduledEnd = endDate.toISOString();

            const result = validateDurationFields(scheduledEnd, durationMinutes, scheduledStart);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('durationMinutes must be a positive integer');
          }
        ),
        FC_OPTIONS
      );
    });
  });
});


/**
 * Property 5: Live events reject duration field updates
 * Feature: event-duration, Property 5: Live events reject duration field updates
 * **Validates: Requirements 3.4**
 *
 * For any event in 'live' status and for any update request containing scheduledEnd
 * or durationMinutes, the event-crud update handler should return a 400 error indicating
 * that extensions must use the dedicated extend endpoint.
 */
describe('Property 5: Live events reject duration field updates', () => {
  let handler;
  let mockSend;

  beforeAll(() => {
    // Mock AWS SDK modules
    mockSend = jest.fn();
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
    jest.mock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
      InvokeCommand: jest.fn((params) => ({ type: 'Invoke', params })),
    }));
    jest.mock('../../lambda/shared/scheduler-utils', () => ({
      createReminderSchedules: jest.fn().mockResolvedValue(undefined),
      deleteReminderSchedules: jest.fn().mockResolvedValue(undefined),
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.EMAIL_LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:EmailSender';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    handler = require('../../lambda/event-crud/index').handler;
  });

  beforeEach(() => {
    mockSend.mockReset();
  });

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

  it('rejects update with scheduledEnd on a live event', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScheduledStart,
        async (scheduledEnd) => {
          const eventId = 'evt_livetest001';

          // Mock GetCommand: return a live event owned by the user
          mockSend.mockResolvedValueOnce({
            Item: {
              eventId,
              ownerUserId: validClaims.sub,
              status: 'live',
              title: 'Live Event',
              description: 'Currently live',
              scheduledStart: '2025-01-01T10:00:00Z',
              url: `/events/${eventId}`,
            },
          });

          const event = buildEvent({
            method: 'PUT',
            resource: '/events/{id}',
            pathParameters: { id: eventId },
            body: { scheduledEnd },
            claims: validClaims,
          });

          const result = await handler(event);
          expect(result.statusCode).toBe(400);

          const body = JSON.parse(result.body);
          expect(body.message).toBe('Cannot update duration on a live event. Use POST /events/{id}/extend instead');
        }
      ),
      FC_OPTIONS
    );
  });

  it('rejects update with durationMinutes on a live event', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDurationMinutes,
        async (durationMinutes) => {
          const eventId = 'evt_livetest002';

          // Mock GetCommand: return a live event owned by the user
          mockSend.mockResolvedValueOnce({
            Item: {
              eventId,
              ownerUserId: validClaims.sub,
              status: 'live',
              title: 'Live Event',
              description: 'Currently live',
              scheduledStart: '2025-01-01T10:00:00Z',
              url: `/events/${eventId}`,
            },
          });

          const event = buildEvent({
            method: 'PUT',
            resource: '/events/{id}',
            pathParameters: { id: eventId },
            body: { durationMinutes },
            claims: validClaims,
          });

          const result = await handler(event);
          expect(result.statusCode).toBe(400);

          const body = JSON.parse(result.body);
          expect(body.message).toBe('Cannot update duration on a live event. Use POST /events/{id}/extend instead');
        }
      ),
      FC_OPTIONS
    );
  });

  it('rejects update with both scheduledEnd and durationMinutes on a live event', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScheduledStart,
        arbDurationMinutes,
        async (scheduledEnd, durationMinutes) => {
          const eventId = 'evt_livetest003';

          // Mock GetCommand: return a live event owned by the user
          mockSend.mockResolvedValueOnce({
            Item: {
              eventId,
              ownerUserId: validClaims.sub,
              status: 'live',
              title: 'Live Event',
              description: 'Currently live',
              scheduledStart: '2025-01-01T10:00:00Z',
              url: `/events/${eventId}`,
            },
          });

          const event = buildEvent({
            method: 'PUT',
            resource: '/events/{id}',
            pathParameters: { id: eventId },
            body: { scheduledEnd, durationMinutes },
            claims: validClaims,
          });

          const result = await handler(event);
          expect(result.statusCode).toBe(400);

          const body = JSON.parse(result.body);
          expect(body.message).toBe('Cannot update duration on a live event. Use POST /events/{id}/extend instead');
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 12: GET response includes duration fields when present
 * Feature: event-duration, Property 12: GET response includes duration fields
 * **Validates: Requirements 10.1, 10.2, 7.2**
 *
 * For any event that has scheduledEnd and durationMinutes stored in DynamoDB,
 * the GET /events/{id} response should include both scheduledEnd and durationMinutes
 * fields regardless of event status.
 */
describe('Property 12: GET response includes duration fields when present', () => {
  let handler;
  let mockSend;

  beforeAll(() => {
    // Property 5's jest.mock for @aws-sdk/lib-dynamodb is hoisted and applies file-wide.
    // The mock factory captures Property 5's `mockSend` variable via closure.
    // We get a reference to the same mockSend by calling from() and extracting send.
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    const docClientInstance = DynamoDBDocumentClient.from({});
    mockSend = docClientInstance.send;

    handler = require('../../lambda/event-crud/index').handler;
  });

  beforeEach(() => {
    mockSend.mockReset();
  });

  function buildGetEvent(eventId) {
    return {
      httpMethod: 'GET',
      resource: '/events/{id}',
      body: null,
      pathParameters: { id: eventId },
      requestContext: {},
    };
  }

  // Generator for event statuses
  const arbEventStatus = fc.constantFrom('scheduled', 'live', 'ended', 'published');

  // Generator for valid durationMinutes (1-480)
  const arbDurationMinutes = fc.integer({ min: 1, max: 480 });

  // Generator for a valid eventId
  const arbEventId = fc.stringMatching(/^evt_[a-z0-9]{5,12}$/);

  it('GET response includes both scheduledEnd and durationMinutes for any event status', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbEventStatus,
        arbDurationMinutes,
        async (eventId, status, durationMinutes) => {
          const scheduledStart = '2025-06-01T10:00:00.000Z';
          const startMs = new Date(scheduledStart).getTime();
          const scheduledEnd = new Date(startMs + durationMinutes * 60000).toISOString();

          // Mock GetCommand: return an event with duration fields
          mockSend.mockResolvedValueOnce({
            Item: {
              eventId,
              title: 'Test Event',
              description: 'A test event',
              scheduledStart,
              scheduledEnd,
              durationMinutes,
              status,
              url: `/events/${eventId}`,
              ownerUserId: 'user-123',
              createdAt: '2025-01-01T00:00:00Z',
              updatedAt: '2025-01-01T00:00:00Z',
            },
          });

          const event = buildGetEvent(eventId);
          const result = await handler(event);

          expect(result.statusCode).toBe(200);

          const body = JSON.parse(result.body);
          expect(body.scheduledEnd).toBe(scheduledEnd);
          expect(body.durationMinutes).toBe(durationMinutes);
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 13: remainingSeconds computation
 * Feature: event-duration, Property 13: remainingSeconds computation
 * **Validates: Requirements 10.3**
 *
 * For any live event with a scheduledEnd in the future, the remainingSeconds field
 * in the GET response should equal Math.max(0, Math.floor((new Date(scheduledEnd).getTime() - Date.now()) / 1000)).
 * A tolerance of ±2 seconds is allowed since Date.now() advances between the handler call and the assertion.
 */
describe('Property 13: remainingSeconds computation', () => {
  let handler;
  let mockSend;

  beforeAll(() => {
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    const docClientInstance = DynamoDBDocumentClient.from({});
    mockSend = docClientInstance.send;

    handler = require('../../lambda/event-crud/index').handler;
  });

  beforeEach(() => {
    mockSend.mockReset();
  });

  function buildGetEvent(eventId) {
    return {
      httpMethod: 'GET',
      resource: '/events/{id}',
      body: null,
      pathParameters: { id: eventId },
      requestContext: {},
    };
  }

  // Generate scheduledEnd values that are 1 to 480 minutes from now
  const arbFutureMinutes = fc.integer({ min: 1, max: 480 });

  // Generator for a valid eventId
  const arbEventId = fc.stringMatching(/^evt_[a-z0-9]{5,12}$/);

  it('remainingSeconds equals approximately Math.max(0, Math.floor((scheduledEnd - now) / 1000))', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbFutureMinutes,
        async (eventId, futureMinutes) => {
          const now = Date.now();
          const scheduledEnd = new Date(now + futureMinutes * 60000).toISOString();
          const scheduledStart = new Date(now - 60 * 60000).toISOString(); // started 1 hour ago

          // Mock GetCommand: return a live event with scheduledEnd in the future
          mockSend.mockResolvedValueOnce({
            Item: {
              eventId,
              title: 'Live Event',
              description: 'A live event with duration',
              scheduledStart,
              scheduledEnd,
              durationMinutes: futureMinutes + 60, // total duration
              status: 'live',
              url: `/events/${eventId}`,
              ownerUserId: 'user-123',
              createdAt: '2025-01-01T00:00:00Z',
              updatedAt: '2025-01-01T00:00:00Z',
            },
          });

          const event = buildGetEvent(eventId);
          const result = await handler(event);

          expect(result.statusCode).toBe(200);

          const body = JSON.parse(result.body);

          // Compute expected remainingSeconds at the time of assertion
          const expectedRemaining = Math.max(0, Math.floor((new Date(scheduledEnd).getTime() - Date.now()) / 1000));

          // Allow ±2 seconds tolerance since time passes between handler execution and assertion
          expect(body.remainingSeconds).toBeGreaterThanOrEqual(expectedRemaining - 2);
          expect(body.remainingSeconds).toBeLessThanOrEqual(expectedRemaining + 2);
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 10: Auto-stop schedule name non-collision
 * Feature: event-duration, Property 10: Auto-stop schedule name non-collision
 * **Validates: Requirements 8.4**
 *
 * For any eventId, buildAutoStopScheduleName(eventId) should produce a string that does not
 * match the pattern produced by buildScheduleName(eventId, type) for any reminder type ('24h', '1h'),
 * nor buildWarningScheduleName(eventId, warningType) for any warning type ('5min', '1min').
 */
describe('Property 10: Auto-stop schedule name non-collision', () => {
  const { buildAutoStopScheduleName, buildWarningScheduleName, buildScheduleName } = require('../../lambda/shared/scheduler-utils');

  // Generator for eventId
  const arbEventId = fc.string({ minLength: 5, maxLength: 20 })
    .map(s => `evt_${s.replace(/[^a-z0-9]/gi, 'x')}`);

  it('buildAutoStopScheduleName(eventId) does not collide with buildScheduleName(eventId, type) for any reminder type', () => {
    fc.assert(
      fc.property(
        arbEventId,
        (eventId) => {
          const autoStopName = buildAutoStopScheduleName(eventId);

          // Must not match reminder schedule names
          expect(autoStopName).not.toBe(buildScheduleName(eventId, '24h'));
          expect(autoStopName).not.toBe(buildScheduleName(eventId, '1h'));

          // Must not match warning schedule names
          expect(autoStopName).not.toBe(buildWarningScheduleName(eventId, '5min'));
          expect(autoStopName).not.toBe(buildWarningScheduleName(eventId, '1min'));
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 6: Auto-stop is a no-op for non-live events
 * Feature: event-duration, Property 6: Auto-stop is a no-op for non-live events
 * **Validates: Requirements 4.3, 8.3**
 *
 * For any event whose status is not 'live' (i.e., 'scheduled', 'ended', 'published', or 'cancelled'),
 * when the auto-stop handler is invoked for that event, it should take no stop action and return without error.
 */
describe('Property 6: Auto-stop is a no-op for non-live events', () => {
  let sessionManagerHandler;
  let mockSessionSend;

  // Generators
  const arbNonLiveStatus = fc.constantFrom('scheduled', 'ended', 'published', 'cancelled');
  const arbEventId = fc.string({ minLength: 5, maxLength: 20 }).map(s => `evt_${s.replace(/[^a-z0-9]/gi, 'x')}`);

  beforeAll(() => {
    // The session-manager module requires additional AWS SDK modules beyond what
    // Property 5 already mocks. We add mocks for IVS modules here.
    jest.mock('@aws-sdk/client-ivs-realtime', () => ({
      IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
      CreateStageCommand: jest.fn(),
      DeleteStageCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-ivschat', () => ({
      IvschatClient: jest.fn(() => ({ send: jest.fn() })),
      CreateRoomCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
      ApiGatewayManagementApiClient: jest.fn(() => ({ send: jest.fn() })),
      PostToConnectionCommand: jest.fn(),
    }));

    // Create a dedicated mock for the session-manager's DynamoDB calls
    mockSessionSend = jest.fn();

    // Re-mock lib-dynamodb to use our local mockSessionSend
    jest.mock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockSessionSend })),
      },
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
      PutCommand: jest.fn((params) => ({ type: 'Put', params })),
      DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
    }));

    // Set required env vars for session-manager
    process.env.TABLE_NAME = 'TestTable';
    process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
    process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';

    // Clear module cache to force re-require with updated mocks
    jest.resetModules();

    // Re-require fast-check since modules were reset
    const _fcLocal = require('fast-check');

    sessionManagerHandler = require('../../lambda/session-manager/index').handler;
  });

  beforeEach(() => {
    mockSessionSend.mockReset();
  });

  it('returns skipped with reason not_live for any non-live event status', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbNonLiveStatus,
        async (eventId, status) => {
          // Reset mock between iterations
          mockSessionSend.mockReset();

          // Mock GetCommand: return an event with a non-live status
          mockSessionSend.mockResolvedValueOnce({
            Item: {
              PK: `EVENT#${eventId}`,
              SK: 'METADATA',
              eventId,
              title: 'Test Event',
              status,
              ownerUserId: 'user-123',
              scheduledEnd: '2025-06-01T12:00:00.000Z',
            },
          });

          // Invoke handler with direct invocation payload (no httpMethod, no requestContext)
          const result = await sessionManagerHandler({
            action: 'auto-stop',
            eventId,
          });

          // Verify the handler returns skipped status
          expect(result).toEqual({ status: 'skipped', reason: 'not_live' });

          // Verify DynamoDB was only called once (GetCommand) and NOT called with UpdateCommand
          expect(mockSessionSend).toHaveBeenCalledTimes(1);
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 7: Extension computation correctness
 * Feature: event-duration, Property 7: Extension computation correctness
 * **Validates: Requirements 6.1**
 *
 * For any live event with a current scheduledEnd and durationMinutes, and for any positive
 * integer additionalMinutes such that durationMinutes + additionalMinutes <= 480, the new
 * scheduledEnd should equal currentScheduledEnd + additionalMinutes * 60000 and the new
 * durationMinutes should equal currentDurationMinutes + additionalMinutes.
 */
describe('Property 7: Extension computation correctness', () => {
  let sessionManagerHandler;
  let mockSessionSend;

  // Generators
  const arbEventId = fc.string({ minLength: 5, maxLength: 20 }).map(s => `evt_${s.replace(/[^a-z0-9]/gi, 'x')}`);
  const arbDurationMinutes = fc.integer({ min: 1, max: 479 });

  beforeAll(() => {
    jest.mock('@aws-sdk/client-ivs-realtime', () => ({
      IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
      CreateStageCommand: jest.fn(),
      DeleteStageCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-ivschat', () => ({
      IvschatClient: jest.fn(() => ({ send: jest.fn() })),
      CreateRoomCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
      ApiGatewayManagementApiClient: jest.fn(() => ({ send: jest.fn() })),
      PostToConnectionCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
      InvokeCommand: jest.fn(),
    }));
    jest.mock('../../lambda/shared/scheduler-utils', () => ({
      createAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      deleteAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      createWarningSchedules: jest.fn().mockResolvedValue(undefined),
      deleteWarningSchedules: jest.fn().mockResolvedValue(undefined),
      buildAutoStopScheduleName: jest.fn((id) => `${id}-auto-stop`),
      buildWarningScheduleName: jest.fn((id, type) => `${id}-warning-${type}`),
      buildScheduleName: jest.fn((id, type) => `${id}-reminder-${type}`),
      createReminderSchedules: jest.fn().mockResolvedValue(undefined),
      deleteReminderSchedules: jest.fn().mockResolvedValue(undefined),
    }));

    mockSessionSend = jest.fn();

    jest.mock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockSessionSend })),
      },
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
      PutCommand: jest.fn((params) => ({ type: 'Put', params })),
      DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
    process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
    process.env.SESSION_MANAGER_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:SessionManager';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    jest.resetModules();

    sessionManagerHandler = require('../../lambda/session-manager/index').handler;
  });

  beforeEach(() => {
    mockSessionSend.mockReset();
  });

  function buildExtendEvent(eventId, additionalMinutes) {
    return {
      httpMethod: 'POST',
      resource: '/events/{id}/extend',
      body: JSON.stringify({ additionalMinutes }),
      pathParameters: { id: eventId },
      requestContext: {
        authorizer: {
          claims: {
            sub: 'user-123',
            email: 'organizer@example.com',
            'custom:role': 'organizer',
          },
        },
      },
    };
  }

  it('new scheduledEnd = currentScheduledEnd + additionalMinutes * 60000 and new durationMinutes = current + additional', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbDurationMinutes,
        fc.integer({ min: 1, max: 480 }),
        async (eventId, currentDuration, additionalMinutes) => {
          // Ensure total does not exceed 480
          if (currentDuration + additionalMinutes > 480) return;

          mockSessionSend.mockReset();

          const scheduledStart = '2025-06-01T10:00:00.000Z';
          const startMs = new Date(scheduledStart).getTime();
          const currentScheduledEnd = new Date(startMs + currentDuration * 60000).toISOString();

          // Mock GetCommand: return a live event with duration fields
          mockSessionSend.mockResolvedValueOnce({
            Item: {
              PK: `EVENT#${eventId}`,
              SK: 'METADATA',
              eventId,
              title: 'Live Event',
              status: 'live',
              ownerUserId: 'user-123',
              scheduledStart,
              scheduledEnd: currentScheduledEnd,
              durationMinutes: currentDuration,
            },
          });

          // Mock UpdateCommand: success
          mockSessionSend.mockResolvedValueOnce({});

          // Mock QueryCommand for broadcastToEvent: no connections
          mockSessionSend.mockResolvedValueOnce({ Items: [] });

          const event = buildExtendEvent(eventId, additionalMinutes);
          const result = await sessionManagerHandler(event);

          expect(result.statusCode).toBe(200);

          const body = JSON.parse(result.body);

          // Verify new scheduledEnd = currentScheduledEnd + additionalMinutes * 60000
          const expectedNewEnd = new Date(new Date(currentScheduledEnd).getTime() + additionalMinutes * 60000).toISOString();
          expect(body.newScheduledEnd).toBe(expectedNewEnd);

          // Verify new durationMinutes = currentDuration + additionalMinutes
          expect(body.newDurationMinutes).toBe(currentDuration + additionalMinutes);
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 8: Extension validation
 * Feature: event-duration, Property 8: Extension validation
 * **Validates: Requirements 6.2**
 *
 * For any additionalMinutes value and current durationMinutes, the extend validation should
 * reject when additionalMinutes is not a positive integer OR when durationMinutes + additionalMinutes > 480.
 */
describe('Property 8: Extension validation', () => {
  let sessionManagerHandler;
  let mockSessionSend;

  // Generators
  const arbEventId = fc.string({ minLength: 5, maxLength: 20 }).map(s => `evt_${s.replace(/[^a-z0-9]/gi, 'x')}`);

  beforeAll(() => {
    jest.mock('@aws-sdk/client-ivs-realtime', () => ({
      IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
      CreateStageCommand: jest.fn(),
      DeleteStageCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-ivschat', () => ({
      IvschatClient: jest.fn(() => ({ send: jest.fn() })),
      CreateRoomCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
      ApiGatewayManagementApiClient: jest.fn(() => ({ send: jest.fn() })),
      PostToConnectionCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
      InvokeCommand: jest.fn(),
    }));
    jest.mock('../../lambda/shared/scheduler-utils', () => ({
      createAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      deleteAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      createWarningSchedules: jest.fn().mockResolvedValue(undefined),
      deleteWarningSchedules: jest.fn().mockResolvedValue(undefined),
      buildAutoStopScheduleName: jest.fn((id) => `${id}-auto-stop`),
      buildWarningScheduleName: jest.fn((id, type) => `${id}-warning-${type}`),
      buildScheduleName: jest.fn((id, type) => `${id}-reminder-${type}`),
      createReminderSchedules: jest.fn().mockResolvedValue(undefined),
      deleteReminderSchedules: jest.fn().mockResolvedValue(undefined),
    }));

    mockSessionSend = jest.fn();

    jest.mock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockSessionSend })),
      },
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
      PutCommand: jest.fn((params) => ({ type: 'Put', params })),
      DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
    process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
    process.env.SESSION_MANAGER_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:SessionManager';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    jest.resetModules();

    sessionManagerHandler = require('../../lambda/session-manager/index').handler;
  });

  beforeEach(() => {
    mockSessionSend.mockReset();
  });

  function buildExtendEvent(eventId, additionalMinutes) {
    return {
      httpMethod: 'POST',
      resource: '/events/{id}/extend',
      body: JSON.stringify({ additionalMinutes }),
      pathParameters: { id: eventId },
      requestContext: {
        authorizer: {
          claims: {
            sub: 'user-123',
            email: 'organizer@example.com',
            'custom:role': 'organizer',
          },
        },
      },
    };
  }

  it('rejects when additionalMinutes is not a positive integer', async () => {
    // Generator for invalid additionalMinutes: zero, negative, or non-integer
    const arbInvalidAdditional = fc.oneof(
      fc.integer({ min: -1000, max: 0 }),
      fc.double().filter(n => !Number.isInteger(n) && !isNaN(n))
    );

    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbInvalidAdditional,
        async (eventId, additionalMinutes) => {
          mockSessionSend.mockReset();

          const event = buildExtendEvent(eventId, additionalMinutes);
          const result = await sessionManagerHandler(event);

          expect(result.statusCode).toBe(400);

          const body = JSON.parse(result.body);
          expect(body.message).toBe('additionalMinutes must be a positive integer');
        }
      ),
      FC_OPTIONS
    );
  });

  it('rejects when durationMinutes + additionalMinutes > 480', async () => {
    // Generate currentDuration and additionalMinutes such that total > 480
    const arbCurrentDuration = fc.integer({ min: 1, max: 480 });

    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbCurrentDuration,
        fc.integer({ min: 1, max: 500 }),
        async (eventId, currentDuration, additionalMinutes) => {
          // Only test cases where total exceeds 480
          if (currentDuration + additionalMinutes <= 480) return;

          mockSessionSend.mockReset();

          const scheduledStart = '2025-06-01T10:00:00.000Z';
          const startMs = new Date(scheduledStart).getTime();
          const currentScheduledEnd = new Date(startMs + currentDuration * 60000).toISOString();

          // Mock GetCommand: return a live event with duration fields
          mockSessionSend.mockResolvedValueOnce({
            Item: {
              PK: `EVENT#${eventId}`,
              SK: 'METADATA',
              eventId,
              title: 'Live Event',
              status: 'live',
              ownerUserId: 'user-123',
              scheduledStart,
              scheduledEnd: currentScheduledEnd,
              durationMinutes: currentDuration,
            },
          });

          const event = buildExtendEvent(eventId, additionalMinutes);
          const result = await sessionManagerHandler(event);

          expect(result.statusCode).toBe(400);

          const body = JSON.parse(result.body);
          expect(body.message).toBe('Total duration cannot exceed 480 minutes (8 hours)');
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 9: Extend rejected for non-live events
 * Feature: event-duration, Property 9: Extend rejected for non-live events
 * **Validates: Requirements 6.5**
 *
 * For any event whose status is not 'live' and for any valid additionalMinutes value,
 * the extend handler should return a 400 error.
 */
describe('Property 9: Extend rejected for non-live events', () => {
  let sessionManagerHandler;
  let mockSessionSend;

  // Generators
  const arbNonLiveStatus = fc.constantFrom('scheduled', 'ended', 'published', 'cancelled');
  const arbEventId = fc.string({ minLength: 5, maxLength: 20 }).map(s => `evt_${s.replace(/[^a-z0-9]/gi, 'x')}`);
  const arbAdditionalMinutes = fc.integer({ min: 1, max: 120 });

  beforeAll(() => {
    jest.mock('@aws-sdk/client-ivs-realtime', () => ({
      IVSRealTimeClient: jest.fn(() => ({ send: jest.fn() })),
      CreateStageCommand: jest.fn(),
      DeleteStageCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-ivschat', () => ({
      IvschatClient: jest.fn(() => ({ send: jest.fn() })),
      CreateRoomCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
      ApiGatewayManagementApiClient: jest.fn(() => ({ send: jest.fn() })),
      PostToConnectionCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-lambda', () => ({
      LambdaClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
      InvokeCommand: jest.fn(),
    }));
    jest.mock('../../lambda/shared/scheduler-utils', () => ({
      createAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      deleteAutoStopSchedule: jest.fn().mockResolvedValue(undefined),
      createWarningSchedules: jest.fn().mockResolvedValue(undefined),
      deleteWarningSchedules: jest.fn().mockResolvedValue(undefined),
      buildAutoStopScheduleName: jest.fn((id) => `${id}-auto-stop`),
      buildWarningScheduleName: jest.fn((id, type) => `${id}-warning-${type}`),
      buildScheduleName: jest.fn((id, type) => `${id}-reminder-${type}`),
      createReminderSchedules: jest.fn().mockResolvedValue(undefined),
      deleteReminderSchedules: jest.fn().mockResolvedValue(undefined),
    }));

    mockSessionSend = jest.fn();

    jest.mock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockSessionSend })),
      },
      GetCommand: jest.fn((params) => ({ type: 'Get', params })),
      UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
      QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
      PutCommand: jest.fn((params) => ({ type: 'Put', params })),
      DeleteCommand: jest.fn((params) => ({ type: 'Delete', params })),
    }));

    process.env.TABLE_NAME = 'TestTable';
    process.env.WEBSOCKET_ENDPOINT = 'https://ws.example.com';
    process.env.CONNECTIONS_TABLE_NAME = 'TestConnectionsTable';
    process.env.SESSION_MANAGER_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:SessionManager';
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789012:role/SchedulerRole';

    jest.resetModules();

    sessionManagerHandler = require('../../lambda/session-manager/index').handler;
  });

  beforeEach(() => {
    mockSessionSend.mockReset();
  });

  function buildExtendEvent(eventId, additionalMinutes) {
    return {
      httpMethod: 'POST',
      resource: '/events/{id}/extend',
      body: JSON.stringify({ additionalMinutes }),
      pathParameters: { id: eventId },
      requestContext: {
        authorizer: {
          claims: {
            sub: 'user-123',
            email: 'organizer@example.com',
            'custom:role': 'organizer',
          },
        },
      },
    };
  }

  it('returns 400 error for any non-live event status with valid additionalMinutes', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEventId,
        arbNonLiveStatus,
        arbAdditionalMinutes,
        async (eventId, status, additionalMinutes) => {
          mockSessionSend.mockReset();

          // Mock GetCommand: return an event with a non-live status
          mockSessionSend.mockResolvedValueOnce({
            Item: {
              PK: `EVENT#${eventId}`,
              SK: 'METADATA',
              eventId,
              title: 'Test Event',
              status,
              ownerUserId: 'user-123',
              scheduledStart: '2025-06-01T10:00:00.000Z',
              scheduledEnd: '2025-06-01T12:00:00.000Z',
              durationMinutes: 120,
            },
          });

          const event = buildExtendEvent(eventId, additionalMinutes);
          const result = await sessionManagerHandler(event);

          expect(result.statusCode).toBe(400);

          const body = JSON.parse(result.body);
          expect(body.message).toBe('Can only extend duration of a live event');
        }
      ),
      FC_OPTIONS
    );
  });
});


/**
 * Property 11: Email templates include duration information
 * Feature: event-duration, Property 11: Email templates include duration info
 * **Validates: Requirements 9.1, 9.2, 9.3**
 *
 * For any event data containing scheduledEnd and durationMinutes, rendering the event-created,
 * day-before-reminder, hour-before-reminder, or event-started email templates should produce
 * output (HTML and text) that contains the duration or end time information.
 */
describe('Property 11: Email templates include duration info', () => {
  const { renderTemplate, formatDurationMinutes } = require('../../lambda/email-sender/templates');

  // Generators
  const arbDurationMinutes = fc.integer({ min: 1, max: 480 });
  const arbScheduledStart = fc.date({ min: new Date(), max: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) })
    .map(d => d.toISOString());

  it('event-created template includes duration info when durationMinutes and scheduledEnd are provided', () => {
    fc.assert(
      fc.property(
        arbScheduledStart,
        arbDurationMinutes,
        (scheduledStart, durationMinutes) => {
          const startMs = new Date(scheduledStart).getTime();
          const scheduledEnd = new Date(startMs + durationMinutes * 60000).toISOString();

          const data = {
            eventTitle: 'Test Event',
            eventDescription: 'A test event description',
            scheduledStart,
            scheduledEnd,
            durationMinutes,
            eventUrl: 'https://example.com/events/test',
          };

          const result = renderTemplate('event-created', data);

          // The formatted duration string should appear in both HTML and text
          const expectedDurationStr = formatDurationMinutes(durationMinutes);
          expect(result.html).toContain(expectedDurationStr);
          expect(result.text).toContain(expectedDurationStr);
        }
      ),
      FC_OPTIONS
    );
  });

  it('day-before-reminder template includes duration info when durationMinutes is provided', () => {
    fc.assert(
      fc.property(
        arbScheduledStart,
        arbDurationMinutes,
        (scheduledStart, durationMinutes) => {
          const data = {
            eventTitle: 'Test Event',
            scheduledStart,
            durationMinutes,
            eventUrl: 'https://example.com/events/test',
          };

          const result = renderTemplate('day-before-reminder', data);

          const expectedDurationStr = formatDurationMinutes(durationMinutes);
          expect(result.html).toContain(expectedDurationStr);
          expect(result.text).toContain(expectedDurationStr);
        }
      ),
      FC_OPTIONS
    );
  });

  it('hour-before-reminder template includes duration info when durationMinutes is provided', () => {
    fc.assert(
      fc.property(
        arbScheduledStart,
        arbDurationMinutes,
        (scheduledStart, durationMinutes) => {
          const data = {
            eventTitle: 'Test Event',
            scheduledStart,
            durationMinutes,
            eventUrl: 'https://example.com/events/test',
          };

          const result = renderTemplate('hour-before-reminder', data);

          const expectedDurationStr = formatDurationMinutes(durationMinutes);
          expect(result.html).toContain(expectedDurationStr);
          expect(result.text).toContain(expectedDurationStr);
        }
      ),
      FC_OPTIONS
    );
  });

  it('event-started template includes end time info when scheduledEnd is provided', () => {
    fc.assert(
      fc.property(
        arbScheduledStart,
        arbDurationMinutes,
        (scheduledStart, durationMinutes) => {
          const startMs = new Date(scheduledStart).getTime();
          const scheduledEnd = new Date(startMs + durationMinutes * 60000).toISOString();

          const data = {
            eventTitle: 'Test Event',
            scheduledEnd,
            eventUrl: 'https://example.com/events/test',
          };

          const result = renderTemplate('event-started', data);

          // The output should contain the scheduledEnd date in some formatted form
          // We check that the HTML and text contain "Expected end time" or the formatted date
          expect(result.html).toContain('Expected end time');
          expect(result.text).toContain('Expected End Time');
        }
      ),
      FC_OPTIONS
    );
  });
});
