'use strict';

// Tests focused on idempotent event-end metric writes (issue #24).
// Covers finalizeMetrics and storeEngagementSummary: first call sets
// finalizedAt, second call is swallowed via ConditionalCheckFailedException
// and does NOT overwrite the snapshot.

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  UpdateCommand: jest.fn((params) => ({ type: 'Update', params })),
  GetCommand: jest.fn((params) => ({ type: 'Get', params })),
}));

const {
  finalizeMetrics,
  storeEngagementSummary,
} = require('../../lambda/shared/engagement-metrics');

function makeConditionFailure() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function lastUpdateParams() {
  for (let i = mockSend.mock.calls.length - 1; i >= 0; i--) {
    const cmd = mockSend.mock.calls[i][0];
    if (cmd && cmd.type === 'Update') return cmd.params;
  }
  throw new Error('no UpdateCommand was issued');
}

describe('engagement-metrics idempotent finalize (issue #24)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('storeEngagementSummary', () => {
    it('first call writes summary, sets finalizedAt, and gates with attribute_not_exists', async () => {
      mockSend.mockResolvedValueOnce({ Attributes: { finalizedAt: 'whatever' } });

      const result = await storeEngagementSummary('T', 'evt_1', {
        totalAttendees: 7,
        totalQuestions: 2,
        durationSeconds: 3600,
      });

      expect(result).toEqual({ finalizedAt: 'whatever' });
      const params = lastUpdateParams();
      expect(params.ConditionExpression).toBe('attribute_not_exists(#finalizedAt)');
      expect(params.ExpressionAttributeNames['#finalizedAt']).toBe('finalizedAt');
      expect(params.UpdateExpression).toContain('#finalizedAt = :now');
      expect(params.UpdateExpression).toContain('#totalAttendees = :totalAttendees');
      expect(params.ExpressionAttributeValues[':totalAttendees']).toBe(7);
      expect(params.ExpressionAttributeValues[':totalQuestions']).toBe(2);
      expect(params.ExpressionAttributeValues[':durationSeconds']).toBe(3600);
    });

    it('returns null and swallows the error on second (already-finalized) call', async () => {
      mockSend.mockRejectedValueOnce(makeConditionFailure());

      const result = await storeEngagementSummary('T', 'evt_1', { totalAttendees: 99 });

      expect(result).toBeNull();
      // Confirm we DID attempt the Update — the no-op happens at DDB, not in JS.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('propagates non-condition errors', async () => {
      const boom = new Error('throttled');
      boom.name = 'ProvisionedThroughputExceededException';
      mockSend.mockRejectedValueOnce(boom);

      await expect(
        storeEngagementSummary('T', 'evt_1', { totalAttendees: 1 }),
      ).rejects.toThrow('throttled');
    });

    it('omits optional fields from the UpdateExpression when not provided', async () => {
      mockSend.mockResolvedValueOnce({ Attributes: {} });

      await storeEngagementSummary('T', 'evt_2', { totalAttendees: 5 });

      const params = lastUpdateParams();
      expect(params.UpdateExpression).toContain('#totalAttendees = :totalAttendees');
      expect(params.UpdateExpression).not.toContain('#totalQuestions');
      expect(params.UpdateExpression).not.toContain('#durationSeconds');
    });
  });

  describe('finalizeMetrics', () => {
    it('first call writes finalMetrics, sets finalizedAt, and returns { finalized: true }', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await finalizeMetrics('T', 'evt_3', {
        avgSessionDurationSec: 1800,
        avgFps: 30,
        recordingDurationSec: 3600,
      });

      expect(result).toEqual({ finalized: true });
      const params = lastUpdateParams();
      expect(params.ConditionExpression).toBe('attribute_not_exists(#finalizedAt)');
      expect(params.UpdateExpression).toContain('#finalizedAt = :now');
      expect(params.UpdateExpression).toContain('#avgSessionDurationSec = :avgSessionDurationSec');
      expect(params.UpdateExpression).toContain('#avgFps = :avgFps');
      expect(params.UpdateExpression).toContain('#recordingDurationSec = :recordingDurationSec');
      expect(params.UpdateExpression).not.toContain('#avgVideoBitrateKbps');
    });

    it('returns { finalized: false, reason: "already-finalized" } on second call', async () => {
      mockSend.mockRejectedValueOnce(makeConditionFailure());

      const result = await finalizeMetrics('T', 'evt_3', { avgFps: 60 });

      expect(result).toEqual({ finalized: false, reason: 'already-finalized' });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('propagates non-condition errors', async () => {
      const boom = new Error('access denied');
      boom.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(boom);

      await expect(finalizeMetrics('T', 'evt_3', { avgFps: 30 })).rejects.toThrow('access denied');
    });
  });
});
