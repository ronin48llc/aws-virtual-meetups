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
  const updateParts = ['#updatedAt = :now'];
  const names = { '#updatedAt': 'updatedAt' };
  const values = { ':now': new Date().toISOString() };

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

  await docClient.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METRICS,
    },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
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
  const updateParts = ['#updatedAt = :now'];
  const names = { '#updatedAt': 'updatedAt' };
  const values = { ':now': new Date().toISOString() };

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

  const result = await docClient.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      PK: buildEventPK(eventId),
      SK: SK.METRICS,
    },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));

  return result.Attributes;
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
