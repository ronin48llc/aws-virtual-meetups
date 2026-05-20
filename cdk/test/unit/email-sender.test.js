'use strict';

// Mock AWS SDK clients
const mockSesSend = jest.fn();
const mockDocSend = jest.fn();

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn(() => ({ send: mockSesSend })),
  SendEmailCommand: jest.fn((params) => ({ type: 'SendEmail', input: params })),
  SendRawEmailCommand: jest.fn((params) => ({ type: 'SendRawEmail', input: params })),
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

describe('Email Sender Lambda Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSesSend.mockResolvedValue({});
  });

  describe('handler routing', () => {
    it('handles event-created type as single-recipient', async () => {
      const payload = {
        type: 'event-created',
        eventId: 'evt_123',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    it('handles signup-confirmation type as single-recipient', async () => {
      // signup-confirmation now looks up event metadata to build an ICS
      // attachment. Provide a minimal metadata response so the lookup
      // doesn't return undefined.
      mockDocSend.mockResolvedValueOnce({
        Item: { title: 'Test Event', description: 'desc', scheduledStart: '2024-03-15T18:00:00Z', durationMinutes: 60 },
      });

      const payload = {
        type: 'signup-confirmation',
        eventId: 'evt_123',
        recipientEmail: 'attendee@example.com',
        recipientName: 'Jane Doe',
        eventTitle: 'Test Event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    it('handles day-before-reminder type as bulk', async () => {
      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z' } })
        .mockResolvedValueOnce({ Items: [{ userId: 'u1', displayName: 'User 1', email: 'u1@example.com', registeredAt: '2024-01-01T00:00:00Z' }] });

      const payload = { type: 'day-before-reminder', eventId: 'evt_123' };
      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    it('handles hour-before-reminder type as bulk', async () => {
      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z' } })
        .mockResolvedValueOnce({ Items: [{ userId: 'u1', displayName: 'User 1', email: 'u1@example.com', registeredAt: '2024-01-01T00:00:00Z' }] });

      const payload = { type: 'hour-before-reminder', eventId: 'evt_123' };
      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    it('handles event-started type as bulk', async () => {
      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z' } })
        .mockResolvedValueOnce({ Items: [{ userId: 'u1', displayName: 'User 1', email: 'u1@example.com', registeredAt: '2024-01-01T00:00:00Z' }] });

      const payload = { type: 'event-started', eventId: 'evt_123' };
      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    it('handles recap type as bulk', async () => {
      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z', hlsPlaybackUrl: 'https://example.com/playback' } })
        .mockResolvedValueOnce({ Items: [{ userId: 'u1', displayName: 'User 1', email: 'u1@example.com', registeredAt: '2024-01-01T00:00:00Z' }] });

      const payload = { type: 'recap', eventId: 'evt_123', playbackUrl: 'https://example.com/playback', duration: 3600 };
      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(1);
    });

    it('returns 400 for missing type field', async () => {
      const result = await handler({});
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('Missing type field');
    });

    it('returns 400 for unknown type', async () => {
      const result = await handler({ type: 'unknown-type' });
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('Unknown email type');
    });
  });

  describe('SES call construction', () => {
    it('uses correct Source address with display name', async () => {
      const payload = {
        type: 'event-created',
        eventId: 'evt_123',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      await handler(payload);

      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      expect(SendEmailCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Source: 'Virtual Meetup Platform <phannah@thenetwerk.net>',
        })
      );
    });

    it('sets correct Destination ToAddresses', async () => {
      const payload = {
        type: 'event-created',
        eventId: 'evt_123',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      await handler(payload);

      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      expect(SendEmailCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Destination: { ToAddresses: ['organizer@example.com'] },
        })
      );
    });

    it('includes HTML and plain-text body in Message', async () => {
      const payload = {
        type: 'event-created',
        eventId: 'evt_123',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      await handler(payload);

      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      const callArgs = SendEmailCommand.mock.calls[0][0];
      expect(callArgs.Message.Body.Html.Data).toBeTruthy();
      expect(callArgs.Message.Body.Text.Data).toBeTruthy();
      expect(callArgs.Message.Subject.Data).toBeTruthy();
    });

    it('From address is always phannah@thenetwerk.net', async () => {
      // Use event-created (still routes through SendEmailCommand). The
      // signup-confirmation path uses SendRawEmailCommand and is covered
      // by the "signup-confirmation ICS" describe block below.
      const payload = {
        type: 'event-created',
        eventId: 'evt_456',
        recipientEmail: 'user@example.com',
        recipientName: 'User',
        eventTitle: 'Another Event',
        eventDescription: 'desc',
        scheduledStart: '2024-04-01T10:00:00Z',
      };

      await handler(payload);

      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      expect(SendEmailCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Source: expect.stringContaining('phannah@thenetwerk.net'),
        })
      );
    });
  });

  describe('signup-confirmation ICS attachment', () => {
    const baseEventMetadata = {
      title: 'Test Event',
      description: 'A test event description',
      scheduledStart: '2026-05-19T18:00:00Z',
      durationMinutes: 60,
    };

    const basePayload = {
      type: 'signup-confirmation',
      eventId: 'evt_123',
      recipientEmail: 'attendee@example.com',
      recipientName: 'Jane Doe',
      eventTitle: 'Test Event',
      scheduledStart: '2026-05-19T18:00:00Z',
    };

    it('sends via SendRawEmailCommand with an ICS attachment when event metadata is complete', async () => {
      mockDocSend.mockResolvedValueOnce({ Item: { ...baseEventMetadata } });

      const result = await handler(basePayload);
      expect(result.statusCode).toBe(200);

      const { SendRawEmailCommand, SendEmailCommand } = require('@aws-sdk/client-ses');
      expect(SendRawEmailCommand).toHaveBeenCalledTimes(1);
      expect(SendEmailCommand).not.toHaveBeenCalled();

      const callArgs = SendRawEmailCommand.mock.calls[0][0];
      expect(callArgs.Source).toBe(process.env.SES_SENDER);
      expect(callArgs.Destinations).toEqual(['attendee@example.com']);
      expect(Buffer.isBuffer(callArgs.RawMessage.Data)).toBe(true);

      const rawBody = callArgs.RawMessage.Data.toString('utf8');
      expect(rawBody).toContain('Content-Type: multipart/mixed;');
      expect(rawBody).toContain('Content-Type: text/calendar; method=REQUEST; charset=UTF-8; name="event.ics"');
      expect(rawBody).toContain('Content-Disposition: attachment; filename="event.ics"');
    });

    it('the ICS payload contains the event title, start, and duration', async () => {
      mockDocSend.mockResolvedValueOnce({ Item: { ...baseEventMetadata } });

      await handler(basePayload);

      const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
      const rawBody = SendRawEmailCommand.mock.calls[0][0].RawMessage.Data.toString('utf8');

      // The ICS body is base64-encoded inside the MIME envelope. Pull the
      // attachment block and decode.
      const attachmentMatch = rawBody.match(/Content-Disposition: attachment; filename="event\.ics"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/);
      expect(attachmentMatch).toBeTruthy();
      const b64 = attachmentMatch[1].replace(/\r\n/g, '');
      const ics = Buffer.from(b64, 'base64').toString('utf8');

      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('METHOD:REQUEST');
      expect(ics).toContain('UID:evt_123@');
      expect(ics).toContain('DTSTART:20260519T180000Z');
      expect(ics).toContain('DURATION:PT60M');
      expect(ics).toContain('SUMMARY:Test Event');
      expect(ics).toContain('DESCRIPTION:A test event description');
      expect(ics).toContain('END:VCALENDAR');
    });

    it('falls back to SendEmailCommand when event metadata is missing', async () => {
      mockDocSend.mockResolvedValueOnce({ Item: null });

      const result = await handler(basePayload);
      expect(result.statusCode).toBe(200);

      const { SendRawEmailCommand, SendEmailCommand } = require('@aws-sdk/client-ses');
      expect(SendRawEmailCommand).not.toHaveBeenCalled();
      expect(SendEmailCommand).toHaveBeenCalledTimes(1);
    });

    it('falls back to SendEmailCommand when durationMinutes is missing from metadata', async () => {
      const { _durationMinutes, ...withoutDuration } = baseEventMetadata;
      mockDocSend.mockResolvedValueOnce({ Item: withoutDuration });

      const result = await handler(basePayload);
      expect(result.statusCode).toBe(200);

      const { SendRawEmailCommand, SendEmailCommand } = require('@aws-sdk/client-ses');
      expect(SendRawEmailCommand).not.toHaveBeenCalled();
      expect(SendEmailCommand).toHaveBeenCalledTimes(1);
    });

    it('derives durationMinutes from a "duration" (seconds) field when "durationMinutes" is absent', async () => {
      mockDocSend.mockResolvedValueOnce({
        Item: { ...baseEventMetadata, durationMinutes: undefined, duration: 90 * 60 },
      });

      await handler(basePayload);

      const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
      const rawBody = SendRawEmailCommand.mock.calls[0][0].RawMessage.Data.toString('utf8');
      const attachmentMatch = rawBody.match(/Content-Disposition: attachment; filename="event\.ics"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/);
      const ics = Buffer.from(attachmentMatch[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
      expect(ics).toContain('DURATION:PT90M');
    });

    it('uses the FRONTEND_URL hostname as the UID domain', async () => {
      mockDocSend.mockResolvedValueOnce({ Item: { ...baseEventMetadata } });

      await handler(basePayload);

      const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
      const rawBody = SendRawEmailCommand.mock.calls[0][0].RawMessage.Data.toString('utf8');
      const attachmentMatch = rawBody.match(/Content-Disposition: attachment; filename="event\.ics"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/);
      const ics = Buffer.from(attachmentMatch[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
      // FRONTEND_URL = https://d2hbje3cen4qrx.cloudfront.net (set above)
      expect(ics).toContain('UID:evt_123@d2hbje3cen4qrx.cloudfront.net');
    });

    it('logs but does not throw when SES rejects the SendRawEmail call', async () => {
      mockDocSend.mockResolvedValueOnce({ Item: { ...baseEventMetadata } });
      mockSesSend.mockRejectedValueOnce(new Error('SES throttle'));

      const result = await handler(basePayload);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('error handling', () => {
    it('logs SES failure but does not throw', async () => {
      mockSesSend.mockRejectedValueOnce(new Error('SES throttle'));

      const payload = {
        type: 'event-created',
        eventId: 'evt_123',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      // Should not throw
      const result = await handler(payload);
      expect(result.statusCode).toBe(200);
    });

    it('continues sending to remaining recipients after one failure', async () => {
      mockSesSend
        .mockRejectedValueOnce(new Error('SES error'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z' } })
        .mockResolvedValueOnce({
          Items: [
            { userId: 'u1', displayName: 'User 1', email: 'u1@example.com', registeredAt: '2024-01-01T00:00:00Z' },
            { userId: 'u2', displayName: 'User 2', email: 'u2@example.com', registeredAt: '2024-01-01T00:00:00Z' },
            { userId: 'u3', displayName: 'User 3', email: 'u3@example.com', registeredAt: '2024-01-01T00:00:00Z' },
          ],
        });

      const payload = { type: 'day-before-reminder', eventId: 'evt_123' };
      const result = await handler(payload);

      expect(result.statusCode).toBe(200);
      // All 3 sends attempted even though first failed
      expect(mockSesSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('empty attendee list', () => {
    it('skips sending when no attendees found for bulk types', async () => {
      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z' } })
        .mockResolvedValueOnce({ Items: [] });

      const payload = { type: 'day-before-reminder', eventId: 'evt_123' };
      const result = await handler(payload);

      expect(result.statusCode).toBe(200);
      expect(mockSesSend).not.toHaveBeenCalled();
    });
  });

  describe('orphaned trigger (deleted event)', () => {
    it('skips sending when event not found', async () => {
      mockDocSend.mockResolvedValueOnce({ Item: undefined });

      const payload = { type: 'event-started', eventId: 'evt_deleted' };
      const result = await handler(payload);

      expect(result.statusCode).toBe(200);
      expect(mockSesSend).not.toHaveBeenCalled();
    });
  });

  describe('bulk email sends to all attendees', () => {
    it('sends one email per attendee', async () => {
      const attendees = [
        { userId: 'u1', displayName: 'User 1', email: 'u1@example.com', registeredAt: '2024-01-01T00:00:00Z' },
        { userId: 'u2', displayName: 'User 2', email: 'u2@example.com', registeredAt: '2024-01-02T00:00:00Z' },
        { userId: 'u3', displayName: 'User 3', email: 'u3@example.com', registeredAt: '2024-01-03T00:00:00Z' },
      ];

      mockDocSend
        .mockResolvedValueOnce({ Item: { title: 'Test Event', description: 'Desc', scheduledStart: '2024-03-15T18:00:00Z' } })
        .mockResolvedValueOnce({ Items: attendees });

      const payload = { type: 'hour-before-reminder', eventId: 'evt_123' };
      const result = await handler(payload);

      expect(result.statusCode).toBe(200);
      expect(mockSesSend).toHaveBeenCalledTimes(3);

      // Verify each attendee received their own email
      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      const recipients = SendEmailCommand.mock.calls.map(call => call[0].Destination.ToAddresses[0]);
      expect(recipients).toContain('u1@example.com');
      expect(recipients).toContain('u2@example.com');
      expect(recipients).toContain('u3@example.com');
    });
  });

  describe('event URL construction', () => {
    it('builds event URL from FRONTEND_URL when not provided in payload', async () => {
      const payload = {
        type: 'event-created',
        eventId: 'evt_abc',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
      };

      await handler(payload);

      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      const callArgs = SendEmailCommand.mock.calls[0][0];
      expect(callArgs.Message.Body.Html.Data).toContain('https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc');
    });

    it('uses eventUrl from payload when provided', async () => {
      const payload = {
        type: 'event-created',
        eventId: 'evt_abc',
        recipientEmail: 'organizer@example.com',
        recipientName: 'Organizer',
        eventTitle: 'Test Event',
        eventDescription: 'A test event',
        scheduledStart: '2024-03-15T18:00:00Z',
        eventUrl: 'https://custom-url.com/events/evt_abc',
      };

      await handler(payload);

      const { SendEmailCommand } = require('@aws-sdk/client-ses');
      const callArgs = SendEmailCommand.mock.calls[0][0];
      expect(callArgs.Message.Body.Html.Data).toContain('https://custom-url.com/events/evt_abc');
    });
  });
});
