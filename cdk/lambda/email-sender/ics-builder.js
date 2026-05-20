'use strict';

/**
 * Build an iCalendar (RFC 5545) VEVENT payload for a virtual meetup event.
 *
 * Hand-rolled so the Lambda doesn't grow a runtime dependency for what is
 * fundamentally a small text format. Only the fields needed for the
 * signup-confirmation flow are supported.
 *
 * @module email-sender/ics-builder
 */

/**
 * RFC 5545 line-fold + value-escape.
 * Backslashes, semicolons, commas, and newlines must be escaped inside
 * TEXT property values (DESCRIPTION, SUMMARY, LOCATION).
 *
 * @param {string} value - Raw text value.
 * @returns {string} Escaped value safe to embed in an ICS TEXT field.
 */
function escapeIcsText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Format a Date (or ISO-8601 string) as an RFC 5545 UTC date-time
 * (e.g., 20260519T143000Z).
 *
 * @param {Date|string} value - Date or ISO string.
 * @returns {string} UTC-formatted ICS date-time.
 * @throws {Error} if the value cannot be parsed.
 */
function formatIcsDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ICS: ${value}`);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Fold an ICS content line at 75 octets per RFC 5545 §3.1.
 * Continuation lines start with a single space.
 *
 * @param {string} line - Single content line.
 * @returns {string} Folded line(s) joined with CRLF.
 */
function foldIcsLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    if (i === 0) {
      parts.push(line.slice(i, i + 75));
      i += 75;
    } else {
      parts.push(' ' + line.slice(i, i + 74));
      i += 74;
    }
  }
  return parts.join('\r\n');
}

/**
 * Build an ICS VEVENT payload.
 *
 * @param {object} params
 * @param {string} params.uid - Stable unique identifier (e.g., event ID @ domain).
 * @param {Date|string} params.start - Event start time.
 * @param {number} params.durationMinutes - Event duration in minutes (must be > 0).
 * @param {string} params.summary - Short event title.
 * @param {string} [params.description] - Long-form event description.
 * @param {string} [params.url] - Public event URL.
 * @param {string} [params.organizerEmail] - Organizer mailto address.
 * @param {string} [params.organizerName] - Organizer display name.
 * @param {Date|string} [params.now] - Override for DTSTAMP (defaults to current time).
 * @param {number} [params.sequence] - Update sequence (defaults to 0).
 * @returns {string} ICS payload terminated by CRLF.
 */
function buildIcsPayload(params) {
  const {
    uid,
    start,
    durationMinutes,
    summary,
    description,
    url,
    organizerEmail,
    organizerName,
    now,
    sequence,
  } = params;

  if (!uid) throw new Error('ics-builder: uid is required');
  if (!start) throw new Error('ics-builder: start is required');
  if (!summary) throw new Error('ics-builder: summary is required');
  if (typeof durationMinutes !== 'number' || durationMinutes <= 0) {
    throw new Error('ics-builder: durationMinutes must be a positive number');
  }

  const dtstart = formatIcsDate(start);
  const dtstamp = formatIcsDate(now || new Date());
  const seq = Number.isInteger(sequence) ? sequence : 0;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Virtual Meetup Platform//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DURATION:PT${durationMinutes}M`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `SEQUENCE:${seq}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
  ];

  if (description) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  }
  if (url) {
    lines.push(`URL:${url}`);
  }
  if (organizerEmail) {
    const cn = organizerName ? `;CN=${escapeIcsText(organizerName)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${organizerEmail}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

module.exports = {
  buildIcsPayload,
  escapeIcsText,
  formatIcsDate,
  foldIcsLine,
};
