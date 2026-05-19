'use strict';

const fc = require('fast-check');

/**
 * Property 22: Sign-Up Registers User for Event
 * Validates: Requirements 15.2
 *
 * For any valid sign-up submission (with email and name) for a scheduled event,
 * the user should appear in the event's sign-up list after registration.
 */

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
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
}));

// Set env before requiring handler
process.env.TABLE_NAME = 'TestTable';

const { handler } = require('../../lambda/signup/index');

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

// --- Arbitraries ---

// Arbitrary: display name (non-empty, printable characters)
const displayNameArb = fc.stringOf(
  fc.char().filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7F),
  { minLength: 1, maxLength: 100 }
).filter((s) => s.trim().length > 0);

// Arbitrary: valid email address
const emailLocalArb = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 15 });
const emailDomainArb = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 10 });
const emailArb = fc.tuple(emailLocalArb, emailDomainArb, fc.constantFrom('com', 'org', 'net', 'io', 'dev'))
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

// Arbitrary: user ID
const userIdArb = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 3, maxLength: 20 })
  .map((s) => `user_${s}`);

// Arbitrary: event ID
const eventIdArb = fc.stringOf(fc.constantFrom(...'abcdef0123456789'.split('')), { minLength: 6, maxLength: 12 })
  .map((s) => `evt_${s}`);

// --- Property Tests ---

describe('Sign-Up Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property 22: Sign-Up Registers User for Event
   * Validates: Requirements 15.2
   *
   * For any authenticated user with valid sign-up data (displayName, email),
   * signing up for an existing event should:
   * 1. Return a 201 status code
   * 2. Store the sign-up with the correct PK (EVENT#{eventId}) and SK (SIGNUP#{userId})
   * 3. Return the user's information in the confirmation response
   * 4. Include a registeredAt timestamp
   */
  describe('Property 22: Sign-Up Registers User for Event', () => {
    it('should return 201 and store sign-up with correct keys for any valid input', async () => {
      await fc.assert(
        fc.asyncProperty(
          displayNameArb,
          emailArb,
          userIdArb,
          eventIdArb,
          async (displayName, email, userId, eventId) => {
            jest.clearAllMocks();

            // Mock GetCommand: event exists
            mockSend.mockResolvedValueOnce({
              Item: {
                PK: `EVENT#${eventId}`,
                SK: 'METADATA',
                eventId,
                title: 'Test Event',
                status: 'scheduled',
                ownerUserId: 'owner_abc',
              },
            });
            // Mock PutCommand: sign-up stored
            mockSend.mockResolvedValueOnce({});

            const claims = {
              sub: userId,
              email: email,
              'custom:displayName': displayName,
            };

            const event = buildEvent({
              method: 'POST',
              resource: '/events/{id}/signup',
              pathParameters: { id: eventId },
              body: { displayName, email },
              claims,
            });

            const result = await handler(event);

            // 1. Return a 201 status code
            expect(result.statusCode).toBe(201);

            const body = JSON.parse(result.body);

            // 2. Store the sign-up with the correct PK and SK
            const { PutCommand } = require('@aws-sdk/lib-dynamodb');
            expect(PutCommand).toHaveBeenCalledWith(
              expect.objectContaining({
                TableName: 'TestTable',
                Item: expect.objectContaining({
                  PK: `EVENT#${eventId}`,
                  SK: `SIGNUP#${userId}`,
                  userId,
                }),
              })
            );

            // 3. Return the user's information in the confirmation response
            expect(body.userId).toBe(userId);
            expect(body.email).toBe(email);
            expect(body.eventId).toBe(eventId);
            expect(body.displayName).toBeDefined();

            // 4. Include a registeredAt timestamp
            expect(body.registeredAt).toBeDefined();
            expect(() => new Date(body.registeredAt)).not.toThrow();
            // Verify it's a valid ISO timestamp
            expect(new Date(body.registeredAt).toISOString()).toBe(body.registeredAt);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
