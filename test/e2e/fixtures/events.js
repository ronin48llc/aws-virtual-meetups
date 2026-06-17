'use strict';

/**
 * Deterministic event fixtures. Shapes mirror what the Lambda API returns and
 * what frontend/js/app.js reads (eventId, title, description, status,
 * scheduledStart, durationMinutes, signupCount, metrics).
 */
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const liveEvent = {
  eventId: 'evt-live',
  title: 'Live Keynote',
  description: 'Opening keynote streaming now',
  status: 'live',
  scheduledStart: hoursAgo(1),
  signupCount: 240,
};

// Standalone scheduled event for the detail specs (kept out of homeEvents).
const scheduledEvent = {
  eventId: 'evt-100',
  title: 'CDK Deep Dive',
  description: 'Infrastructure as code with AWS CDK',
  status: 'scheduled',
  scheduledStart: hoursFromNow(48),
  durationMinutes: 90,
  signupCount: 42,
};

// Six events so the homepage exercises live/upcoming/past + cursor pagination
// at pageSize 3 (page 1 ends with a "Load more" button).
const homeEvents = [
  liveEvent,
  { eventId: 'evt-101', title: 'Lambda Patterns', description: 'Serverless design patterns', status: 'scheduled', scheduledStart: hoursFromNow(24), durationMinutes: 60, signupCount: 30 },
  { eventId: 'evt-102', title: 'EventBridge Workshop', description: 'Event-driven architectures', status: 'scheduled', scheduledStart: hoursFromNow(72), durationMinutes: 120, signupCount: 18 },
  { eventId: 'evt-103', title: 'S3 Security', description: 'Bucket hardening', status: 'scheduled', scheduledStart: hoursFromNow(96), durationMinutes: 45, signupCount: 9 },
  { eventId: 'evt-104', title: 'IAM Foundations', description: 'Least privilege in practice', status: 'scheduled', scheduledStart: hoursFromNow(120), durationMinutes: 60, signupCount: 55 },
  { eventId: 'evt-past', title: 'Past Summit', description: 'Recap of last summit', status: 'ended', scheduledStart: hoursAgo(48), durationMinutes: 60, signupCount: 300, metrics: { totalAttendees: 280, totalQuestions: 35, durationSeconds: 3600 } },
];

module.exports = { liveEvent, scheduledEvent, homeEvents, hoursFromNow, hoursAgo };
