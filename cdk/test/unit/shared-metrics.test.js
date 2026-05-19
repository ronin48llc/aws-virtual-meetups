'use strict';

const {
  emitMetric,
  emitMetrics,
  emitAttendeeCount,
  emitChatMessageSent,
  emitQuestionSubmitted,
  emitHandRaise,
  emitCoPresenterPromotion,
  emitSessionDuration,
  emitKickIssued,
  emitBanIssued,
  emitMediaMetrics,
  NAMESPACE,
} = require('../../lambda/shared/metrics');

describe('shared/metrics (CloudWatch EMF)', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('emitMetric', () => {
    it('should emit a valid EMF log entry', () => {
      emitMetric({
        metricName: 'TestMetric',
        value: 42,
        unit: 'Count',
        dimensions: { eventId: 'evt_123' },
      });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(output._aws).toBeDefined();
      expect(output._aws.Timestamp).toBeDefined();
      expect(output._aws.CloudWatchMetrics).toHaveLength(1);

      const cwMetric = output._aws.CloudWatchMetrics[0];
      expect(cwMetric.Namespace).toBe(NAMESPACE);
      expect(cwMetric.Dimensions).toEqual([['eventId']]);
      expect(cwMetric.Metrics).toEqual([{ Name: 'TestMetric', Unit: 'Count' }]);

      expect(output.TestMetric).toBe(42);
      expect(output.eventId).toBe('evt_123');
    });

    it('should use default unit of Count', () => {
      emitMetric({ metricName: 'Foo', value: 1, dimensions: {} });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Count');
    });

    it('should allow custom namespace', () => {
      emitMetric({ metricName: 'Bar', value: 5, namespace: 'Custom/NS' });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output._aws.CloudWatchMetrics[0].Namespace).toBe('Custom/NS');
    });

    it('should include additional properties', () => {
      emitMetric({
        metricName: 'Baz',
        value: 1,
        properties: { userId: 'user-1', action: 'join' },
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.userId).toBe('user-1');
      expect(output.action).toBe('join');
    });
  });

  describe('emitMetrics (batch)', () => {
    it('should emit multiple metrics in a single EMF entry', () => {
      emitMetrics({
        metrics: [
          { name: 'MetricA', value: 10, unit: 'Count' },
          { name: 'MetricB', value: 20, unit: 'Milliseconds' },
        ],
        dimensions: { eventId: 'evt_456' },
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output._aws.CloudWatchMetrics[0].Metrics).toHaveLength(2);
      expect(output.MetricA).toBe(10);
      expect(output.MetricB).toBe(20);
    });
  });

  describe('engagement metric helpers', () => {
    it('emitAttendeeCount should emit AttendeeCount metric', () => {
      emitAttendeeCount('evt_1', 25);

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.AttendeeCount).toBe(25);
      expect(output.eventId).toBe('evt_1');
    });

    it('emitChatMessageSent should emit ChatMessagesSent with value 1', () => {
      emitChatMessageSent('evt_2');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.ChatMessagesSent).toBe(1);
      expect(output.eventId).toBe('evt_2');
    });

    it('emitQuestionSubmitted should emit QuestionsSubmitted with value 1', () => {
      emitQuestionSubmitted('evt_3');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.QuestionsSubmitted).toBe(1);
    });

    it('emitHandRaise should emit HandRaises with value 1', () => {
      emitHandRaise('evt_4');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.HandRaises).toBe(1);
    });

    it('emitCoPresenterPromotion should emit CoPresenterPromotions', () => {
      emitCoPresenterPromotion('evt_5');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.CoPresenterPromotions).toBe(1);
    });

    it('emitSessionDuration should emit SessionDuration in Seconds', () => {
      emitSessionDuration('evt_6', 3600);

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.SessionDuration).toBe(3600);
      expect(output._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Seconds');
    });

    it('emitKickIssued should emit KicksIssued', () => {
      emitKickIssued('evt_7');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.KicksIssued).toBe(1);
    });

    it('emitBanIssued should emit BansIssued', () => {
      emitBanIssued('evt_8');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.BansIssued).toBe(1);
    });
  });

  describe('emitMediaMetrics', () => {
    it('should emit media performance metrics with eventId and participantId dimensions', () => {
      emitMediaMetrics({
        eventId: 'evt_media',
        participantId: 'part_1',
        videoBitrate: 2500000,
        audioBitrate: 128000,
        framesPerSecond: 30,
        packetLoss: 0.5,
        connectionQuality: 'good',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.eventId).toBe('evt_media');
      expect(output.participantId).toBe('part_1');
      expect(output.VideoBitrate).toBe(2500000);
      expect(output.AudioBitrate).toBe(128000);
      expect(output.FramesPerSecond).toBe(30);
      expect(output.PacketLoss).toBe(0.5);
      expect(output.ConnectionQuality).toBe(3); // good = 3
    });

    it('should only emit provided metrics', () => {
      emitMediaMetrics({
        eventId: 'evt_partial',
        participantId: 'part_2',
        videoBitrate: 1000000,
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.VideoBitrate).toBe(1000000);
      expect(output.AudioBitrate).toBeUndefined();
      expect(output.FramesPerSecond).toBeUndefined();
    });

    it('should not emit if no metrics provided', () => {
      emitMediaMetrics({
        eventId: 'evt_empty',
        participantId: 'part_3',
      });

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should map connection quality to numeric values', () => {
      const qualities = { excellent: 4, good: 3, fair: 2, poor: 1 };

      Object.entries(qualities).forEach(([quality, expected]) => {
        consoleSpy.mockClear();
        emitMediaMetrics({
          eventId: 'evt_q',
          participantId: 'p1',
          connectionQuality: quality,
        });
        const output = JSON.parse(consoleSpy.mock.calls[0][0]);
        expect(output.ConnectionQuality).toBe(expected);
      });
    });
  });
});
