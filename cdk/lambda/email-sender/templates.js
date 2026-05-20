'use strict';

/**
 * Email template renderer for the Virtual Meetup Platform.
 * Renders HTML and plain-text email bodies for each notification type.
 * @module email-sender/templates
 */

const PLATFORM_NAME = 'AWS Virtual Meetups';
const BRAND_COLOR = '#FF9900'; // AWS orange
const PLATFORM_EMAIL = 'phannah@thenetwerk.net';

const DEFAULT_LOCALE = 'en-US';

/**
 * Per-locale translations of recipient-facing strings (issue #9).
 *
 * Demonstration scope: only `signupConfirmation` strings are translated
 * here. Other email types (reminders, recap, event-created) remain
 * English-only until follow-up PRs migrate them — that work is mechanical
 * once the per-locale lookup pattern (this object) is in place.
 *
 * If a locale is selected for which no entry exists, `getStrings()`
 * falls back to en-US. Adding a locale = adding a key to this object.
 */
const STRINGS = {
  'en-US': {
    signupConfirmation: {
      subjectPrefix: 'Sign-Up Confirmed',
      heading: "You're Registered!",
      greetingWithName: (name) => `Hi ${name},`,
      greetingAnonymous: 'Hi,',
      intro: 'You have successfully signed up for the following event:',
      eventLabel: 'Event',
      startLabel: 'Scheduled Start',
      viewButton: 'View Event',
      viewLine: (url) => `View Event: ${url}`,
    },
  },
  'es-US': {
    signupConfirmation: {
      subjectPrefix: 'Inscripción confirmada',
      heading: '¡Estás inscrito!',
      greetingWithName: (name) => `Hola ${name},`,
      greetingAnonymous: 'Hola,',
      intro: 'Te has registrado correctamente al siguiente evento:',
      eventLabel: 'Evento',
      startLabel: 'Comienzo programado',
      viewButton: 'Ver evento',
      viewLine: (url) => `Ver evento: ${url}`,
    },
  },
};

/**
 * Look up the per-locale strings dict, falling back to en-US.
 * Exported via module.exports so tests can introspect.
 *
 * @param {string} locale
 * @returns {object} the strings dictionary for that locale
 */
function getStrings(locale) {
  return STRINGS[locale] || STRINGS[DEFAULT_LOCALE];
}

/**
 * Format an ISO 8601 date string for display in emails.
 *
 * @param {string} isoDate - ISO 8601 date string
 * @param {string} [locale=en-US] - BCP-47 locale code for Intl.DateTimeFormat
 * @param {string} [timeZone=UTC] - IANA timezone name
 * @returns {string} Human-readable date with timezone
 */
function formatEmailDate(isoDate, locale, timeZone) {
  const date = new Date(isoDate);
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone || 'UTC',
    timeZoneName: 'short',
  };
  return date.toLocaleString(locale || DEFAULT_LOCALE, options);
}

/**
 * Wrap content in the branded HTML email layout.
 * @param {string} subject - Email subject line
 * @param {string} bodyContent - Inner HTML content
 * @returns {string} Full HTML email
 */
function wrapHtml(subject, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background-color: ${BRAND_COLOR}; padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">${escapeHtml(PLATFORM_NAME)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px;">
              ${bodyContent}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 30px; background-color: #f9f9f9; border-top: 1px solid #eeeeee; font-size: 12px; color: #666666;">
              <p style="margin: 0;">You received this email because you registered on ${escapeHtml(PLATFORM_NAME)}. To unsubscribe, contact us at ${escapeHtml(PLATFORM_EMAIL)}.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build the plain-text footer.
 * @returns {string}
 */
function textFooter() {
  return `\n---\nYou received this email because you registered on ${PLATFORM_NAME}. To unsubscribe, contact us at ${PLATFORM_EMAIL}.`;
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format duration in seconds to a human-readable string.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'N/A';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Format duration in minutes to a human-readable string.
 * @param {number} minutes - Duration in minutes
 * @returns {string} Formatted string (e.g., "1h 30m", "2h", "45m")
 */
function formatDurationMinutes(minutes) {
  if (!minutes || minutes <= 0) return 'N/A';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

// --- Template Renderers ---

function renderEventCreated(data) {
  const { eventTitle, eventDescription, scheduledStart, scheduledEnd, durationMinutes, eventUrl } = data;
  const dateStr = formatEmailDate(scheduledStart);
  const subject = `[${PLATFORM_NAME}] Event Created: ${eventTitle}`;

  let durationRows = '';
  let durationText = '';
  if (scheduledEnd) {
    const endDateStr = formatEmailDate(scheduledEnd);
    durationRows += `\n      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Scheduled End:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(endDateStr)}</td></tr>`;
    durationText += `\nScheduled End: ${endDateStr}`;
  }
  if (durationMinutes) {
    const durationStr = formatDurationMinutes(durationMinutes);
    durationRows += `\n      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Duration:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(durationStr)}</td></tr>`;
    durationText += `\nDuration: ${durationStr}`;
  }

  const html = wrapHtml(subject, `
    <h2 style="color: #333333; margin-top: 0;">Your Event Has Been Created!</h2>
    <p style="color: #555555;">Your event has been successfully scheduled. Here are the details:</p>
    <table style="width: 100%; margin: 20px 0;">
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Event:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(eventTitle)}</td></tr>
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Description:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(eventDescription)}</td></tr>
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Scheduled Start:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(dateStr)}</td></tr>${durationRows}
    </table>
    <p><a href="${escapeHtml(eventUrl)}" style="display: inline-block; padding: 12px 24px; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 4px;">View Event</a></p>
  `);

  const text = `Your Event Has Been Created!\n\nEvent: ${eventTitle}\nDescription: ${eventDescription}\nScheduled Start: ${dateStr}${durationText}\n\nView Event: ${eventUrl}${textFooter()}`;

  return { subject, html, text };
}

function renderSignupConfirmation(data) {
  const { eventTitle, scheduledStart, eventUrl, recipientName, locale, timeZone } = data;
  // If `locale` isn't a locale we ship strings for, also use DEFAULT_LOCALE
  // for the date formatter — otherwise an unrecognized code like
  // `fictional-LOCALE` makes Intl.DateTimeFormat throw RangeError.
  const effectiveLocale = STRINGS[locale] ? locale : DEFAULT_LOCALE;
  const s = getStrings(effectiveLocale).signupConfirmation;
  const dateStr = formatEmailDate(scheduledStart, effectiveLocale, timeZone);
  const subject = `[${PLATFORM_NAME}] ${s.subjectPrefix}: ${eventTitle}`;

  const greeting = recipientName ? s.greetingWithName(escapeHtml(recipientName)) : s.greetingAnonymous;
  const greetingText = recipientName ? s.greetingWithName(recipientName) : s.greetingAnonymous;

  const html = wrapHtml(subject, `
    <h2 style="color: #333333; margin-top: 0;">${s.heading}</h2>
    <p style="color: #555555;">${greeting}</p>
    <p style="color: #555555;">${s.intro}</p>
    <table style="width: 100%; margin: 20px 0;">
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">${s.eventLabel}:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(eventTitle)}</td></tr>
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">${s.startLabel}:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(dateStr)}</td></tr>
    </table>
    <p><a href="${escapeHtml(eventUrl)}" style="display: inline-block; padding: 12px 24px; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 4px;">${s.viewButton}</a></p>
  `);

  const text = `${s.heading}\n\n${greetingText}\n\n${s.intro}\n\n${s.eventLabel}: ${eventTitle}\n${s.startLabel}: ${dateStr}\n\n${s.viewLine(eventUrl)}${textFooter()}`;

  return { subject, html, text };
}

function renderDayBeforeReminder(data) {
  const { eventTitle, scheduledStart, durationMinutes, eventUrl } = data;
  const dateStr = formatEmailDate(scheduledStart);
  const subject = `[${PLATFORM_NAME}] Reminder: ${eventTitle} is Tomorrow`;

  let durationRow = '';
  let durationText = '';
  if (durationMinutes) {
    const durationStr = formatDurationMinutes(durationMinutes);
    durationRow = `\n      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Expected Duration:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(durationStr)}</td></tr>`;
    durationText = `\nExpected Duration: ${durationStr}`;
  }

  const html = wrapHtml(subject, `
    <h2 style="color: #333333; margin-top: 0;">Event Reminder - Tomorrow!</h2>
    <p style="color: #555555;">This is a friendly reminder that the following event is happening tomorrow:</p>
    <table style="width: 100%; margin: 20px 0;">
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Event:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(eventTitle)}</td></tr>
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Scheduled Start:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(dateStr)}</td></tr>${durationRow}
    </table>
    <p><a href="${escapeHtml(eventUrl)}" style="display: inline-block; padding: 12px 24px; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 4px;">View Event</a></p>
  `);

  const text = `Event Reminder - Tomorrow!\n\nThis is a friendly reminder that the following event is happening tomorrow:\n\nEvent: ${eventTitle}\nScheduled Start: ${dateStr}${durationText}\n\nView Event: ${eventUrl}${textFooter()}`;

  return { subject, html, text };
}

function renderHourBeforeReminder(data) {
  const { eventTitle, scheduledStart, durationMinutes, eventUrl } = data;
  const dateStr = formatEmailDate(scheduledStart);
  const subject = `[${PLATFORM_NAME}] Starting Soon: ${eventTitle}`;

  let durationRow = '';
  let durationText = '';
  if (durationMinutes) {
    const durationStr = formatDurationMinutes(durationMinutes);
    durationRow = `\n      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Expected Duration:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(durationStr)}</td></tr>`;
    durationText = `\nExpected Duration: ${durationStr}`;
  }

  const html = wrapHtml(subject, `
    <h2 style="color: #333333; margin-top: 0;">Event Starting in 1 Hour!</h2>
    <p style="color: #555555;">The following event is starting in about 1 hour. Get ready to join!</p>
    <table style="width: 100%; margin: 20px 0;">
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Event:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(eventTitle)}</td></tr>
      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Scheduled Start:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(dateStr)}</td></tr>${durationRow}
    </table>
    <p><a href="${escapeHtml(eventUrl)}" style="display: inline-block; padding: 12px 24px; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 4px;">Join Event</a></p>
  `);

  const text = `Event Starting in 1 Hour!\n\nThe following event is starting in about 1 hour. Get ready to join!\n\nEvent: ${eventTitle}\nScheduled Start: ${dateStr}${durationText}\n\nJoin Event: ${eventUrl}${textFooter()}`;

  return { subject, html, text };
}

function renderEventStarted(data) {
  const { eventTitle, scheduledEnd, eventUrl } = data;
  const subject = `[${PLATFORM_NAME}] Live Now: ${eventTitle}`;

  let endTimeInfo = '';
  let endTimeText = '';
  if (scheduledEnd) {
    const endDateStr = formatEmailDate(scheduledEnd);
    endTimeInfo = `\n    <p style="color: #555555;">Expected end time: <strong>${escapeHtml(endDateStr)}</strong></p>`;
    endTimeText = `\nExpected End Time: ${endDateStr}`;
  }

  const html = wrapHtml(subject, `
    <h2 style="color: #333333; margin-top: 0;">The Event is Live!</h2>
    <p style="color: #555555;">Great news! <strong>${escapeHtml(eventTitle)}</strong> is now live. Join the session now:</p>${endTimeInfo}
    <p><a href="${escapeHtml(eventUrl)}" style="display: inline-block; padding: 12px 24px; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 4px;">Join Live Session</a></p>
  `);

  const text = `The Event is Live!\n\nGreat news! ${eventTitle} is now live. Join the session now:${endTimeText}\n\nJoin Live Session: ${eventUrl}${textFooter()}`;

  return { subject, html, text };
}

function renderRecap(data) {
  const { eventTitle, playbackUrl, duration, startedAt, endedAt, durationMinutes } = data;

  // Compute actual duration from startedAt and endedAt if available
  let actualDurationSeconds = duration;
  if (startedAt && endedAt) {
    actualDurationSeconds = Math.floor((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  }
  const actualDurationStr = formatDuration(actualDurationSeconds);

  // Planned duration from durationMinutes
  let plannedDurationStr = null;
  if (durationMinutes) {
    plannedDurationStr = formatDurationMinutes(durationMinutes);
  }

  const subject = `[${PLATFORM_NAME}] Recap: ${eventTitle}`;

  let durationRows = `\n      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Duration:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(actualDurationStr)}</td></tr>`;
  let durationTextLines = `\nDuration: ${actualDurationStr}`;

  if (plannedDurationStr) {
    durationRows += `\n      <tr><td style="padding: 8px 0; color: #333333; font-weight: bold;">Planned Duration:</td><td style="padding: 8px 0; color: #555555;">${escapeHtml(plannedDurationStr)}</td></tr>`;
    durationTextLines += `\nPlanned Duration: ${plannedDurationStr}`;
  }

  const html = wrapHtml(subject, `
    <h2 style="color: #333333; margin-top: 0;">Event Recap Available</h2>
    <p style="color: #555555;">The recording for <strong>${escapeHtml(eventTitle)}</strong> is now available!</p>
    <table style="width: 100%; margin: 20px 0;">${durationRows}
    </table>
    <p style="color: #555555;">The recording includes:</p>
    <ul style="color: #555555;">
      <li>Synchronized captions for accessibility</li>
      <li>Full searchable transcript</li>
      <li>Download option to save the recording</li>
      <li>Screenshot capture of any moment</li>
    </ul>
    <p><a href="${escapeHtml(playbackUrl)}" style="display: inline-block; padding: 12px 24px; background-color: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; border-radius: 4px;">Watch Recording</a></p>
  `);

  const text = `Event Recap Available\n\nThe recording for ${eventTitle} is now available!${durationTextLines}\n\nThe recording includes:\n- Synchronized captions for accessibility\n- Full searchable transcript\n- Download option to save the recording\n- Screenshot capture of any moment\n\nWatch Recording: ${playbackUrl}${textFooter()}`;

  return { subject, html, text };
}

/**
 * Render an email template.
 * @param {string} type - Email type
 * @param {object} data - Template data (event title, URL, etc.)
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderTemplate(type, data) {
  switch (type) {
    case 'event-created':
      return renderEventCreated(data);
    case 'signup-confirmation':
      return renderSignupConfirmation(data);
    case 'day-before-reminder':
      return renderDayBeforeReminder(data);
    case 'hour-before-reminder':
      return renderHourBeforeReminder(data);
    case 'event-started':
      return renderEventStarted(data);
    case 'recap':
      return renderRecap(data);
    default:
      throw new Error(`Unknown email template type: ${type}`);
  }
}

module.exports = {
  renderTemplate,
  formatEmailDate,
  formatDurationMinutes,
  getStrings,
  STRINGS,
  DEFAULT_LOCALE,
};
