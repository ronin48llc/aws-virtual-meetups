'use strict';

const {
  buildScheduleName,
  computeScheduleTime,
  formatScheduleExpression,
  createReminderSchedules,
  deleteReminderSchedules,
  SCHEDULER_GROUP,
  OFFSET_24H,
  OFFSET_1H,
} = require('../../lambda/shared/scheduler-utils');

// Mock the @aws-sdk/client-scheduler module
jest.mock('@aws-sdk/client-scheduler', () => {
  const sendMock = jest.fn().mockResolvedValue({});
  const SchedulerClient = jest.fn(() => ({ send: sendMock }));
  const CreateScheduleCommand = jest.fn((params) => ({ ...params, _type: 'CreateSchedule' }));
  const DeleteScheduleCommand = jest.fn((params) => ({ ...params, _type: 'DeleteSchedule' }));
  return { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand, __sendMock: sendMock };
});

// Mock the logger
jest.mock('../../lambda/shared/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { CreateScheduleCommand, DeleteScheduleCommand, __sendMock: sendMock } = require('@aws-sdk/client-scheduler');
const logger = require('../../lambda/shared/logger');

describe('shared/scheduler-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMock.mockResolvedValue({});
  });

  describe('buildScheduleName', () => {
    it('produces correct format for 24h reminder', () => {
      expect(buildScheduleName('evt_abc123', '24h')).toBe('evt_abc123-reminder-24h');
    });

    it('produces correct format for 1h reminder', () => {
      expect(buildScheduleName('evt_abc123', '1h')).toBe('evt_abc123-reminder-1h');
    });

    it('handles event IDs with special characters', () => {
      expect(buildScheduleName('evt-test_123', '24h')).toBe('evt-test_123-reminder-24h');
    });
  });

  describe('computeScheduleTime', () => {
    it('computes 24h offset correctly', () => {
      const start = '2024-03-15T18:00:00Z';
      const result = computeScheduleTime(start, OFFSET_24H);
      expect(result.toISOString()).toBe('2024-03-14T18:00:00.000Z');
    });

    it('computes 1h offset correctly', () => {
      const start = '2024-03-15T18:00:00Z';
      const result = computeScheduleTime(start, OFFSET_1H);
      expect(result.toISOString()).toBe('2024-03-15T17:00:00.000Z');
    });

    it('returns a Date object', () => {
      const result = computeScheduleTime('2024-06-01T12:00:00Z', OFFSET_1H);
      expect(result).toBeInstanceOf(Date);
    });

    it('handles midnight boundary correctly', () => {
      const start = '2024-03-15T00:30:00Z';
      const result = computeScheduleTime(start, OFFSET_1H);
      expect(result.toISOString()).toBe('2024-03-14T23:30:00.000Z');
    });
  });

  describe('formatScheduleExpression', () => {
    it('formats date as at() expression without milliseconds', () => {
      const date = new Date('2024-03-14T18:00:00.000Z');
      expect(formatScheduleExpression(date)).toBe('at(2024-03-14T18:00:00)');
    });

    it('strips milliseconds from the expression', () => {
      const date = new Date('2024-03-14T18:00:00.123Z');
      expect(formatScheduleExpression(date)).toBe('at(2024-03-14T18:00:00)');
    });
  });

  describe('createReminderSchedules', () => {
    const eventId = 'evt_test123';
    const emailLambdaArn = 'arn:aws:lambda:us-east-1:123456789:function:EmailSender';
    const roleArn = 'arn:aws:iam::123456789:role/SchedulerRole';

    it('creates both schedules for future times', async () => {
      // Set scheduledStart far in the future
      const futureStart = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      await createReminderSchedules(eventId, futureStart, emailLambdaArn, roleArn);

      expect(CreateScheduleCommand).toHaveBeenCalledTimes(2);
      expect(sendMock).toHaveBeenCalledTimes(2);

      // Verify 24h schedule
      const call24h = CreateScheduleCommand.mock.calls[0][0];
      expect(call24h.Name).toBe('evt_test123-reminder-24h');
      expect(call24h.GroupName).toBe(SCHEDULER_GROUP);
      expect(call24h.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(call24h.ActionAfterCompletion).toBe('DELETE');
      expect(call24h.Target.Arn).toBe(emailLambdaArn);
      expect(call24h.Target.RoleArn).toBe(roleArn);
      expect(JSON.parse(call24h.Target.Input)).toEqual({
        type: 'day-before-reminder',
        eventId,
      });

      // Verify 1h schedule
      const call1h = CreateScheduleCommand.mock.calls[1][0];
      expect(call1h.Name).toBe('evt_test123-reminder-1h');
      expect(JSON.parse(call1h.Target.Input)).toEqual({
        type: 'hour-before-reminder',
        eventId,
      });
    });

    it('skips past trigger times', async () => {
      // Set scheduledStart 30 minutes from now — both 24h and 1h triggers are in the past
      const soonStart = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      await createReminderSchedules(eventId, soonStart, emailLambdaArn, roleArn);

      expect(CreateScheduleCommand).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping reminder schedule — trigger time is in the past',
        expect.objectContaining({ eventId })
      );
    });

    it('creates only 1h schedule when 24h trigger is in the past', async () => {
      // Set scheduledStart 2 hours from now — 24h is past, 1h is future
      const start = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      await createReminderSchedules(eventId, start, emailLambdaArn, roleArn);

      expect(CreateScheduleCommand).toHaveBeenCalledTimes(1);
      const call = CreateScheduleCommand.mock.calls[0][0];
      expect(call.Name).toBe('evt_test123-reminder-1h');
    });

    it('logs error but does not throw on schedule creation failure', async () => {
      const futureStart = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      sendMock.mockRejectedValue(new Error('Scheduler API error'));

      await expect(
        createReminderSchedules(eventId, futureStart, emailLambdaArn, roleArn)
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to create reminder schedule',
        expect.objectContaining({ eventId, error: 'Scheduler API error' })
      );
    });
  });

  describe('deleteReminderSchedules', () => {
    const eventId = 'evt_del456';

    it('calls DeleteSchedule for both 24h and 1h schedules', async () => {
      await deleteReminderSchedules(eventId);

      expect(DeleteScheduleCommand).toHaveBeenCalledTimes(2);
      expect(sendMock).toHaveBeenCalledTimes(2);

      const call24h = DeleteScheduleCommand.mock.calls[0][0];
      expect(call24h.Name).toBe('evt_del456-reminder-24h');
      expect(call24h.GroupName).toBe(SCHEDULER_GROUP);

      const call1h = DeleteScheduleCommand.mock.calls[1][0];
      expect(call1h.Name).toBe('evt_del456-reminder-1h');
      expect(call1h.GroupName).toBe(SCHEDULER_GROUP);
    });

    it('logs error but does not throw on deletion failure', async () => {
      sendMock.mockRejectedValue(new Error('Schedule not found'));

      await expect(deleteReminderSchedules(eventId)).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to delete reminder schedule',
        expect.objectContaining({ eventId, error: 'Schedule not found' })
      );
    });

    it('continues deleting second schedule even if first fails', async () => {
      sendMock
        .mockRejectedValueOnce(new Error('First failed'))
        .mockResolvedValueOnce({});

      await deleteReminderSchedules(eventId);

      expect(DeleteScheduleCommand).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Deleted reminder schedule',
        expect.objectContaining({ eventId })
      );
    });
  });
});
