'use strict';

/**
 * Shared constants for the Virtual Meetup Platform.
 * @module shared/constants
 */

/**
 * Event lifecycle statuses.
 * Flow: scheduled → staging → live → ended → published
 */
const EVENT_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  STAGING: 'staging',
  LIVE: 'live',
  ENDED: 'ended',
  PUBLISHED: 'published',
});

/**
 * DynamoDB key prefixes for single-table design.
 */
const KEY_PREFIX = Object.freeze({
  EVENT: 'EVENT#',
  USER: 'USER#',
  SIGNUP: 'SIGNUP#',
  CONN: 'CONN#',
  HAND: 'HAND#',
  QUESTION: 'QUESTION#',
});

/**
 * DynamoDB sort key constants.
 */
const SK = Object.freeze({
  METADATA: 'METADATA',
  PROFILE: 'PROFILE',
  RECORDING: 'RECORDING',
  METRICS: 'METRICS',
});

/**
 * GSI key constants.
 */
const GSI = Object.freeze({
  GSI1_UPCOMING_PK: 'EVENTS#UPCOMING',
});

/**
 * AWS Community branding colors.
 */
const BRANDING = Object.freeze({
  AWS_ORANGE: '#FF9900',
  SQUID_INK: '#232F3E',
  CLOUD_BLUE: '#1B659D',
  LIME: '#7AA116',
  BACKGROUND_LIGHT: '#FAFAFA',
  BACKGROUND_DARK: '#161E2D',
});

/**
 * User roles within the platform.
 */
const USER_ROLE = Object.freeze({
  ORGANIZER: 'organizer',
  MEMBER: 'member',
});

/**
 * Participant roles within a live event session.
 */
const SESSION_ROLE = Object.freeze({
  PRESENTER: 'presenter',
  CO_PRESENTER: 'co-presenter',
  ATTENDEE: 'attendee',
});

/**
 * Question statuses in the Q&A queue.
 */
const QUESTION_STATUS = Object.freeze({
  QUEUED: 'queued',
  ANSWERED: 'answered',
  DISMISSED: 'dismissed',
});

/**
 * CORS headers for SPA access.
 */
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
});

/**
 * Length bounds for user-supplied event text fields. DDB's 400 KB
 * per-item cap is the upstream limit; these caps keep GSI projections
 * (which include the full attributes) from being silently bloated by
 * a single oversized event. See issue #32.
 */
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;

module.exports = {
  EVENT_STATUS,
  KEY_PREFIX,
  SK,
  GSI,
  BRANDING,
  USER_ROLE,
  SESSION_ROLE,
  QUESTION_STATUS,
  CORS_HEADERS,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
};
