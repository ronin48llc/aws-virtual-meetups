'use strict';

const fc = require('fast-check');
const { renderTemplate, formatEmailDate } = require('../../lambda/email-sender/templates');

// --- Arbitraries ---

// Safe characters that won't be transformed by HTML escaping.
// This constrains the input space to strings that appear identically in both
// HTML and plain-text output, letting us assert content presence directly.
const SAFE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?:;-_()[]{}+=#@$/';

// Event title: non-empty string from safe characters
const arbEventTitle = fc.stringOf(
  fc.constantFrom(...SAFE_CHARS.split('')),
  { minLength: 1, maxLength: 100 }
).filter((s) => s.trim().length > 0);

// Event description: non-empty string from safe characters
const arbEventDescription = fc.stringOf(
  fc.constantFrom(...SAFE_CHARS.split('')),
  { minLength: 1, maxLength: 200 }
).filter((s) => s.trim().length > 0);

// ISO date string: valid future date
const arbScheduledStart = fc.integer({ min: 1600000000000, max: 1900000000000 })
  .map((ms) => new Date(ms).toISOString());

// URL: valid-looking URL
const arbEventUrl = fc.string({ minLength: 5, maxLength: 50 })
  .filter((s) => /^[a-zA-Z0-9/_-]+$/.test(s))
  .map((s) => `https://example.com/events/${s}`);

// Playback URL
const arbPlaybackUrl = fc.string({ minLength: 5, maxLength: 50 })
  .filter((s) => /^[a-zA-Z0-9/_-]+$/.test(s))
  .map((s) => `https://cdn.example.com/recordings/${s}`);

// Duration in seconds (for recap)
const arbDuration = fc.integer({ min: 60, max: 36000 });

// Recipient name: safe characters only
const arbRecipientName = fc.stringOf(
  fc.constantFrom(...SAFE_CHARS.split('')),
  { minLength: 1, maxLength: 50 }
).filter((s) => s.trim().length > 0);

// --- Data generators per template type ---

const arbEventCreatedData = fc.record({
  eventTitle: arbEventTitle,
  eventDescription: arbEventDescription,
  scheduledStart: arbScheduledStart,
  eventUrl: arbEventUrl,
});

const arbSignupConfirmationData = fc.record({
  eventTitle: arbEventTitle,
  scheduledStart: arbScheduledStart,
  eventUrl: arbEventUrl,
  recipientName: arbRecipientName,
});

const arbDayBeforeReminderData = fc.record({
  eventTitle: arbEventTitle,
  scheduledStart: arbScheduledStart,
  eventUrl: arbEventUrl,
});

const arbHourBeforeReminderData = fc.record({
  eventTitle: arbEventTitle,
  scheduledStart: arbScheduledStart,
  eventUrl: arbEventUrl,
});

const arbEventStartedData = fc.record({
  eventTitle: arbEventTitle,
  eventUrl: arbEventUrl,
});

const arbRecapData = fc.record({
  eventTitle: arbEventTitle,
  playbackUrl: arbPlaybackUrl,
  duration: arbDuration,
});

// --- Property Tests ---

describe('Email Notifications Property Tests', () => {
  /**
   * Property 1: Email Template Content Completeness
   * Feature: email-notifications, Property 1: Email Template Content Completeness
   * **Validates: Requirements 1.2, 2.2, 3.3, 4.3, 5.2, 6.2**
   *
   * For any valid event data and any email type, the rendered template contains
   * all required fields in both HTML and plain-text bodies.
   */
  describe('Property 1: Email Template Content Completeness', () => {
    it('event-created template contains eventTitle, eventDescription, formatted date, and eventUrl in both html and text', () => {
      fc.assert(
        fc.property(
          arbEventCreatedData,
          (data) => {
            const result = renderTemplate('event-created', data);
            const formattedDate = formatEmailDate(data.scheduledStart);

            // HTML body contains all required fields
            expect(result.html).toContain(data.eventTitle);
            expect(result.html).toContain(data.eventDescription);
            expect(result.html).toContain(formattedDate);
            expect(result.html).toContain(data.eventUrl);

            // Plain-text body contains all required fields
            expect(result.text).toContain(data.eventTitle);
            expect(result.text).toContain(data.eventDescription);
            expect(result.text).toContain(formattedDate);
            expect(result.text).toContain(data.eventUrl);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('signup-confirmation template contains eventTitle, formatted date, and eventUrl in both html and text', () => {
      fc.assert(
        fc.property(
          arbSignupConfirmationData,
          (data) => {
            const result = renderTemplate('signup-confirmation', data);
            const formattedDate = formatEmailDate(data.scheduledStart);

            // HTML body contains all required fields
            expect(result.html).toContain(data.eventTitle);
            expect(result.html).toContain(formattedDate);
            expect(result.html).toContain(data.eventUrl);

            // Plain-text body contains all required fields
            expect(result.text).toContain(data.eventTitle);
            expect(result.text).toContain(formattedDate);
            expect(result.text).toContain(data.eventUrl);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('day-before-reminder template contains eventTitle, formatted date, and eventUrl in both html and text', () => {
      fc.assert(
        fc.property(
          arbDayBeforeReminderData,
          (data) => {
            const result = renderTemplate('day-before-reminder', data);
            const formattedDate = formatEmailDate(data.scheduledStart);

            // HTML body contains all required fields
            expect(result.html).toContain(data.eventTitle);
            expect(result.html).toContain(formattedDate);
            expect(result.html).toContain(data.eventUrl);

            // Plain-text body contains all required fields
            expect(result.text).toContain(data.eventTitle);
            expect(result.text).toContain(formattedDate);
            expect(result.text).toContain(data.eventUrl);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('hour-before-reminder template contains eventTitle, formatted date, and eventUrl in both html and text', () => {
      fc.assert(
        fc.property(
          arbHourBeforeReminderData,
          (data) => {
            const result = renderTemplate('hour-before-reminder', data);
            const formattedDate = formatEmailDate(data.scheduledStart);

            // HTML body contains all required fields
            expect(result.html).toContain(data.eventTitle);
            expect(result.html).toContain(formattedDate);
            expect(result.html).toContain(data.eventUrl);

            // Plain-text body contains all required fields
            expect(result.text).toContain(data.eventTitle);
            expect(result.text).toContain(formattedDate);
            expect(result.text).toContain(data.eventUrl);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('event-started template contains eventTitle and eventUrl in both html and text', () => {
      fc.assert(
        fc.property(
          arbEventStartedData,
          (data) => {
            const result = renderTemplate('event-started', data);

            // HTML body contains all required fields
            expect(result.html).toContain(data.eventTitle);
            expect(result.html).toContain(data.eventUrl);

            // Plain-text body contains all required fields
            expect(result.text).toContain(data.eventTitle);
            expect(result.text).toContain(data.eventUrl);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('recap template contains eventTitle and playbackUrl in both html and text', () => {
      fc.assert(
        fc.property(
          arbRecapData,
          (data) => {
            const result = renderTemplate('recap', data);

            // HTML body contains all required fields
            expect(result.html).toContain(data.eventTitle);
            expect(result.html).toContain(data.playbackUrl);

            // Plain-text body contains all required fields
            expect(result.text).toContain(data.eventTitle);
            expect(result.text).toContain(data.playbackUrl);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 8: Email Structural Format
   * Feature: email-notifications, Property 8: Email Structural Format
   * **Validates: Requirements 9.1, 9.2, 9.3**
   *
   * For any composed email regardless of type or input data, the email SHALL have:
   * (a) a non-empty HTML body, (b) a non-empty plain-text body,
   * (c) a subject line containing "AWS Virtual Meetups", and
   * (d) an unsubscribe instruction in the footer.
   */
  describe('Property 8: Email Structural Format', () => {
    it('event-created email has non-empty html, non-empty text, subject with platform name, and unsubscribe instruction', () => {
      fc.assert(
        fc.property(
          arbEventCreatedData,
          (data) => {
            const result = renderTemplate('event-created', data);

            expect(result.html.length).toBeGreaterThan(0);
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.subject).toContain('AWS Virtual Meetups');
            expect(result.html.toLowerCase()).toContain('unsubscribe');
            expect(result.text.toLowerCase()).toContain('unsubscribe');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('signup-confirmation email has non-empty html, non-empty text, subject with platform name, and unsubscribe instruction', () => {
      fc.assert(
        fc.property(
          arbSignupConfirmationData,
          (data) => {
            const result = renderTemplate('signup-confirmation', data);

            expect(result.html.length).toBeGreaterThan(0);
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.subject).toContain('AWS Virtual Meetups');
            expect(result.html.toLowerCase()).toContain('unsubscribe');
            expect(result.text.toLowerCase()).toContain('unsubscribe');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('day-before-reminder email has non-empty html, non-empty text, subject with platform name, and unsubscribe instruction', () => {
      fc.assert(
        fc.property(
          arbDayBeforeReminderData,
          (data) => {
            const result = renderTemplate('day-before-reminder', data);

            expect(result.html.length).toBeGreaterThan(0);
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.subject).toContain('AWS Virtual Meetups');
            expect(result.html.toLowerCase()).toContain('unsubscribe');
            expect(result.text.toLowerCase()).toContain('unsubscribe');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('hour-before-reminder email has non-empty html, non-empty text, subject with platform name, and unsubscribe instruction', () => {
      fc.assert(
        fc.property(
          arbHourBeforeReminderData,
          (data) => {
            const result = renderTemplate('hour-before-reminder', data);

            expect(result.html.length).toBeGreaterThan(0);
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.subject).toContain('AWS Virtual Meetups');
            expect(result.html.toLowerCase()).toContain('unsubscribe');
            expect(result.text.toLowerCase()).toContain('unsubscribe');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('event-started email has non-empty html, non-empty text, subject with platform name, and unsubscribe instruction', () => {
      fc.assert(
        fc.property(
          arbEventStartedData,
          (data) => {
            const result = renderTemplate('event-started', data);

            expect(result.html.length).toBeGreaterThan(0);
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.subject).toContain('AWS Virtual Meetups');
            expect(result.html.toLowerCase()).toContain('unsubscribe');
            expect(result.text.toLowerCase()).toContain('unsubscribe');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('recap email has non-empty html, non-empty text, subject with platform name, and unsubscribe instruction', () => {
      fc.assert(
        fc.property(
          arbRecapData,
          (data) => {
            const result = renderTemplate('recap', data);

            expect(result.html.length).toBeGreaterThan(0);
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.subject).toContain('AWS Virtual Meetups');
            expect(result.html.toLowerCase()).toContain('unsubscribe');
            expect(result.text.toLowerCase()).toContain('unsubscribe');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 9: Date Formatting Includes Timezone
   * Feature: email-notifications, Property 9: Date Formatting Includes Timezone
   * **Validates: Requirements 9.4**
   *
   * For any valid ISO 8601 date string, the formatted email date output SHALL contain
   * a human-readable date representation including a timezone identifier.
   */
  describe('Property 9: Date Formatting Includes Timezone', () => {
    const MONTH_NAMES = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    it('formatted date is a non-empty string containing a timezone identifier, a 4-digit year, and a month name', () => {
      fc.assert(
        fc.property(
          arbScheduledStart,
          (isoDate) => {
            const formatted = formatEmailDate(isoDate);

            // The formatted output is a non-empty string
            expect(typeof formatted).toBe('string');
            expect(formatted.length).toBeGreaterThan(0);

            // The formatted output contains a timezone identifier (e.g., "UTC")
            expect(formatted).toContain('UTC');

            // The formatted output contains a year (4-digit number)
            expect(formatted).toMatch(/\d{4}/);

            // The formatted output contains a month name
            const containsMonth = MONTH_NAMES.some((month) => formatted.includes(month));
            expect(containsMonth).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
