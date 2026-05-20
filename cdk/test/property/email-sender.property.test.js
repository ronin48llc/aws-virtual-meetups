'use strict';

const fc = require('fast-check');

// --- Mock setup ---

const mockSesSend = jest.fn();
const mockDocSend = jest.fn();

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn((params) => ({ type: 'SendEmail', input: params })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDocSend })),
  },
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

// Set environment variables before requiring the handler
process.env.TABLE_NAME = 'VirtualMeetupTable';
process.env.SES_SENDER = 'phannah@thenetwerk.net';
process.env.FRONTEND_URL = 'https://d2hbje3cen4qrx.cloudfront.net';

const { handler } = require('../../lambda/email-sender/index');

// --- Arbitraries ---

const SINGLE_RECIPIENT_TYPES = ['event-created', 'signup-confirmation'];
const BULK_TYPES = ['day-before-reminder', 'hour-before-reminder', 'event-started', 'recap'];
const ALL_EMAIL_TYPES = [...SINGLE_RECIPIENT_TYPES, ...BULK_TYPES];

// Arbitrary for email type
const arbEmailType = fc.constantFrom(...ALL_EMAIL_TYPES);

// Arbitrary for error messages
const arbErrorMessage = fc.string({ minLength: 1, maxLength: 200 });

// Arbitrary for event IDs
const arbEventId = fc.string({ minLength: 3, maxLength: 30 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
  .map((s) => `evt_${s}`);

// Arbitrary for email addresses
const arbEmail = fc.tuple(
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z0-9]+$/.test(s)),
  fc.constantFrom('example.com', 'test.org', 'mail.net')
).map(([local, domain]) => `${local}@${domain}`);

// Arbitrary for event titles
const arbEventTitle = fc.string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0);

// Arbitrary for event descriptions
const arbEventDescription = fc.string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

// Arbitrary for ISO date strings
const arbScheduledStart = fc.integer({ min: 1600000000000, max: 1900000000000 })
  .map((ms) => new Date(ms).toISOString());

// Arbitrary for recipient names
const arbRecipientName = fc.string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

// Arbitrary for playback URLs
const arbPlaybackUrl = fc.string({ minLength: 5, maxLength: 50 })
  .filter((s) => /^[a-zA-Z0-9/_-]+$/.test(s))
  .map((s) => `https://cdn.example.com/recordings/${s}`);

// Arbitrary for duration in seconds
const arbDuration = fc.integer({ min: 60, max: 36000 });

// --- Property Tests ---

describe('Email Sender Property Tests', () => {
  /**
   * Property 2: Email Failure Resilience
   * Feature: email-notifications, Property 2: Email Failure Resilience
   * **Validates: Requirements 1.4, 2.4, 5.4, 6.5**
   *
   * For any email send operation encountering an SES error, the handler
   * resolves without throwing and logs the error with eventId and recipient.
   */
  describe('Property 2: Email Failure Resilience', () => {
    let _consoleErrorSpy;

    beforeEach(() => {
      jest.clearAllMocks();
      _consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('single-recipient types resolve without throwing when SES fails with any error', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...SINGLE_RECIPIENT_TYPES),
          arbErrorMessage,
          arbEventId,
          arbEmail,
          arbRecipientName,
          arbEventTitle,
          arbEventDescription,
          arbScheduledStart,
          async (emailType, errorMessage, eventId, recipientEmail, recipientName, eventTitle, eventDescription, scheduledStart) => {
            jest.clearAllMocks();

            // SES always rejects with the generated error
            mockSesSend.mockRejectedValue(new Error(errorMessage));

            const payload = {
              type: emailType,
              eventId,
              recipientEmail,
              recipientName,
              eventTitle,
              eventDescription,
              scheduledStart,
            };

            // Handler must resolve (not throw)
            const result = await handler(payload);

            // Must return statusCode 200
            expect(result.statusCode).toBe(200);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('bulk types resolve without throwing when SES fails with any error', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...BULK_TYPES),
          arbErrorMessage,
          arbEventId,
          arbEmail,
          arbEventTitle,
          arbEventDescription,
          arbScheduledStart,
          arbPlaybackUrl,
          arbDuration,
          async (emailType, errorMessage, eventId, attendeeEmail, eventTitle, eventDescription, scheduledStart, playbackUrl, duration) => {
            jest.clearAllMocks();

            // SES always rejects with the generated error
            mockSesSend.mockRejectedValue(new Error(errorMessage));

            // DynamoDB returns valid event metadata and one attendee
            mockDocSend
              .mockResolvedValueOnce({
                Item: {
                  title: eventTitle,
                  description: eventDescription,
                  scheduledStart,
                  hlsPlaybackUrl: playbackUrl,
                },
              })
              .mockResolvedValueOnce({
                Items: [{
                  userId: 'user_1',
                  displayName: 'Test User',
                  email: attendeeEmail,
                  registeredAt: '2024-01-01T00:00:00Z',
                }],
              });

            const payload = {
              type: emailType,
              eventId,
              playbackUrl,
              duration,
            };

            // Handler must resolve (not throw)
            const result = await handler(payload);

            // Must return statusCode 200
            expect(result.statusCode).toBe(200);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('handler never throws regardless of email type and SES error type', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEmailType,
          arbErrorMessage,
          arbEventId,
          arbEmail,
          arbRecipientName,
          arbEventTitle,
          arbScheduledStart,
          async (emailType, errorMessage, eventId, recipientEmail, recipientName, eventTitle, scheduledStart) => {
            jest.clearAllMocks();

            // SES rejects with the generated error
            mockSesSend.mockRejectedValue(new Error(errorMessage));

            // For bulk types, set up DynamoDB mocks
            if (BULK_TYPES.includes(emailType)) {
              mockDocSend
                .mockResolvedValueOnce({
                  Item: {
                    title: eventTitle,
                    description: 'Test description',
                    scheduledStart,
                    hlsPlaybackUrl: 'https://example.com/playback',
                  },
                })
                .mockResolvedValueOnce({
                  Items: [{
                    userId: 'user_1',
                    displayName: recipientName,
                    email: recipientEmail,
                    registeredAt: '2024-01-01T00:00:00Z',
                  }],
                });
            }

            const payload = {
              type: emailType,
              eventId,
              recipientEmail,
              recipientName,
              eventTitle,
              eventDescription: 'Generated description',
              scheduledStart,
              playbackUrl: 'https://example.com/playback',
              duration: 3600,
            };

            // The key property: handler MUST resolve without throwing
            const result = await handler(payload);

            // Must return statusCode 200 (successful handling despite SES failure)
            expect(result.statusCode).toBe(200);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 4: Bulk Email Sends to All Attendees
   * Feature: email-notifications, Property 4: Bulk Email Sends to All Attendees
   * **Validates: Requirements 3.2, 4.2, 5.1, 6.1**
   *
   * For any event with N attendees (N > 0), the bulk email function produces
   * exactly N send calls, one per unique attendee email address.
   */
  describe('Property 4: Bulk Email Sends to All Attendees', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('produces exactly N SES send calls for N unique attendees, one per attendee email', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...BULK_TYPES),
          fc.integer({ min: 1, max: 20 }).chain((n) =>
            fc.tuple(
              fc.constant(n),
              fc.uniqueArray(
                fc.tuple(
                  fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-z0-9]+$/.test(s)),
                  fc.constantFrom('example.com', 'test.org', 'mail.net', 'dev.io', 'corp.co')
                ).map(([local, domain]) => `${local}@${domain}`),
                { minLength: n, maxLength: n }
              )
            )
          ),
          arbEventId,
          arbEventTitle,
          arbEventDescription,
          arbScheduledStart,
          arbPlaybackUrl,
          arbDuration,
          async (emailType, [n, attendeeEmails], eventId, eventTitle, eventDescription, scheduledStart, playbackUrl, duration) => {
            jest.clearAllMocks();

            // Build attendees list from generated unique emails
            const attendees = attendeeEmails.map((email, i) => ({
              userId: `user_${i}`,
              displayName: `User ${i}`,
              email,
              registeredAt: '2024-01-01T00:00:00Z',
            }));

            // Mock DynamoDB: first call returns event metadata, second returns attendees
            mockDocSend
              .mockResolvedValueOnce({
                Item: {
                  title: eventTitle,
                  description: eventDescription,
                  scheduledStart,
                  hlsPlaybackUrl: playbackUrl,
                },
              })
              .mockResolvedValueOnce({
                Items: attendees,
              });

            // Mock SES to resolve successfully
            mockSesSend.mockResolvedValue({});

            const payload = {
              type: emailType,
              eventId,
              playbackUrl,
              duration,
            };

            const result = await handler(payload);

            // Handler should succeed
            expect(result.statusCode).toBe(200);

            // SES should be called exactly N times (once per attendee)
            expect(mockSesSend).toHaveBeenCalledTimes(n);

            // Each attendee's email should appear in exactly one SES call's Destination.ToAddresses
            const sentToAddresses = mockSesSend.mock.calls.map(
              (call) => call[0].input.Destination.ToAddresses[0]
            );

            // Every attendee email must be present
            for (const email of attendeeEmails) {
              expect(sentToAddresses).toContain(email);
            }

            // No duplicates — each email appears exactly once
            const uniqueSent = new Set(sentToAddresses);
            expect(uniqueSent.size).toBe(n);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
