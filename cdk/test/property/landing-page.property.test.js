'use strict';

const fc = require('fast-check');

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

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';

const { handler } = require('../../lambda/event-crud/index');

// --- Helpers ---

function buildGetEventRequest(eventId) {
  return {
    httpMethod: 'GET',
    resource: '/events/{id}',
    pathParameters: { id: eventId },
    requestContext: {},
    body: null,
  };
}

// --- Arbitraries ---

// Arbitrary: event ID
const eventIdArb = fc.string({ minLength: 5, maxLength: 12 })
  .filter((s) => /^[a-z0-9]+$/.test(s))
  .map((s) => `evt_${s}`);

// Arbitrary: future ISO date (1 hour to 365 days from now)
const futureDate = fc.integer({ min: 3600000, max: 365 * 86400000 }).map(
  (offset) => new Date(Date.now() + offset).toISOString()
);

// Arbitrary: non-empty title/description
const nonEmptyString = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// --- Property Tests ---

describe('Landing Page Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property 19: Event State Determines Landing Page Display Mode
   * Validates: Requirements 15.3
   *
   * For any event with a given status, the GET /events/{id} response should include
   * the correct displayMode:
   * - "scheduled" → displayMode: "signup" with countdown > 0
   * - "live" → displayMode: "live" without countdown
   * - "ended" → displayMode: "ended" without countdown
   * - "cancelled" → displayMode: "cancelled" without countdown
   */
  describe('Property 19: Event State Determines Landing Page Display Mode', () => {
    it('should return displayMode "signup" with countdown > 0 for scheduled events', async () => {
      await fc.assert(
        fc.asyncProperty(
          eventIdArb,
          nonEmptyString,
          nonEmptyString,
          futureDate,
          async (eventId, title, description, scheduledStart) => {
            mockSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                eventId,
                title,
                description,
                scheduledStart,
                status: 'scheduled',
                url: `/events/${eventId}`,
                ownerUserId: 'user_owner',
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
              },
            });

            const request = buildGetEventRequest(eventId);
            const result = await handler(request);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            expect(body.displayMode).toBe('signup');
            expect(body.countdown).toBeDefined();
            expect(typeof body.countdown).toBe('number');
            expect(body.countdown).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should return displayMode "live" without countdown for live events', async () => {
      await fc.assert(
        fc.asyncProperty(
          eventIdArb,
          nonEmptyString,
          nonEmptyString,
          async (eventId, title, description) => {
            const pastStart = new Date(Date.now() - 3600000).toISOString();

            mockSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                eventId,
                title,
                description,
                scheduledStart: pastStart,
                status: 'live',
                url: `/events/${eventId}`,
                ownerUserId: 'user_owner',
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
              },
            });

            const request = buildGetEventRequest(eventId);
            const result = await handler(request);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            expect(body.displayMode).toBe('live');
            expect(body.countdown).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should return displayMode "ended" without countdown for ended events', async () => {
      await fc.assert(
        fc.asyncProperty(
          eventIdArb,
          nonEmptyString,
          nonEmptyString,
          async (eventId, title, description) => {
            const pastStart = new Date(Date.now() - 7200000).toISOString();

            mockSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                eventId,
                title,
                description,
                scheduledStart: pastStart,
                status: 'ended',
                url: `/events/${eventId}`,
                ownerUserId: 'user_owner',
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
              },
            });

            const request = buildGetEventRequest(eventId);
            const result = await handler(request);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            expect(body.displayMode).toBe('ended');
            expect(body.countdown).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should return displayMode "cancelled" without countdown for cancelled events', async () => {
      await fc.assert(
        fc.asyncProperty(
          eventIdArb,
          nonEmptyString,
          nonEmptyString,
          async (eventId, title, description) => {
            const pastStart = new Date(Date.now() - 3600000).toISOString();

            mockSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                eventId,
                title,
                description,
                scheduledStart: pastStart,
                status: 'cancelled',
                url: `/events/${eventId}`,
                ownerUserId: 'user_owner',
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
              },
            });

            const request = buildGetEventRequest(eventId);
            const result = await handler(request);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            expect(body.displayMode).toBe('cancelled');
            expect(body.countdown).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should map any random status to the correct displayMode', async () => {
      const statusToDisplayMode = {
        scheduled: 'signup',
        live: 'live',
        ended: 'ended',
        cancelled: 'cancelled',
      };

      const statusArb = fc.constantFrom('scheduled', 'live', 'ended', 'cancelled');

      await fc.assert(
        fc.asyncProperty(
          eventIdArb,
          nonEmptyString,
          nonEmptyString,
          statusArb,
          async (eventId, title, description, status) => {
            // Use a future date for scheduled, past date for others
            const scheduledStart = status === 'scheduled'
              ? new Date(Date.now() + 86400000).toISOString()
              : new Date(Date.now() - 3600000).toISOString();

            mockSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                eventId,
                title,
                description,
                scheduledStart,
                status,
                url: `/events/${eventId}`,
                ownerUserId: 'user_owner',
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
              },
            });

            const request = buildGetEventRequest(eventId);
            const result = await handler(request);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            const expectedDisplayMode = statusToDisplayMode[status];
            expect(body.displayMode).toBe(expectedDisplayMode);

            // Countdown should only be present for scheduled events
            if (status === 'scheduled') {
              expect(body.countdown).toBeDefined();
              expect(typeof body.countdown).toBe('number');
              expect(body.countdown).toBeGreaterThanOrEqual(0);
            } else {
              expect(body.countdown).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
