'use strict';

describe('ivs-metrics handler', () => {
  let consoleSpy;
  let handler;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // Re-require to get fresh module
    jest.resetModules();
    process.env.ENVIRONMENT = 'test';
    handler = require('../../lambda/ivs-metrics/index').handler;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.ENVIRONMENT;
  });

  it('should process IVS stage event and emit media metrics', async () => {
    const event = {
      source: 'aws.ivs',
      'detail-type': 'IVS Participant State Change',
      detail: {
        stage_arn: 'arn:aws:ivs:us-east-1:123456789:stage/meetup-evt_abc123',
        participant_id: 'part_xyz',
        media: {
          video_bitrate: 2500000,
          audio_bitrate: 128000,
          fps: 30,
          packet_loss: 0.2,
          connection_quality: 'good',
        },
      },
      requestContext: { requestId: 'eb-req-1' },
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    // Should have emitted structured logs and EMF metrics
    expect(consoleSpy).toHaveBeenCalled();

    // Find the EMF log entry (has _aws field)
    const emfCalls = consoleSpy.mock.calls
      .map((call) => JSON.parse(call[0]))
      .filter((entry) => entry._aws);

    expect(emfCalls.length).toBeGreaterThan(0);
    const emfEntry = emfCalls[0];
    expect(emfEntry.eventId).toBe('evt_abc123');
    expect(emfEntry.participantId).toBe('part_xyz');
    expect(emfEntry.VideoBitrate).toBe(2500000);
  });

  it('should skip events with missing eventId', async () => {
    const event = {
      source: 'aws.ivs',
      'detail-type': 'IVS Stage Update',
      detail: {
        stage_arn: 'arn:aws:ivs:us-east-1:123456789:stage/unknown-stage',
        participant_id: 'part_1',
      },
      requestContext: { requestId: 'eb-req-2' },
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Skipped');
  });

  it('should skip events with missing participantId', async () => {
    const event = {
      source: 'aws.ivs',
      'detail-type': 'IVS Stage Update',
      detail: {
        stage_arn: 'arn:aws:ivs:us-east-1:123456789:stage/meetup-evt_abc',
      },
      requestContext: { requestId: 'eb-req-3' },
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Skipped');
  });

  it('should handle errors gracefully', async () => {
    // Pass an event that will cause an error in processing
    const event = null;

    // The handler should catch the error
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });
});
