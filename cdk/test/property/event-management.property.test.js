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

// Arbitrary: non-empty trimmed string (title/description)
const nonEmptyString = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// Arbitrary: future ISO date (1 hour to 365 days from now)
const futureDate = fc.integer({ min: 3600000, max: 365 * 86400000 }).map(
  (offset) => new Date(Date.now() + offset).toISOString()
);

// Arbitrary: past ISO date (1 hour to 365 days ago)
const pastDate = fc.integer({ min: 3600000, max: 365 * 86400000 }).map(
  (offset) => new Date(Date.now() - offset).toISOString()
);

// Arbitrary: user ID
const userId = fc.string({ minLength: 5, maxLength: 30 })
  .filter((s) => s.trim().length > 0)
  .map((s) => `user_${s.replace(/\s/g, '_')}`);

// Arbitrary: valid auth claims
const validClaims = userId.map((uid) => ({
  sub: uid,
  email: `${uid}@example.com`,
  'custom:role': 'organizer',
}));

// --- Property Tests ---

describe('Event Management Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property 12: Event Creation Produces Unique URL with All Metadata
   * Validates: Requirements 14.1
   *
   * For any valid event creation input (title, description, future start time),
   * the created event should have a unique URL (different from all other events)
   * and store all provided metadata fields.
   */
  describe('Property 12: Event Creation Produces Unique URL with All Metadata', () => {
    it('should produce a unique URL containing the event ID and preserve all metadata', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyString,
          nonEmptyString,
          futureDate,
          validClaims,
          async (title, description, scheduledStart, claims) => {
            mockSend.mockResolvedValueOnce({});

            const event = buildEvent({
              method: 'POST',
              resource: '/events',
              body: { title, description, scheduledStart },
              claims,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(201);

            const body = JSON.parse(result.body);

            // URL is unique (contains the generated event ID)
            expect(body.url).toBe(`/events/${body.eventId}`);
            expect(body.eventId).toMatch(/^evt_[a-f0-9]{12}$/);

            // All metadata fields are preserved
            expect(body.title).toBeDefined();
            expect(body.description).toBeDefined();
            expect(body.scheduledStart).toBe(scheduledStart);
            expect(body.status).toBe('scheduled');
            expect(body.ownerUserId).toBe(claims.sub);
            expect(body.createdAt).toBeDefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should produce distinct event IDs across multiple creations', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(nonEmptyString, { minLength: 2, maxLength: 5 }),
          futureDate,
          validClaims,
          async (titles, scheduledStart, claims) => {
            const eventIds = [];

            for (const title of titles) {
              mockSend.mockResolvedValueOnce({});

              const event = buildEvent({
                method: 'POST',
                resource: '/events',
                body: { title, description: 'desc', scheduledStart },
                claims,
              });

              const result = await handler(event);
              expect(result.statusCode).toBe(201);

              const body = JSON.parse(result.body);
              eventIds.push(body.eventId);
            }

            // All event IDs should be unique
            const uniqueIds = new Set(eventIds);
            expect(uniqueIds.size).toBe(eventIds.length);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 13: Past Start Time Rejected
   * Validates: Requirements 14.3
   *
   * For any event creation request where the scheduled start time is in the past,
   * the creation should be rejected with a validation error.
   */
  describe('Property 13: Past Start Time Rejected', () => {
    it('should reject event creation with any past start time', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyString,
          nonEmptyString,
          pastDate,
          validClaims,
          async (title, description, scheduledStart, claims) => {
            const event = buildEvent({
              method: 'POST',
              resource: '/events',
              body: { title, description, scheduledStart },
              claims,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(400);

            const body = JSON.parse(result.body);
            expect(body.message).toContain('future');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 14: Event URL Preserved Across Edits
   * Validates: Requirements 18.2
   *
   * For any event, editing its metadata (title, description, start time)
   * should not change its URL.
   */
  describe('Property 14: Event URL Preserved Across Edits', () => {
    it('should preserve the event URL when metadata is edited', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyString,
          nonEmptyString,
          futureDate,
          validClaims,
          async (newTitle, newDescription, newScheduledStart, claims) => {
            const eventId = 'evt_abc123def456';
            const originalUrl = `/events/${eventId}`;

            // Mock GetCommand: return existing event owned by the user
            mockSend.mockResolvedValueOnce({
              Item: {
                eventId,
                ownerUserId: claims.sub,
                url: originalUrl,
                title: 'Original Title',
                description: 'Original Desc',
                scheduledStart: new Date(Date.now() + 86400000).toISOString(),
                status: 'scheduled',
              },
            });

            // Mock UpdateCommand: return updated event
            mockSend.mockResolvedValueOnce({
              Attributes: {
                eventId,
                title: newTitle,
                description: newDescription,
                scheduledStart: newScheduledStart,
                status: 'scheduled',
                url: originalUrl,
                ownerUserId: claims.sub,
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: new Date().toISOString(),
              },
            });

            const event = buildEvent({
              method: 'PUT',
              resource: '/events/{id}',
              pathParameters: { id: eventId },
              body: { title: newTitle, description: newDescription, scheduledStart: newScheduledStart },
              claims,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            // URL must be preserved
            expect(body.url).toBe(originalUrl);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 15: Authentication Required for Protected Operations
   * Validates: Requirements 18.1
   *
   * For any request to create, edit, or delete an event that lacks a valid
   * authentication token, the request should be rejected with an authorization error.
   */
  describe('Property 15: Authentication Required for Protected Operations', () => {
    it('should reject unauthenticated POST /events requests', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyString,
          nonEmptyString,
          futureDate,
          async (title, description, scheduledStart) => {
            const event = buildEvent({
              method: 'POST',
              resource: '/events',
              body: { title, description, scheduledStart },
              // No claims - unauthenticated
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(401);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should reject unauthenticated PUT /events/{id} requests', async () => {
      await fc.assert(
        fc.asyncProperty(
          nonEmptyString,
          nonEmptyString,
          async (title, description) => {
            const event = buildEvent({
              method: 'PUT',
              resource: '/events/{id}',
              pathParameters: { id: 'evt_abc123def456' },
              body: { title, description },
              // No claims - unauthenticated
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(401);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should reject unauthenticated DELETE /events/{id} requests', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }),
          async (eventId) => {
            const event = buildEvent({
              method: 'DELETE',
              resource: '/events/{id}',
              pathParameters: { id: `evt_${eventId}` },
              // No claims - unauthenticated
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(401);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 16: Deleted Events Removed from Public Listing
   * Validates: Requirements 18.3
   *
   * For any event that has been deleted, it should not appear in the public
   * upcoming events list (GSI1PK and GSI1SK are removed).
   */
  describe('Property 16: Deleted Events Removed from Public Listing', () => {
    it('should remove GSI1PK and GSI1SK when an event is deleted', async () => {
      await fc.assert(
        fc.asyncProperty(
          validClaims,
          fc.string({ minLength: 5, maxLength: 12 }).map((s) => `evt_${s.replace(/\s/g, 'x')}`),
          async (claims, eventId) => {
            // Mock GetCommand: return existing event owned by the user
            mockSend.mockResolvedValueOnce({
              Item: {
                eventId,
                ownerUserId: claims.sub,
                url: `/events/${eventId}`,
                status: 'scheduled',
              },
            });

            // Mock UpdateCommand for deletion
            mockSend.mockResolvedValueOnce({});

            const event = buildEvent({
              method: 'DELETE',
              resource: '/events/{id}',
              pathParameters: { id: eventId },
              claims,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            // Verify the UpdateCommand was called with REMOVE GSI1PK, GSI1SK
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            const lastUpdateCall = UpdateCommand.mock.calls[UpdateCommand.mock.calls.length - 1][0];
            expect(lastUpdateCall.UpdateExpression).toContain('REMOVE GSI1PK, GSI1SK');
            expect(lastUpdateCall.ExpressionAttributeValues[':status']).toBe('cancelled');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 17: Upcoming Event List Contains Only Future Non-Ended Events, Sorted
   * Validates: Requirements 17.1, 17.3
   *
   * For any query of the upcoming events list, all returned events should have
   * status "scheduled" and a start time in the future, and the list should be
   * sorted by scheduled start time in ascending order.
   */
  describe('Property 17: Upcoming Event List Contains Only Future Non-Ended Events, Sorted', () => {
    it('should return events sorted by scheduledStart in ascending order', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              eventId: fc.string({ minLength: 5, maxLength: 12 }).map((s) => `evt_${s.replace(/\s/g, 'x')}`),
              title: nonEmptyString,
              description: nonEmptyString,
              scheduledStart: futureDate,
              status: fc.constant('scheduled'),
              url: fc.constant('/events/evt_placeholder'),
              ownerUserId: fc.constant('user_owner'),
              createdAt: fc.constant('2025-01-01T00:00:00Z'),
            }),
            { minLength: 0, maxLength: 10 }
          ),
          async (items) => {
            // Sort items by scheduledStart to simulate DynamoDB GSI1 sort
            const sortedItems = [...items].sort(
              (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime()
            );

            mockSend.mockResolvedValueOnce({ Items: sortedItems });

            const event = buildEvent({ method: 'GET', resource: '/events' });
            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            const events = body.events;

            // All events should have status 'scheduled'
            for (const evt of events) {
              expect(evt.status).toBe('scheduled');
            }

            // Events should be in ascending order by scheduledStart
            for (let i = 1; i < events.length; i++) {
              const prev = new Date(events[i - 1].scheduledStart).getTime();
              const curr = new Date(events[i].scheduledStart).getTime();
              expect(prev).toBeLessThanOrEqual(curr);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should query GSI1 with correct parameters', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          mockSend.mockResolvedValueOnce({ Items: [] });

          const event = buildEvent({ method: 'GET', resource: '/events' });
          await handler(event);

          // Verify QueryCommand was called with correct GSI1 parameters
          const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
          const lastCall = QueryCommand.mock.calls[QueryCommand.mock.calls.length - 1][0];
          expect(lastCall.IndexName).toBe('GSI1');
          expect(lastCall.KeyConditionExpression).toContain('GSI1PK = :pk');
          expect(lastCall.ExpressionAttributeValues[':pk']).toBe('EVENTS#UPCOMING');
        }),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 18: Event List Contains All Required Fields
   * Validates: Requirements 17.2
   *
   * For any event in the public listing, the rendered output should include
   * the event title, description, scheduled start time, and a link to the landing page.
   */
  describe('Property 18: Event List Contains All Required Fields', () => {
    it('should include title, description, scheduledStart, and url for every listed event', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              eventId: fc.string({ minLength: 5, maxLength: 12 }).map((s) => `evt_${s.replace(/\s/g, 'x')}`),
              title: nonEmptyString,
              description: nonEmptyString,
              scheduledStart: futureDate,
              status: fc.constant('scheduled'),
              url: nonEmptyString.map((s) => `/events/${s}`),
              ownerUserId: userId,
              createdAt: fc.constant('2025-01-01T00:00:00Z'),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (items) => {
            mockSend.mockResolvedValueOnce({ Items: items });

            const event = buildEvent({ method: 'GET', resource: '/events' });
            const result = await handler(event);
            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            const events = body.events;

            expect(events.length).toBe(items.length);

            for (const evt of events) {
              // All required fields must be present
              expect(evt.title).toBeDefined();
              expect(typeof evt.title).toBe('string');
              expect(evt.description).toBeDefined();
              expect(typeof evt.description).toBe('string');
              expect(evt.scheduledStart).toBeDefined();
              expect(typeof evt.scheduledStart).toBe('string');
              expect(evt.url).toBeDefined();
              expect(typeof evt.url).toBe('string');
              // URL serves as the link to the landing page
              expect(evt.url.length).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
