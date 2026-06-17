'use strict';

/**
 * Build a raw RFC 5322 / MIME multipart/mixed email body suitable for
 * SES SendRawEmail, with an `multipart/alternative` (text + html) part
 * and one or more attachments.
 *
 * @module email-sender/mime-builder
 */

const crypto = require('crypto');

/**
 * Encode a UTF-8 string as RFC 2047 Encoded-Word (Q-encoded) for use in
 * header values that may contain non-ASCII characters (e.g., Subject).
 *
 * @param {string} value - Header value.
 * @returns {string} The original value if pure-ASCII, or an encoded-word otherwise.
 */
function encodeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Wrap a base64 string at 76 characters per line per RFC 2045.
 *
 * @param {string} b64 - Base64-encoded string.
 * @returns {string} Wrapped string with CRLF separators.
 */
function wrapBase64(b64) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join('\r\n');
}

/**
 * Build the raw MIME body for an email with text+html bodies and one or
 * more attachments. The output is what SES SendRawEmail's `Data` expects.
 *
 * Structure:
 *
 *   multipart/mixed
 *     multipart/alternative
 *       text/plain
 *       text/html
 *     <attachment 1>
 *     <attachment 2>
 *     ...
 *
 * @param {object} params
 * @param {string} params.from - From header value (already formatted).
 * @param {string} params.to - To header (single recipient).
 * @param {string} params.subject - Subject.
 * @param {string} params.text - Plain-text body.
 * @param {string} params.html - HTML body.
 * @param {Array<{filename: string, contentType: string, content: string|Buffer}>} [params.attachments]
 *   Attachments. `content` may be a UTF-8 string or a Buffer.
 * @returns {string} The raw MIME body.
 */
function buildRawMimeEmail(params) {
  const { from, to, subject, text, html, attachments = [] } = params;
  if (!from) throw new Error('mime-builder: from is required');
  if (!to) throw new Error('mime-builder: to is required');
  if (!subject) throw new Error('mime-builder: subject is required');
  if (!text) throw new Error('mime-builder: text is required');
  if (!html) throw new Error('mime-builder: html is required');

  const outerBoundary = '----vmupmixed-' + crypto.randomBytes(12).toString('hex');
  const innerBoundary = '----vmupalt-' + crypto.randomBytes(12).toString('hex');
  const CRLF = '\r\n';

  let body = '';
  body += `From: ${from}${CRLF}`;
  body += `To: ${to}${CRLF}`;
  body += `Subject: ${encodeHeader(subject)}${CRLF}`;
  body += `MIME-Version: 1.0${CRLF}`;
  body += `Content-Type: multipart/mixed; boundary="${outerBoundary}"${CRLF}`;
  body += CRLF;

  // --- multipart/alternative (text + html) ---
  body += `--${outerBoundary}${CRLF}`;
  body += `Content-Type: multipart/alternative; boundary="${innerBoundary}"${CRLF}`;
  body += CRLF;

  body += `--${innerBoundary}${CRLF}`;
  body += `Content-Type: text/plain; charset="UTF-8"${CRLF}`;
  body += `Content-Transfer-Encoding: base64${CRLF}`;
  body += CRLF;
  body += wrapBase64(Buffer.from(text, 'utf8').toString('base64')) + CRLF;

  body += `--${innerBoundary}${CRLF}`;
  body += `Content-Type: text/html; charset="UTF-8"${CRLF}`;
  body += `Content-Transfer-Encoding: base64${CRLF}`;
  body += CRLF;
  body += wrapBase64(Buffer.from(html, 'utf8').toString('base64')) + CRLF;

  body += `--${innerBoundary}--${CRLF}`;

  // --- attachments ---
  for (const att of attachments) {
    if (!att.filename || !att.contentType || att.content == null) {
      throw new Error('mime-builder: attachment requires filename, contentType, and content');
    }
    const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content, 'utf8');

    body += `--${outerBoundary}${CRLF}`;
    body += `Content-Type: ${att.contentType}; name="${att.filename}"${CRLF}`;
    body += `Content-Transfer-Encoding: base64${CRLF}`;
    body += `Content-Disposition: attachment; filename="${att.filename}"${CRLF}`;
    body += CRLF;
    body += wrapBase64(buf.toString('base64')) + CRLF;
  }

  body += `--${outerBoundary}--${CRLF}`;

  return body;
}

module.exports = {
  buildRawMimeEmail,
  encodeHeader,
  wrapBase64,
};
