'use strict';

const {
  buildIcsPayload,
  escapeIcsText,
  formatIcsDate,
  foldIcsLine,
} = require('../../lambda/email-sender/ics-builder');

describe('ics-builder', () => {
  describe('escapeIcsText', () => {
    it('returns empty string for null/undefined input', () => {
      expect(escapeIcsText(null)).toBe('');
      expect(escapeIcsText(undefined)).toBe('');
    });

    it('escapes backslash, semicolon, comma, and newline per RFC 5545', () => {
      expect(escapeIcsText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
      expect(escapeIcsText('line1\nline2')).toBe('line1\\nline2');
      expect(escapeIcsText('line1\r\nline2')).toBe('line1\\nline2');
    });

    it('leaves plain text unchanged', () => {
      expect(escapeIcsText('Hello world')).toBe('Hello world');
    });
  });

  describe('formatIcsDate', () => {
    it('formats a Date object as YYYYMMDDTHHMMSSZ in UTC', () => {
      // 2026-05-19T14:30:00Z
      const d = new Date(Date.UTC(2026, 4, 19, 14, 30, 0));
      expect(formatIcsDate(d)).toBe('20260519T143000Z');
    });

    it('accepts an ISO-8601 string and normalizes to UTC', () => {
      expect(formatIcsDate('2026-05-19T14:30:00Z')).toBe('20260519T143000Z');
    });

    it('converts a non-UTC ISO string to UTC', () => {
      // 2026-05-19T10:30:00-04:00 == 2026-05-19T14:30:00Z
      expect(formatIcsDate('2026-05-19T10:30:00-04:00')).toBe('20260519T143000Z');
    });

    it('pads month/day/hour/minute/second to two digits', () => {
      const d = new Date(Date.UTC(2026, 0, 5, 3, 7, 9));
      expect(formatIcsDate(d)).toBe('20260105T030709Z');
    });

    it('throws on invalid input', () => {
      expect(() => formatIcsDate('not a date')).toThrow(/Invalid date/);
    });
  });

  describe('foldIcsLine', () => {
    it('returns the line unchanged when ≤ 75 characters', () => {
      const line = 'SUMMARY:Short';
      expect(foldIcsLine(line)).toBe(line);
    });

    it('folds long lines at 75 octets with leading space on continuations', () => {
      const long = 'X'.repeat(200);
      const folded = foldIcsLine(long);
      const parts = folded.split('\r\n');
      expect(parts[0].length).toBe(75);
      // Continuation lines start with a single space then up to 74 chars
      for (let i = 1; i < parts.length; i++) {
        expect(parts[i].startsWith(' ')).toBe(true);
        expect(parts[i].length).toBeLessThanOrEqual(75);
      }
      // No content lost
      expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(long);
    });
  });

  describe('buildIcsPayload', () => {
    const baseParams = {
      uid: 'evt_123@example.com',
      start: '2026-05-19T14:30:00Z',
      durationMinutes: 60,
      summary: 'Virtual Meetup Test',
      now: new Date(Date.UTC(2026, 4, 1, 12, 0, 0)), // fixed DTSTAMP
    };

    it('produces a valid ICS payload terminated with CRLF', () => {
      const ics = buildIcsPayload(baseParams);
      expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
      expect(ics).toMatch(/END:VCALENDAR\r\n$/);
    });

    it('includes all required VEVENT properties', () => {
      const ics = buildIcsPayload(baseParams);
      expect(ics).toContain('UID:evt_123@example.com');
      expect(ics).toContain('DTSTART:20260519T143000Z');
      expect(ics).toContain('DTSTAMP:20260501T120000Z');
      expect(ics).toContain('DURATION:PT60M');
      expect(ics).toContain('SUMMARY:Virtual Meetup Test');
      expect(ics).toContain('SEQUENCE:0');
      expect(ics).toContain('STATUS:CONFIRMED');
      expect(ics).toContain('METHOD:REQUEST');
    });

    it('omits optional fields when not supplied', () => {
      const ics = buildIcsPayload(baseParams);
      expect(ics).not.toContain('DESCRIPTION');
      expect(ics).not.toContain('URL:');
      expect(ics).not.toContain('ORGANIZER');
    });

    it('includes DESCRIPTION, URL, and ORGANIZER when supplied', () => {
      const ics = buildIcsPayload({
        ...baseParams,
        description: 'A test event for the suite.',
        url: 'https://example.com/events/evt_123',
        organizerEmail: 'organizer@example.com',
        organizerName: 'Test Organizer',
      });
      expect(ics).toContain('DESCRIPTION:A test event for the suite.');
      expect(ics).toContain('URL:https://example.com/events/evt_123');
      expect(ics).toContain('ORGANIZER;CN=Test Organizer:mailto:organizer@example.com');
    });

    it('escapes special characters in SUMMARY and DESCRIPTION', () => {
      const ics = buildIcsPayload({
        ...baseParams,
        summary: 'Live: Q&A, demos; bring snacks',
        description: 'Line 1\nLine 2; with semicolons',
      });
      expect(ics).toContain('SUMMARY:Live: Q&A\\, demos\\; bring snacks');
      expect(ics).toContain('DESCRIPTION:Line 1\\nLine 2\\; with semicolons');
    });

    it('honors a custom SEQUENCE for updates', () => {
      const ics = buildIcsPayload({ ...baseParams, sequence: 3 });
      expect(ics).toContain('SEQUENCE:3');
    });

    it('throws when required fields are missing', () => {
      expect(() => buildIcsPayload({ ...baseParams, uid: undefined })).toThrow(/uid/);
      expect(() => buildIcsPayload({ ...baseParams, start: undefined })).toThrow(/start/);
      expect(() => buildIcsPayload({ ...baseParams, summary: undefined })).toThrow(/summary/);
      expect(() => buildIcsPayload({ ...baseParams, durationMinutes: 0 })).toThrow(/durationMinutes/);
      expect(() => buildIcsPayload({ ...baseParams, durationMinutes: -5 })).toThrow(/durationMinutes/);
      expect(() => buildIcsPayload({ ...baseParams, durationMinutes: 'long' })).toThrow(/durationMinutes/);
    });

    it('folds long property lines at 75 octets', () => {
      const longSummary = 'A '.repeat(80).trim(); // ~159 chars
      const ics = buildIcsPayload({ ...baseParams, summary: longSummary });
      // Find the SUMMARY block (line + continuations)
      const idx = ics.indexOf('SUMMARY:');
      const summaryBlock = ics.slice(idx).split('\r\n');
      // First line should be ≤ 75 chars
      expect(summaryBlock[0].length).toBeLessThanOrEqual(75);
    });
  });
});
