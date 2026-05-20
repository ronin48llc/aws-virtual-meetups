'use strict';

/**
 * Tests for recipient-locale-aware email templates (issue #9).
 *
 * Exercises the templates.js renderer directly with locale=en-US and
 * locale=es-US, then exercises the email-sender index.js flow with the
 * full SES SendRawEmail path (signup-confirmation also gets the ICS
 * attachment via the existing #10 work — locale must thread through
 * both paths).
 */

const { renderTemplate, getStrings, formatEmailDate, DEFAULT_LOCALE } = require('../../lambda/email-sender/templates');

describe('templates.js — getStrings (issue #9)', () => {
  test('returns the en-US dict by default', () => {
    const s = getStrings();
    expect(s.signupConfirmation.heading).toBe("You're Registered!");
  });

  test('returns the en-US dict for an unknown locale', () => {
    const s = getStrings('klingon');
    expect(s.signupConfirmation.heading).toBe("You're Registered!");
  });

  test('returns the es-US dict for locale=es-US', () => {
    const s = getStrings('es-US');
    expect(s.signupConfirmation.heading).toBe('¡Estás inscrito!');
    expect(s.signupConfirmation.subjectPrefix).toBe('Inscripción confirmada');
    expect(s.signupConfirmation.viewButton).toBe('Ver evento');
  });

  test('DEFAULT_LOCALE is en-US', () => {
    expect(DEFAULT_LOCALE).toBe('en-US');
  });
});

describe('templates.js — formatEmailDate (issue #9)', () => {
  // 2026-05-19T18:00:00Z is a Tuesday
  const iso = '2026-05-19T18:00:00.000Z';

  test('defaults to en-US and UTC when no args given', () => {
    const s = formatEmailDate(iso);
    expect(s).toMatch(/Tuesday/);
    expect(s).toMatch(/UTC/);
  });

  test('honors a non-default locale', () => {
    const s = formatEmailDate(iso, 'es-US', 'UTC');
    // 'martes' is Tuesday in Spanish
    expect(s.toLowerCase()).toMatch(/martes/);
  });

  test('honors a non-default timezone', () => {
    const s = formatEmailDate(iso, 'en-US', 'America/Chicago');
    // 18:00Z = 13:00 in Chicago summer (CDT)
    expect(s).toMatch(/1:00/);
  });

  test('falls back to UTC + en-US when timezone is invalid (third-pass audit)', () => {
    // 'Mars/Olympus_Mons' is not a real IANA timezone; without the fallback
    // this would throw RangeError and crash the email send.
    const s = formatEmailDate(iso, 'en-US', 'Mars/Olympus_Mons');
    expect(s).toMatch(/UTC/);
    expect(s).toMatch(/Tuesday/);
  });

  test('falls back to UTC + en-US when locale is invalid', () => {
    const s = formatEmailDate(iso, 'fictional-LOCALE', 'UTC');
    expect(s).toMatch(/Tuesday/);
    expect(s).toMatch(/UTC/);
  });
});

describe('templates.js — renderSignupConfirmation locale switching (issue #9)', () => {
  const baseData = {
    eventTitle: 'Test Event',
    scheduledStart: '2026-05-19T18:00:00.000Z',
    eventUrl: 'https://example.com/events/evt_123',
    recipientName: 'Jane Doe',
  };

  test('renders en-US strings when no locale passed', () => {
    const r = renderTemplate('signup-confirmation', baseData);
    expect(r.subject).toContain('Sign-Up Confirmed');
    expect(r.html).toContain("You're Registered!");
    expect(r.html).toContain('Hi Jane Doe,');
    expect(r.html).toContain('You have successfully signed up');
    expect(r.html).toContain('>View Event<');
  });

  test('renders es-US strings when locale=es-US', () => {
    const r = renderTemplate('signup-confirmation', { ...baseData, locale: 'es-US' });
    expect(r.subject).toContain('Inscripción confirmada');
    expect(r.html).toContain('¡Estás inscrito!');
    expect(r.html).toContain('Hola Jane Doe,');
    expect(r.html).toContain('Te has registrado');
    expect(r.html).toContain('>Ver evento<');
  });

  test('plain-text body is also localized', () => {
    const r = renderTemplate('signup-confirmation', { ...baseData, locale: 'es-US' });
    expect(r.text).toContain('¡Estás inscrito!');
    expect(r.text).toContain('Ver evento:');
    expect(r.text).toContain('Comienzo programado:');
  });

  test('falls back to en-US for unknown locale codes', () => {
    const r = renderTemplate('signup-confirmation', { ...baseData, locale: 'fictional-LOCALE' });
    expect(r.html).toContain("You're Registered!");
  });

  test('handles anonymous greeting per locale', () => {
    const r = renderTemplate('signup-confirmation', { ...baseData, recipientName: '', locale: 'es-US' });
    expect(r.html).toContain('Hola,');
    expect(r.html).not.toContain('Hola Jane Doe');
  });
});

// --- End-to-end through the Lambda handler ---

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
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  QueryCommand: jest.fn((params) => ({ type: 'Query', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));
process.env.TABLE_NAME = 'VirtualMeetupTable';
process.env.SES_SENDER = 'phannah@thenetwerk.net';
process.env.FRONTEND_URL = 'https://d2hbje3cen4qrx.cloudfront.net';

const { handler } = require('../../lambda/email-sender/index');

describe('email-sender handler — locale threaded through signup-confirmation (issue #9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSesSend.mockResolvedValue({});
  });

  /**
   * Extract and base64-decode the text/html part of a multipart/mixed
   * MIME body so we can search for plaintext strings in the rendered
   * HTML the recipient would see.
   *
   * @param {string} raw
   * @returns {string} decoded HTML
   */
  function extractHtmlBody(raw) {
    const m = raw.match(/Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/);
    if (!m) throw new Error('Could not find HTML part in MIME body');
    return Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  }

  test('respects payload.recipientLocale = "es-US"', async () => {
    mockDocSend.mockResolvedValueOnce({
      Item: { title: 'Test Event', description: 'd', scheduledStart: '2026-05-19T18:00:00Z', durationMinutes: 60 },
    });

    await handler({
      type: 'signup-confirmation',
      eventId: 'evt_abc',
      recipientEmail: 'jane@example.com',
      recipientName: 'Jane Doe',
      eventTitle: 'Test Event',
      scheduledStart: '2026-05-19T18:00:00Z',
      recipientLocale: 'es-US',
    });

    const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
    expect(SendRawEmailCommand).toHaveBeenCalledTimes(1);
    const raw = SendRawEmailCommand.mock.calls[0][0].RawMessage.Data.toString('utf8');

    const html = extractHtmlBody(raw);
    expect(html).toContain('¡Estás inscrito!');
    expect(html).toContain('Ver evento');

    // Subject header is RFC 2047 base64-encoded when non-ASCII
    const subjMatch = raw.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/);
    expect(subjMatch).toBeTruthy();
    const decodedSubject = Buffer.from(subjMatch[1], 'base64').toString('utf8');
    expect(decodedSubject).toContain('Inscripción confirmada');
  });

  test('defaults to en-US when payload.recipientLocale is absent', async () => {
    mockDocSend.mockResolvedValueOnce({
      Item: { title: 'Test Event', description: 'd', scheduledStart: '2026-05-19T18:00:00Z', durationMinutes: 60 },
    });

    await handler({
      type: 'signup-confirmation',
      eventId: 'evt_abc',
      recipientEmail: 'jane@example.com',
      recipientName: 'Jane Doe',
      eventTitle: 'Test Event',
      scheduledStart: '2026-05-19T18:00:00Z',
    });

    const { SendRawEmailCommand } = require('@aws-sdk/client-ses');
    const raw = SendRawEmailCommand.mock.calls[0][0].RawMessage.Data.toString('utf8');
    const html = extractHtmlBody(raw);
    expect(html).toContain("You're Registered!");
  });
});
