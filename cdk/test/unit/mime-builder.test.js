'use strict';

const {
  buildRawMimeEmail,
  encodeHeader,
  wrapBase64,
} = require('../../lambda/email-sender/mime-builder');

describe('mime-builder', () => {
  describe('encodeHeader', () => {
    it('passes pure-ASCII through unchanged', () => {
      expect(encodeHeader('Hello world')).toBe('Hello world');
      expect(encodeHeader('Subject: 123 [TEST]')).toBe('Subject: 123 [TEST]');
    });

    it('Q-encodes non-ASCII as RFC 2047 encoded-word', () => {
      const encoded = encodeHeader('Café — résumé');
      expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      // Decoding back should yield the original
      const b64 = encoded.match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)[1];
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Café — résumé');
    });
  });

  describe('wrapBase64', () => {
    it('wraps at 76 characters per line', () => {
      const long = 'A'.repeat(200);
      const wrapped = wrapBase64(long);
      const lines = wrapped.split('\r\n');
      expect(lines[0].length).toBe(76);
      expect(lines[1].length).toBe(76);
      expect(lines[2].length).toBe(48); // 200 = 76+76+48
    });

    it('returns short strings unchanged', () => {
      expect(wrapBase64('abc')).toBe('abc');
    });
  });

  describe('buildRawMimeEmail', () => {
    const params = {
      from: 'Sender <sender@example.com>',
      to: 'recipient@example.com',
      subject: 'Test Subject',
      text: 'plain body',
      html: '<p>html body</p>',
    };

    it('includes From, To, Subject, MIME-Version, and Content-Type headers', () => {
      const raw = buildRawMimeEmail(params);
      expect(raw).toContain('From: Sender <sender@example.com>\r\n');
      expect(raw).toContain('To: recipient@example.com\r\n');
      expect(raw).toContain('Subject: Test Subject\r\n');
      expect(raw).toContain('MIME-Version: 1.0\r\n');
      expect(raw).toContain('Content-Type: multipart/mixed;');
    });

    it('produces a multipart/mixed > multipart/alternative > text+html structure', () => {
      const raw = buildRawMimeEmail(params);
      const mixedBoundary = raw.match(/multipart\/mixed; boundary="([^"]+)"/)[1];
      const altBoundary = raw.match(/multipart\/alternative; boundary="([^"]+)"/)[1];

      // Both boundaries appear in the body
      expect(raw).toContain(`--${mixedBoundary}\r\n`);
      expect(raw).toContain(`--${altBoundary}\r\n`);
      expect(raw).toContain(`--${altBoundary}--\r\n`);
      expect(raw).toContain(`--${mixedBoundary}--\r\n`);

      // Both content types present
      expect(raw).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
      expect(raw).toMatch(/Content-Type: text\/html; charset="UTF-8"/);
    });

    it('base64-encodes the plain text body', () => {
      const raw = buildRawMimeEmail(params);
      const expected = Buffer.from('plain body', 'utf8').toString('base64');
      expect(raw).toContain(expected);
    });

    it('encodes a non-ASCII subject as an RFC 2047 encoded-word', () => {
      const raw = buildRawMimeEmail({ ...params, subject: 'Café event' });
      expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    });

    it('includes an attachment when supplied', () => {
      const raw = buildRawMimeEmail({
        ...params,
        attachments: [
          {
            filename: 'event.ics',
            contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
            content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
          },
        ],
      });
      expect(raw).toContain('Content-Type: text/calendar; method=REQUEST; charset=UTF-8; name="event.ics"');
      expect(raw).toContain('Content-Disposition: attachment; filename="event.ics"');
      const expected = Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'utf8').toString('base64');
      expect(raw).toContain(expected);
    });

    it('accepts a Buffer as attachment content', () => {
      const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const raw = buildRawMimeEmail({
        ...params,
        attachments: [{ filename: 'x.bin', contentType: 'application/octet-stream', content: buf }],
      });
      expect(raw).toContain(buf.toString('base64'));
    });

    it('throws when required fields are missing', () => {
      expect(() => buildRawMimeEmail({ ...params, from: undefined })).toThrow(/from/);
      expect(() => buildRawMimeEmail({ ...params, to: undefined })).toThrow(/to/);
      expect(() => buildRawMimeEmail({ ...params, subject: undefined })).toThrow(/subject/);
      expect(() => buildRawMimeEmail({ ...params, text: undefined })).toThrow(/text/);
      expect(() => buildRawMimeEmail({ ...params, html: undefined })).toThrow(/html/);
    });

    it('throws when attachment is missing required keys', () => {
      expect(() => buildRawMimeEmail({
        ...params,
        attachments: [{ filename: 'x.ics' }],
      })).toThrow(/attachment/);
    });

    it('uses unique boundary tokens per call (no static collisions)', () => {
      const a = buildRawMimeEmail(params);
      const b = buildRawMimeEmail(params);
      const aBoundary = a.match(/multipart\/mixed; boundary="([^"]+)"/)[1];
      const bBoundary = b.match(/multipart\/mixed; boundary="([^"]+)"/)[1];
      expect(aBoundary).not.toBe(bBoundary);
    });
  });
});
