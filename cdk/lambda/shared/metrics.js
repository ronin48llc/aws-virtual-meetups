'use strict';

/**
 * CloudWatch Embedded Metric Format (EMF) utility for the Virtual Meetup Platform.
 * Emits custom metrics at zero cost via structured log output that CloudWatch
 * automatically extracts as metrics.
 * @module shared/metrics
 *
 * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 */

const NAMESPACE = `VirtualMeetup/${process.env.ENVIRONMENT || 'dev'}`;

/**
 * Emit a CloudWatch EMF metric.
 * The metric is emitted as a structured JSON log line that CloudWatch Logs
 * automatically extracts into a CloudWatch metric.
 *
 * @param {Object} options - Metric options.
 * @param {string} options.metricName - Name of the metric.
 * @param {number} options.value - Metric value.
 * @param {string} [options.unit='Count'] - CloudWatch unit (Count, Seconds, Milliseconds, Bytes, etc.).
 * @param {Object} [options.dimensions={}] - Dimension key-value pairs.
 * @param {string} [options.namespace] - Override the default namespace.
 * @param {Object} [options.properties={}] - Additional properties (not dimensions, just context).
 */
function emitMetric({ metricName, value, unit = 'Count', dimensions = {}, namespace, properties = {} }) {
  const ns = namespace || NAMESPACE;
  const dimensionKeys = Object.keys(dimensions);

  const emfLog = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: ns,
          Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [[]],
          Metrics: [
            {
              Name: metricName,
              Unit: unit,
            },
          ],
        },
      ],
    },
    [metricName]: value,
    ...dimensions,
    ...properties,
  };

  console.log(JSON.stringify(emfLog));
}

/**
 * Emit multiple metrics in a single EMF log entry.
 * All metrics share the same dimensions and namespace.
 *
 * @param {Object} options - Options.
 * @param {Array<{name: string, value: number, unit?: string}>} options.metrics - Array of metrics.
 * @param {Object} [options.dimensions={}] - Shared dimensions.
 * @param {string} [options.namespace] - Override the default namespace.
 * @param {Object} [options.properties={}] - Additional properties.
 */
function emitMetrics({ metrics, dimensions = {}, namespace, properties = {} }) {
  const ns = namespace || NAMESPACE;
  const dimensionKeys = Object.keys(dimensions);

  const metricsDefinitions = metrics.map((m) => ({
    Name: m.name,
    Unit: m.unit || 'Count',
  }));

  const emfLog = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: ns,
          Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [[]],
          Metrics: metricsDefinitions,
        },
      ],
    },
    ...dimensions,
    ...properties,
  };

  // Add metric values
  for (const m of metrics) {
    emfLog[m.name] = m.value;
  }

  console.log(JSON.stringify(emfLog));
}

// -------------------------------------------------------
// Convenience methods for engagement metrics
// -------------------------------------------------------

/**
 * Emit AttendeeCount metric.
 * @param {string} eventId - The event identifier.
 * @param {number} count - Current attendee count.
 */
function emitAttendeeCount(eventId, count) {
  emitMetric({
    metricName: 'AttendeeCount',
    value: count,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit PeakConcurrentAttendees metric.
 * @param {string} eventId - The event identifier.
 * @param {number} count - Peak concurrent attendee count.
 */
function emitPeakConcurrentAttendees(eventId, count) {
  emitMetric({
    metricName: 'PeakConcurrentAttendees',
    value: count,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit ChatMessagesSent metric.
 * @param {string} eventId - The event identifier.
 */
function emitChatMessageSent(eventId) {
  emitMetric({
    metricName: 'ChatMessagesSent',
    value: 1,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit QuestionsSubmitted metric.
 * @param {string} eventId - The event identifier.
 */
function emitQuestionSubmitted(eventId) {
  emitMetric({
    metricName: 'QuestionsSubmitted',
    value: 1,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit HandRaises metric.
 * @param {string} eventId - The event identifier.
 */
function emitHandRaise(eventId) {
  emitMetric({
    metricName: 'HandRaises',
    value: 1,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit CoPresenterPromotions metric.
 * @param {string} eventId - The event identifier.
 */
function emitCoPresenterPromotion(eventId) {
  emitMetric({
    metricName: 'CoPresenterPromotions',
    value: 1,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit SessionDuration metric.
 * @param {string} eventId - The event identifier.
 * @param {number} durationSeconds - Session duration in seconds.
 */
function emitSessionDuration(eventId, durationSeconds) {
  emitMetric({
    metricName: 'SessionDuration',
    value: durationSeconds,
    unit: 'Seconds',
    dimensions: { eventId },
  });
}

/**
 * Emit KicksIssued metric.
 * @param {string} eventId - The event identifier.
 */
function emitKickIssued(eventId) {
  emitMetric({
    metricName: 'KicksIssued',
    value: 1,
    unit: 'Count',
    dimensions: { eventId },
  });
}

/**
 * Emit BansIssued metric.
 * @param {string} eventId - The event identifier.
 */
function emitBanIssued(eventId) {
  emitMetric({
    metricName: 'BansIssued',
    value: 1,
    unit: 'Count',
    dimensions: { eventId },
  });
}

// -------------------------------------------------------
// Media performance metrics
// -------------------------------------------------------

/**
 * Emit media performance metrics from IVS stage events.
 * @param {Object} options - Media metric options.
 * @param {string} options.eventId - The event identifier.
 * @param {string} options.participantId - The participant identifier.
 * @param {number} [options.videoBitrate] - Video bitrate in bits/second.
 * @param {number} [options.audioBitrate] - Audio bitrate in bits/second.
 * @param {number} [options.framesPerSecond] - Frames per second.
 * @param {number} [options.packetLoss] - Packet loss percentage.
 * @param {string} [options.connectionQuality] - Connection quality indicator.
 */
function emitMediaMetrics({ eventId, participantId, videoBitrate, audioBitrate, framesPerSecond, packetLoss, connectionQuality }) {
  const metrics = [];
  const dimensions = { eventId, participantId };

  if (videoBitrate !== undefined) {
    metrics.push({ name: 'VideoBitrate', value: videoBitrate, unit: 'Bits/Second' });
  }
  if (audioBitrate !== undefined) {
    metrics.push({ name: 'AudioBitrate', value: audioBitrate, unit: 'Bits/Second' });
  }
  if (framesPerSecond !== undefined) {
    metrics.push({ name: 'FramesPerSecond', value: framesPerSecond, unit: 'Count/Second' });
  }
  if (packetLoss !== undefined) {
    metrics.push({ name: 'PacketLoss', value: packetLoss, unit: 'Percent' });
  }
  if (connectionQuality !== undefined) {
    // Map quality to numeric value for metric (excellent=4, good=3, fair=2, poor=1)
    const qualityMap = { excellent: 4, good: 3, fair: 2, poor: 1 };
    const qualityValue = qualityMap[connectionQuality] || 0;
    metrics.push({ name: 'ConnectionQuality', value: qualityValue, unit: 'None' });
  }

  if (metrics.length > 0) {
    emitMetrics({ metrics, dimensions });
  }
}

module.exports = {
  emitMetric,
  emitMetrics,
  emitAttendeeCount,
  emitPeakConcurrentAttendees,
  emitChatMessageSent,
  emitQuestionSubmitted,
  emitHandRaise,
  emitCoPresenterPromotion,
  emitSessionDuration,
  emitKickIssued,
  emitBanIssued,
  emitMediaMetrics,
  NAMESPACE,
};
