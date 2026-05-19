'use strict';

/**
 * IVS Media Metrics Lambda handler.
 * Triggered by EventBridge rules capturing IVS stage participant events.
 * Extracts media performance metrics and emits them as CloudWatch custom metrics via EMF.
 * @module ivs-metrics
 */

const { createLogger } = require('../shared/logger');
const { emitMediaMetrics } = require('../shared/metrics');

/**
 * Main handler — processes IVS stage events from EventBridge.
 *
 * @param {Object} event - EventBridge event containing IVS stage participant data.
 * @returns {Object} Response with statusCode.
 */
exports.handler = async (event) => {
  const logger = createLogger(event);

  try {
    const detail = event.detail || {};
    const source = event.source || '';
    const detailType = event['detail-type'] || '';

    logger.info('Processing IVS stage event', {
      action: 'processIvsEvent',
      extra: { source, detailType },
    });

    // Extract participant and event information from the IVS event
    const stageArn = detail.stage_arn || detail.stageArn || '';
    const participantId = detail.participant_id || detail.participantId || '';
    const eventId = extractEventIdFromStageArn(stageArn) || detail.eventId || '';

    if (!eventId || !participantId) {
      logger.warn('Missing eventId or participantId in IVS event', {
        action: 'processIvsEvent',
        extra: { stageArn, participantId, detailType },
      });
      return { statusCode: 200, body: 'Skipped - missing identifiers' };
    }

    // Extract media metrics from the event detail
    const mediaData = detail.media || detail.metrics || {};
    const videoBitrate = mediaData.video_bitrate || mediaData.videoBitrate;
    const audioBitrate = mediaData.audio_bitrate || mediaData.audioBitrate;
    const framesPerSecond = mediaData.fps || mediaData.framesPerSecond;
    const packetLoss = mediaData.packet_loss || mediaData.packetLoss;
    const connectionQuality = mediaData.connection_quality || mediaData.connectionQuality;

    // Emit metrics via EMF
    emitMediaMetrics({
      eventId,
      participantId,
      videoBitrate,
      audioBitrate,
      framesPerSecond,
      packetLoss,
      connectionQuality,
    });

    logger.info('IVS media metrics emitted', {
      action: 'emitMediaMetrics',
      eventId,
      extra: { participantId, detailType },
    });

    return { statusCode: 200, body: 'Metrics emitted' };
  } catch (err) {
    logger.error('Failed to process IVS stage event', {
      action: 'processIvsEvent',
      error: err.message,
    });
    return { statusCode: 500, body: 'Error processing event' };
  }
};

/**
 * Extract the event ID from an IVS stage ARN.
 * Stage ARNs are expected to contain the event ID in the resource name.
 * Convention: stage name = "meetup-{eventId}"
 *
 * @param {string} stageArn - The IVS stage ARN.
 * @returns {string|null} The extracted event ID or null.
 */
function extractEventIdFromStageArn(stageArn) {
  if (!stageArn) return null;

  // ARN format: arn:aws:ivs:region:account:stage/stage-id
  // We store the eventId as a tag or in the stage name
  // For now, attempt to extract from the stage session metadata
  const parts = stageArn.split('/');
  const stageId = parts[parts.length - 1] || '';

  // If the stage was created with a name like "meetup-evt_abc123"
  if (stageId.startsWith('meetup-')) {
    return stageId.replace('meetup-', '');
  }

  return null;
}
