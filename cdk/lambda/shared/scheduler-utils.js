'use strict';

/**
 * EventBridge Scheduler utilities for managing event reminder schedules.
 * Creates and deletes one-time schedules for 24-hour and 1-hour pre-event reminders.
 * @module shared/scheduler-utils
 */

const { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');
const logger = require('./logger');

const SCHEDULER_GROUP = 'VirtualMeetup-Reminders';
const OFFSET_24H = 24 * 60 * 60 * 1000;
const OFFSET_1H = 60 * 60 * 1000;

const client = new SchedulerClient();

/**
 * Build the schedule name for an event reminder.
 * @param {string} eventId - Event ID.
 * @param {string} reminderType - '24h' or '1h'.
 * @returns {string} Schedule name (e.g., 'evt_abc123-reminder-24h').
 */
function buildScheduleName(eventId, reminderType) {
  return `${eventId}-reminder-${reminderType}`;
}

/**
 * Build the auto-stop schedule name for an event.
 * @param {string} eventId - Event ID.
 * @returns {string} Schedule name (e.g., 'evt_abc123-auto-stop').
 */
function buildAutoStopScheduleName(eventId) {
  return `${eventId}-auto-stop`;
}

/**
 * Build a warning schedule name for an event.
 * @param {string} eventId - Event ID.
 * @param {string} warningType - '5min' or '1min'.
 * @returns {string} Schedule name (e.g., 'evt_abc123-warning-5min').
 */
function buildWarningScheduleName(eventId, warningType) {
  return `${eventId}-warning-${warningType}`;
}

/**
 * Compute the schedule time for a reminder.
 * @param {string} scheduledStart - ISO 8601 event start time.
 * @param {number} offsetMs - Milliseconds before event to fire.
 * @returns {Date} The computed trigger time.
 */
function computeScheduleTime(scheduledStart, offsetMs) {
  return new Date(new Date(scheduledStart).getTime() - offsetMs);
}

/**
 * Format a Date as an EventBridge Scheduler at() expression.
 * @param {Date} date - The trigger time.
 * @returns {string} Schedule expression, e.g. 'at(2024-03-14T18:00:00)'.
 */
function formatScheduleExpression(date) {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, '');
  return `at(${iso})`;
}

/**
 * Create reminder schedules for an event.
 * Only creates schedules for times that are still in the future.
 * @param {string} eventId - Event ID.
 * @param {string} scheduledStart - ISO 8601 event start time.
 * @param {string} emailLambdaArn - ARN of the email sender Lambda.
 * @param {string} roleArn - ARN of the scheduler execution role.
 */
async function createReminderSchedules(eventId, scheduledStart, emailLambdaArn, roleArn) {
  const now = new Date();

  const reminders = [
    { type: '24h', offset: OFFSET_24H, emailType: 'day-before-reminder' },
    { type: '1h', offset: OFFSET_1H, emailType: 'hour-before-reminder' },
  ];

  for (const reminder of reminders) {
    const triggerTime = computeScheduleTime(scheduledStart, reminder.offset);

    if (triggerTime <= now) {
      logger.info('Skipping reminder schedule — trigger time is in the past', {
        eventId,
        extra: { reminderType: reminder.type, triggerTime: triggerTime.toISOString() },
      });
      continue;
    }

    const scheduleName = buildScheduleName(eventId, reminder.type);

    try {
      await client.send(new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
        ScheduleExpression: formatScheduleExpression(triggerTime),
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: {
          Arn: emailLambdaArn,
          RoleArn: roleArn,
          Input: JSON.stringify({ type: reminder.emailType, eventId }),
        },
        ActionAfterCompletion: 'DELETE',
      }));

      logger.info('Created reminder schedule', {
        eventId,
        extra: { scheduleName, triggerTime: triggerTime.toISOString() },
      });
    } catch (err) {
      logger.error('Failed to create reminder schedule', {
        eventId,
        error: err.message,
        extra: { scheduleName },
      });
    }
  }
}

/**
 * Delete all reminder schedules for an event.
 * @param {string} eventId - Event ID.
 */
async function deleteReminderSchedules(eventId) {
  const types = ['24h', '1h'];

  for (const type of types) {
    const scheduleName = buildScheduleName(eventId, type);

    try {
      await client.send(new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
      }));

      logger.info('Deleted reminder schedule', {
        eventId,
        extra: { scheduleName },
      });
    } catch (err) {
      logger.error('Failed to delete reminder schedule', {
        eventId,
        error: err.message,
        extra: { scheduleName },
      });
    }
  }
}

/**
 * Create the auto-stop schedule for a live event.
 * @param {string} eventId - Event ID.
 * @param {string} scheduledEnd - ISO 8601 end time.
 * @param {string} sessionManagerArn - ARN of the session-manager Lambda.
 * @param {string} roleArn - ARN of the scheduler execution role.
 */
async function createAutoStopSchedule(eventId, scheduledEnd, sessionManagerArn, roleArn) {
  const scheduleName = buildAutoStopScheduleName(eventId);
  const triggerTime = new Date(scheduledEnd);

  try {
    await client.send(new CreateScheduleCommand({
      Name: scheduleName,
      GroupName: SCHEDULER_GROUP,
      ScheduleExpression: formatScheduleExpression(triggerTime),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: sessionManagerArn,
        RoleArn: roleArn,
        Input: JSON.stringify({ action: 'auto-stop', eventId }),
      },
      ActionAfterCompletion: 'DELETE',
    }));

    logger.info('Created auto-stop schedule', {
      eventId,
      extra: { scheduleName, triggerTime: triggerTime.toISOString() },
    });
  } catch (err) {
    logger.error('Failed to create auto-stop schedule', {
      eventId,
      error: err.message,
      extra: { scheduleName },
    });
  }
}

/**
 * Create countdown warning schedules (5-min and 1-min before end).
 * Only creates schedules for times still in the future.
 * @param {string} eventId - Event ID.
 * @param {string} scheduledEnd - ISO 8601 end time.
 * @param {string} sessionManagerArn - ARN of the session-manager Lambda.
 * @param {string} roleArn - ARN of the scheduler execution role.
 */
async function createWarningSchedules(eventId, scheduledEnd, sessionManagerArn, roleArn) {
  const now = Date.now();
  const endTime = new Date(scheduledEnd).getTime();

  const warnings = [
    { type: '5min', offsetMs: 5 * 60 * 1000 },
    { type: '1min', offsetMs: 1 * 60 * 1000 },
  ];

  for (const warning of warnings) {
    const triggerTime = new Date(endTime - warning.offsetMs);

    if (triggerTime.getTime() <= now) {
      logger.info('Skipping warning schedule — trigger time is in the past', {
        eventId,
        extra: { warningType: warning.type, triggerTime: triggerTime.toISOString() },
      });
      continue;
    }

    const scheduleName = buildWarningScheduleName(eventId, warning.type);

    try {
      await client.send(new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
        ScheduleExpression: formatScheduleExpression(triggerTime),
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: {
          Arn: sessionManagerArn,
          RoleArn: roleArn,
          Input: JSON.stringify({ action: 'time-warning', eventId, warningType: warning.type }),
        },
        ActionAfterCompletion: 'DELETE',
      }));

      logger.info('Created warning schedule', {
        eventId,
        extra: { scheduleName, warningType: warning.type, triggerTime: triggerTime.toISOString() },
      });
    } catch (err) {
      logger.error('Failed to create warning schedule', {
        eventId,
        error: err.message,
        extra: { scheduleName, warningType: warning.type },
      });
    }
  }
}

/**
 * Delete all warning schedules for an event.
 * Gracefully handles the case where schedules have already been deleted.
 * @param {string} eventId - Event ID.
 */
async function deleteWarningSchedules(eventId) {
  const types = ['5min', '1min'];

  for (const type of types) {
    const scheduleName = buildWarningScheduleName(eventId, type);

    try {
      await client.send(new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
      }));

      logger.info('Deleted warning schedule', {
        eventId,
        extra: { scheduleName },
      });
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        logger.info('Warning schedule already deleted (not found)', {
          eventId,
          extra: { scheduleName },
        });
        continue;
      }
      logger.error('Failed to delete warning schedule', {
        eventId,
        error: err.message,
        extra: { scheduleName },
      });
    }
  }
}

/**
 * Delete the auto-stop schedule for an event.
 * Gracefully handles the case where the schedule has already been deleted
 * (e.g., via ActionAfterCompletion: DELETE after firing).
 * @param {string} eventId - Event ID.
 */
async function deleteAutoStopSchedule(eventId) {
  const scheduleName = buildAutoStopScheduleName(eventId);

  try {
    await client.send(new DeleteScheduleCommand({
      Name: scheduleName,
      GroupName: SCHEDULER_GROUP,
    }));

    logger.info('Deleted auto-stop schedule', {
      eventId,
      extra: { scheduleName },
    });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      logger.info('Auto-stop schedule already deleted (not found)', {
        eventId,
        extra: { scheduleName },
      });
      return;
    }
    logger.error('Failed to delete auto-stop schedule', {
      eventId,
      error: err.message,
      extra: { scheduleName },
    });
  }
}

module.exports = {
  createReminderSchedules,
  deleteReminderSchedules,
  createAutoStopSchedule,
  deleteAutoStopSchedule,
  createWarningSchedules,
  deleteWarningSchedules,
  computeScheduleTime,
  buildScheduleName,
  buildAutoStopScheduleName,
  buildWarningScheduleName,
  formatScheduleExpression,
  SCHEDULER_GROUP,
  OFFSET_24H,
  OFFSET_1H,
};
