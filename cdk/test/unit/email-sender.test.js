'use strict';

// Mock AWS SDK clients
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
      const payload = {
        type: 'signup-confirmation',
        eventId: 'evt_456',
        recipientEmail: 'user@example.com',
        recipientName: 'User',
        eventTitle: 'Another Event',
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
