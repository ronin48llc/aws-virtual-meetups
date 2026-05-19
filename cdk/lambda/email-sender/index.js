'use strict';

/**
 * Email Sender Lambda handler.
 * Routes by `type` field in invocation payload to send transactional emails via SES.
 * Supports single-recipient (event-created, signup-confirmation) and bulk
 * (day-before-reminder, hour-before-reminder, event-started, recap) email types.
 * @module email-sender
 */

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { renderTemplate } = require('./templates');
const logger = require('../shared/logger');
const { KEY_PREFIX, SK } = require('../shared/constants');
const { buildEventPK } = require('../shared/dynamo-utils');

const sesClient = new SESClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME;
const SES_SENDER = process.env.SES_SENDER;
const FRONTEND_URL = process.env.FRONTEND_URL;

const SINGLE_RECIPIENT_TYPES = ['event-created', 'signup-confirmation'];
const BULK_TYPES = ['day-before-reminder', 'hour-before-reminder', 'event-started', 'recap'];

/**
 * Query all attendees registered for an event.
 * @param {string} eventId - The event identifier.
 * @returns {Promise<Array<{userId: string, displayName: string, email: string, registeredAt: string}>>}
 */
async function getAttendees(eventId) {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': buildEventPK(eventId),
      ':skPrefix': KEY_PREFIX.SIGNUP,
    },
  }));

  return (result.Items || []).map((item) => ({
    userId: item.userId,
    displayName: item.displayName,
    email: item.email,
    registeredAt: item.registeredAt,
  }));
}

/**
 * Get event metadata from DynamoDB.
 * @param {string} eventId - The event identifier.
 * @returns {Promise<Object|null>} Event metadata or null if not found.
 */
async function getEventMetadata(eventId) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METADATA,
    },
  }));

  return result.Item || null;
}

/**
 * Send a single email via SES.
 * Wraps the SES call in try/catch — logs failures but never throws.
 * @param {string} recipientEmail - Recipient email address.
 * @param {object} template - Rendered template with { subject, html, text }.
 * @param {string} eventId - Event ID for logging context.
 */
async function sendEmail(recipientEmail, template, eventId) {
  try {
    const params = {
      Source: `Virtual Meetup Platform <${SES_SENDER}>`,
      Destination: {
        ToAddresses: [recipientEmail],
      },
      Message: {
        Subject: { Data: template.subject },
        Body: {
          Html: { Data: template.html },
          Text: { Data: template.text },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(params));
    logger.info('Email sent successfully', { eventId, extra: { recipient: recipientEmail } });
  } catch (err) {
    logger.error('Failed to send email', {
      eventId,
      error: err.message || String(err),
      extra: { recipient: recipientEmail },
    });
  }
}

/**
 * Build the event URL for use in email templates.
 * @param {string} eventId - The event identifier.
 * @returns {string} Full event URL.
 */
function buildEventUrl(eventId) {
  return `${FRONTEND_URL}/events/${eventId}`;
}

/**
 * Handle single-recipient email types (event-created, signup-confirmation).
 * @param {string} type - Email type.
 * @param {object} payload - Invocation payload.
 */
async function handleSingleRecipient(type, payload) {
  const { recipientEmail, recipientName, eventId, eventTitle, eventDescription, scheduledStart, playbackUrl, duration } = payload;

  const eventUrl = payload.eventUrl || buildEventUrl(eventId);

  const templateData = {
    eventTitle,
    eventDescription,
    scheduledStart,
    eventUrl,
    recipientName,
    playbackUrl,
    duration,
  };

  const template = renderTemplate(type, templateData);
  await sendEmail(recipientEmail, template, eventId);
}

/**
 * Handle bulk email types (day-before-reminder, hour-before-reminder, event-started, recap).
 * Queries DynamoDB for attendees and event metadata, then sends to all attendees.
 * @param {string} type - Email type.
 * @param {object} payload - Invocation payload.
 */
async function handleBulkRecipients(type, payload) {
  const { eventId, playbackUrl, duration } = payload;

  // Query event metadata
  const eventMetadata = await getEventMetadata(eventId);
  if (!eventMetadata) {
    logger.warn('Event not found — orphaned trigger, skipping email send', { eventId, extra: { type } });
    return;
  }

  // Query all attendees
  const attendees = await getAttendees(eventId);
  if (attendees.length === 0) {
    logger.info('No attendees found for event, skipping email send', { eventId, extra: { type } });
    return;
  }

  const eventUrl = buildEventUrl(eventId);

  const templateData = {
    eventTitle: eventMetadata.title,
    eventDescription: eventMetadata.description,
    scheduledStart: eventMetadata.scheduledStart,
    eventUrl,
    playbackUrl: playbackUrl || eventMetadata.hlsPlaybackUrl,
    duration,
  };

  const template = renderTemplate(type, templateData);

  // Send to all attendees — each send is wrapped in try/catch individually
  for (const attendee of attendees) {
    await sendEmail(attendee.email, template, eventId);
  }
}

/**
 * Main Lambda handler.
 * Routes by `type` field in the invocation payload.
 * @param {object} event - Lambda invocation payload.
 */
exports.handler = async (event) => {
  const { type } = event;

  if (!type) {
    logger.error('Missing type field in email sender payload', { extra: { payload: JSON.stringify(event) } });
    return { statusCode: 400, body: 'Missing type field' };
  }

  logger.info('Processing email send request', { extra: { type, eventId: event.eventId } });

  if (SINGLE_RECIPIENT_TYPES.includes(type)) {
    await handleSingleRecipient(type, event);
  } else if (BULK_TYPES.includes(type)) {
    await handleBulkRecipients(type, event);
  } else {
    logger.error('Unknown email type', { extra: { type } });
    return { statusCode: 400, body: `Unknown email type: ${type}` };
  }

  return { statusCode: 200, body: 'OK' };
};
