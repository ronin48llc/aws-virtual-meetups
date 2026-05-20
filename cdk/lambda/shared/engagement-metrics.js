'use strict';

/**
 * Per-event engagement metrics storage utility.
 * Uses DynamoDB atomic counters (ADD operations) to increment engagement metrics
 * during live events. Stored as EVENT#{eventId} / METRICS in the main table.
 * @module shared/engagement-metrics
 *
 * Requirements: 32.3
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { buildEventPK } = require('./dynamo-utils');
const { SK } = require('./constants');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Increment an atomic counter on the METRICS record for an event.
 * Creates the record if it doesn't exist.
 *
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 * @param {string} counterName - The counter field to increment (e.g., 'totalChatMessages').
 * @param {number} [incrementBy=1] - Amount to increment by.
 * @returns {Promise<Object>} Updated attributes.
 */
async function incrementCounter(tableName, eventId, counterName, incrementBy = 1) {
  const result = await docClient.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METRICS,
    },
    UpdateExpression: 'ADD #counter :inc SET #updatedAt = :now',
    ExpressionAttributeNames: {
      '#counter': counterName,
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':inc': incrementBy,
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  }));

  return result.Attributes;
}

/**
 * Increment totalAttendees counter.
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 */
async function incrementAttendees(tableName, eventId) {
  return incrementCounter(tableName, eventId, 'totalAttendees');
}

/**
 * Increment totalChatMessages counter.
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 */
async function incrementChatMessages(tableName, eventId) {
  return incrementCounter(tableName, eventId, 'totalChatMessages');
}

/**
 * Increment totalQuestions counter.
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 */
async function incrementQuestions(tableName, eventId) {
  return incrementCounter(tableName, eventId, 'totalQuestions');
}

/**
 * Increment totalHandRaises counter.
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 */
async function incrementHandRaises(tableName, eventId) {
  return incrementCounter(tableName, eventId, 'totalHandRaises');
}

/**
 * Update peak concurrent attendees if the new value is higher.
 * Uses a conditional update to only set if the new value exceeds the current.
 *
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 * @param {number} currentCount - Current concurrent attendee count.
 */
async function updatePeakConcurrent(tableName, eventId, currentCount) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: buildEventPK(eventId),
        SK: SK.METRICS,
      },
      UpdateExpression: 'SET #peak = :count, #updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(#peak) OR #peak < :count',
      ExpressionAttributeNames: {
        '#peak': 'peakConcurrent',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':count': currentCount,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (err) {
    // ConditionalCheckFailedException means current peak is already higher — that's fine
    if (err.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }
}

/**
 * Finalize event metrics on event end.
 * Sets final values for avgSessionDuration, media stats, and recording duration.
 *
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 * @param {Object} finalMetrics - Final metric values.
 * @param {number} [finalMetrics.avgSessionDurationSec] - Average session duration in seconds.
 * @param {number} [finalMetrics.avgVideoBitrateKbps] - Average video bitrate.
 * @param {number} [finalMetrics.avgAudioBitrateKbps] - Average audio bitrate.
 * @param {number} [finalMetrics.avgFps] - Average frames per second.
 * @param {number} [finalMetrics.recordingDurationSec] - Recording duration in seconds.
 */
async function finalizeMetrics(tableName, eventId, finalMetrics = {}) {
  // Stamp a finalizedAt sentinel and guard against double-finalize. Mirrors
  // updatePeakConcurrent's conditional-update + swallow pattern. The second
  // call to finalize an already-finalized event becomes a no-op so retries
  // never overwrite the historically correct values.
  const now = new Date().toISOString();
  const updateParts = ['#updatedAt = :now', '#finalizedAt = :now'];
  const names = { '#updatedAt': 'updatedAt', '#finalizedAt': 'finalizedAt' };
  const values = { ':now': now };

  const fields = [
    'avgSessionDurationSec',
    'avgVideoBitrateKbps',
    'avgAudioBitrateKbps',
    'avgFps',
    'recordingDurationSec',
  ];

  for (const field of fields) {
    if (finalMetrics[field] !== undefined) {
      updateParts.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = finalMetrics[field];
    }
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: buildEventPK(eventId),
        SK: SK.METRICS,
      },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ConditionExpression: 'attribute_not_exists(#finalizedAt)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return { finalized: true };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { finalized: false, reason: 'already-finalized' };
    }
    throw err;
  }
}

/**
 * Get the engagement metrics for an event.
 *
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 * @returns {Promise<Object|null>} The metrics record or null if not found.
 */
async function getMetrics(tableName, eventId) {
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METRICS,
    },
  }));

  return result.Item || null;
}

/**
 * Store an engagement summary for an event.
 * Writes totalAttendees, totalQuestions, and duration to the METRICS record.
 *
 * @param {string} tableName - DynamoDB table name.
 * @param {string} eventId - The event identifier.
 * @param {Object} metrics - The metrics to store.
 * @param {number} [metrics.totalAttendees] - Total attendee count.
 * @param {number} [metrics.totalQuestions] - Total questions asked.
 * @param {number} [metrics.durationSeconds] - Event duration in seconds.
 * @returns {Promise<Object>} Updated attributes.
 */
async function storeEngagementSummary(tableName, eventId, metrics = {}) {
  // Stamp finalizedAt and guard against double-finalize. session-manager's
  // endSession path re-counts SIGNUP# / QUESTION# at call time, so a second
  // call (auto-stop racing with manual stop, client retry, etc.) would
  // re-count at a later wall clock and overwrite the at-event-end snapshot.
  // Subsequent calls become no-ops returning null.
  const now = new Date().toISOString();
  const updateParts = ['#updatedAt = :now', '#finalizedAt = :now'];
  const names = { '#updatedAt': 'updatedAt', '#finalizedAt': 'finalizedAt' };
  const values = { ':now': now };

  if (metrics.totalAttendees !== undefined) {
    updateParts.push('#totalAttendees = :totalAttendees');
    names['#totalAttendees'] = 'totalAttendees';
    values[':totalAttendees'] = metrics.totalAttendees;
  }

  if (metrics.totalQuestions !== undefined) {
    updateParts.push('#totalQuestions = :totalQuestions');
    names['#totalQuestions'] = 'totalQuestions';
    values[':totalQuestions'] = metrics.totalQuestions;
  }

  if (metrics.durationSeconds !== undefined) {
    updateParts.push('#durationSeconds = :durationSeconds');
    names['#durationSeconds'] = 'durationSeconds';
    values[':durationSeconds'] = metrics.durationSeconds;
  }

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: buildEventPK(eventId),
        SK: SK.METRICS,
      },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ConditionExpression: 'attribute_not_exists(#finalizedAt)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return result.Attributes;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return null;
    }
    throw err;
  }
}

module.exports = {
  incrementCounter,
  incrementAttendees,
  incrementChatMessages,
  incrementQuestions,
  incrementHandRaises,
  updatePeakConcurrent,
  finalizeMetrics,
  getMetrics,
  storeEngagementSummary,
};
