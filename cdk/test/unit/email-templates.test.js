'use strict';

const { renderTemplate, formatEmailDate } = require('../../lambda/email-sender/templates');

describe('Email Templates', () => {
  describe('formatEmailDate', () => {
    it('formats an ISO date string with timezone identifier', () => {
      const result = formatEmailDate('2024-03-15T18:00:00Z');
      expect(result).toContain('March');
      expect(result).toContain('15');
      expect(result).toContain('2024');
      expect(result).toContain('UTC');
    });

    it('includes day of week', () => {
      const result = formatEmailDate('2024-03-15T18:00:00Z');
      expect(result).toContain('Friday');
    });

    it('formats time correctly', () => {
      const result = formatEmailDate('2024-03-15T18:00:00Z');
      expect(result).toMatch(/6:00\s*PM/);
    });
  });

  describe('renderTemplate - event-created', () => {
    const data = {
      eventTitle: 'AWS Lambda Deep Dive',
      eventDescription: 'Learn advanced patterns',
      scheduledStart: '2024-03-15T18:00:00Z',
      eventUrl: 'https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc123',
    };

    it('returns subject, html, and text', () => {
      const result = renderTemplate('event-created', data);
      expect(result).toHaveProperty('subject');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('subject is prefixed with [AWS Virtual Meetups]', () => {
      const result = renderTemplate('event-created', data);
      expect(result.subject).toMatch(/^\[AWS Virtual Meetups\]/);
    });

    it('includes event title in all parts', () => {
      const result = renderTemplate('event-created', data);
      expect(result.subject).toContain('AWS Lambda Deep Dive');
      expect(result.html).toContain('AWS Lambda Deep Dive');
      expect(result.text).toContain('AWS Lambda Deep Dive');
    });

    it('includes event description in html and text', () => {
      const result = renderTemplate('event-created', data);
      expect(result.html).toContain('Learn advanced patterns');
      expect(result.text).toContain('Learn advanced patterns');
    });

    it('includes scheduled start date in html and text', () => {
      const result = renderTemplate('event-created', data);
      expect(result.html).toContain('March');
      expect(result.text).toContain('March');
    });

    it('includes event URL in html and text', () => {
      const result = renderTemplate('event-created', data);
      expect(result.html).toContain(data.eventUrl);
      expect(result.text).toContain(data.eventUrl);
    });

    it('includes branded header with AWS orange', () => {
      const result = renderTemplate('event-created', data);
      expect(result.html).toContain('#FF9900');
    });

    it('includes unsubscribe footer in html and text', () => {
      const result = renderTemplate('event-created', data);
      expect(result.html).toContain('To unsubscribe');
      expect(result.html).toContain('phannah@thenetwerk.net');
      expect(result.text).toContain('To unsubscribe');
      expect(result.text).toContain('phannah@thenetwerk.net');
    });
  });

  describe('renderTemplate - signup-confirmation', () => {
    const data = {
      eventTitle: 'AWS Lambda Deep Dive',
      scheduledStart: '2024-03-15T18:00:00Z',
      eventUrl: 'https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc123',
      recipientName: 'Jane Doe',
    };

    it('returns subject, html, and text', () => {
      const result = renderTemplate('signup-confirmation', data);
      expect(result).toHaveProperty('subject');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('subject is prefixed with [AWS Virtual Meetups]', () => {
      const result = renderTemplate('signup-confirmation', data);
      expect(result.subject).toMatch(/^\[AWS Virtual Meetups\]/);
    });

    it('includes event title in html and text', () => {
      const result = renderTemplate('signup-confirmation', data);
      expect(result.html).toContain('AWS Lambda Deep Dive');
      expect(result.text).toContain('AWS Lambda Deep Dive');
    });

    it('includes scheduled start in html and text', () => {
      const result = renderTemplate('signup-confirmation', data);
      expect(result.html).toContain('March');
      expect(result.text).toContain('March');
    });

    it('includes event URL in html and text', () => {
      const result = renderTemplate('signup-confirmation', data);
      expect(result.html).toContain(data.eventUrl);
      expect(result.text).toContain(data.eventUrl);
    });

    it('includes unsubscribe footer', () => {
      const result = renderTemplate('signup-confirmation', data);
      expect(result.html).toContain('To unsubscribe');
      expect(result.text).toContain('To unsubscribe');
    });
  });

  describe('renderTemplate - day-before-reminder', () => {
    const data = {
      eventTitle: 'AWS Lambda Deep Dive',
      scheduledStart: '2024-03-15T18:00:00Z',
      eventUrl: 'https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc123',
    };

    it('returns subject, html, and text', () => {
      const result = renderTemplate('day-before-reminder', data);
      expect(result).toHaveProperty('subject');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('subject is prefixed with [AWS Virtual Meetups]', () => {
      const result = renderTemplate('day-before-reminder', data);
      expect(result.subject).toMatch(/^\[AWS Virtual Meetups\]/);
    });

    it('includes event title in html and text', () => {
      const result = renderTemplate('day-before-reminder', data);
      expect(result.html).toContain('AWS Lambda Deep Dive');
      expect(result.text).toContain('AWS Lambda Deep Dive');
    });

    it('includes scheduled start in html and text', () => {
      const result = renderTemplate('day-before-reminder', data);
      expect(result.html).toContain('March');
      expect(result.text).toContain('March');
    });

    it('includes event URL in html and text', () => {
      const result = renderTemplate('day-before-reminder', data);
      expect(result.html).toContain(data.eventUrl);
      expect(result.text).toContain(data.eventUrl);
    });

    it('includes unsubscribe footer', () => {
      const result = renderTemplate('day-before-reminder', data);
      expect(result.html).toContain('To unsubscribe');
      expect(result.text).toContain('To unsubscribe');
    });
  });

  describe('renderTemplate - hour-before-reminder', () => {
    const data = {
      eventTitle: 'AWS Lambda Deep Dive',
      scheduledStart: '2024-03-15T18:00:00Z',
      eventUrl: 'https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc123',
    };

    it('returns subject, html, and text', () => {
      const result = renderTemplate('hour-before-reminder', data);
      expect(result).toHaveProperty('subject');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('subject is prefixed with [AWS Virtual Meetups]', () => {
      const result = renderTemplate('hour-before-reminder', data);
      expect(result.subject).toMatch(/^\[AWS Virtual Meetups\]/);
    });

    it('includes event title in html and text', () => {
      const result = renderTemplate('hour-before-reminder', data);
      expect(result.html).toContain('AWS Lambda Deep Dive');
      expect(result.text).toContain('AWS Lambda Deep Dive');
    });

    it('includes scheduled start in html and text', () => {
      const result = renderTemplate('hour-before-reminder', data);
      expect(result.html).toContain('March');
      expect(result.text).toContain('March');
    });

    it('includes event URL in html and text', () => {
      const result = renderTemplate('hour-before-reminder', data);
      expect(result.html).toContain(data.eventUrl);
      expect(result.text).toContain(data.eventUrl);
    });

    it('includes unsubscribe footer', () => {
      const result = renderTemplate('hour-before-reminder', data);
      expect(result.html).toContain('To unsubscribe');
      expect(result.text).toContain('To unsubscribe');
    });
  });

  describe('renderTemplate - event-started', () => {
    const data = {
      eventTitle: 'AWS Lambda Deep Dive',
      eventUrl: 'https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc123',
    };

    it('returns subject, html, and text', () => {
      const result = renderTemplate('event-started', data);
      expect(result).toHaveProperty('subject');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('subject is prefixed with [AWS Virtual Meetups]', () => {
      const result = renderTemplate('event-started', data);
      expect(result.subject).toMatch(/^\[AWS Virtual Meetups\]/);
    });

    it('includes event title in html and text', () => {
      const result = renderTemplate('event-started', data);
      expect(result.html).toContain('AWS Lambda Deep Dive');
      expect(result.text).toContain('AWS Lambda Deep Dive');
    });

    it('includes event URL (join link) in html and text', () => {
      const result = renderTemplate('event-started', data);
      expect(result.html).toContain(data.eventUrl);
      expect(result.text).toContain(data.eventUrl);
    });

    it('includes unsubscribe footer', () => {
      const result = renderTemplate('event-started', data);
      expect(result.html).toContain('To unsubscribe');
      expect(result.text).toContain('To unsubscribe');
    });
  });

  describe('renderTemplate - recap', () => {
    const data = {
      eventTitle: 'AWS Lambda Deep Dive',
      playbackUrl: 'https://d2hbje3cen4qrx.cloudfront.net/events/evt_abc123?playback=true',
      duration: 5400,
    };

    it('returns subject, html, and text', () => {
      const result = renderTemplate('recap', data);
      expect(result).toHaveProperty('subject');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('subject is prefixed with [AWS Virtual Meetups]', () => {
      const result = renderTemplate('recap', data);
      expect(result.subject).toMatch(/^\[AWS Virtual Meetups\]/);
    });

    it('includes event title in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html).toContain('AWS Lambda Deep Dive');
      expect(result.text).toContain('AWS Lambda Deep Dive');
    });

    it('includes playback URL in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html).toContain(data.playbackUrl);
      expect(result.text).toContain(data.playbackUrl);
    });

    it('includes duration in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html).toContain('1h 30m');
      expect(result.text).toContain('1h 30m');
    });

    it('mentions captions in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html.toLowerCase()).toContain('captions');
      expect(result.text.toLowerCase()).toContain('captions');
    });

    it('mentions transcript in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html.toLowerCase()).toContain('transcript');
      expect(result.text.toLowerCase()).toContain('transcript');
    });

    it('mentions download in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html.toLowerCase()).toContain('download');
      expect(result.text.toLowerCase()).toContain('download');
    });

    it('mentions screenshot in html and text', () => {
      const result = renderTemplate('recap', data);
      expect(result.html.toLowerCase()).toContain('screenshot');
      expect(result.text.toLowerCase()).toContain('screenshot');
    });

    it('includes unsubscribe footer', () => {
      const result = renderTemplate('recap', data);
      expect(result.html).toContain('To unsubscribe');
      expect(result.text).toContain('To unsubscribe');
    });
  });

  describe('renderTemplate - unknown type', () => {
    it('throws an error for unknown email type', () => {
      expect(() => renderTemplate('unknown-type', {})).toThrow('Unknown email template type: unknown-type');
    });
  });
});
