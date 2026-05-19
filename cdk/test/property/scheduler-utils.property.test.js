'use strict';

const fc = require('fast-check');

// Mock the @aws-sdk/client-scheduler module
jest.mock('@aws-sdk/client-scheduler', () => {
  const sendMock = jest.fn().mockResolvedValue({});
  const SchedulerClient = jest.fn(() => ({ send: sendMock }));
  const CreateScheduleCommand = jest.fn((params) => ({ ...params, _type: 'CreateSchedule' }));
  const DeleteScheduleCommand = jest.fn((params) => ({ ...params, _type: 'DeleteSchedule' }));
  return { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand, __sendMock: sendMock };
});

// Mock the shared logger
jest.mock('../../lambda/shared/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  createReminderSchedules,
  deleteReminderSchedules,
  computeScheduleTime,
  buildScheduleName,
  formatScheduleExpression,
  SCHEDULER_GROUP,
  OFFSET_24H,
  OFFSET_1H,
} = require('../../lambda/shared/scheduler-utils');

const { CreateScheduleCommand, DeleteScheduleCommand, __sendMock: sendMock } = require('@aws-sdk/client-scheduler');

// --- Arbitraries ---

// Random event ID strings
const arbEventId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')),
  { minLength: 5, maxLength: 30 }
).filter((s) => s.trim().length > 0);

// ISO date strings far in the future (48+ hours from now)
const arbFutureStart = fc.integer({ min: 48 * 60 * 60 * 1000 + 1, max: 365 * 24 * 60 * 60 * 1000 })
  .map((offsetMs) => new Date(Date.now() + offsetMs).toISOString());

// Offset: either 24h or 1h in milliseconds
const arbOffset = fc.constantFrom(OFFSET_24H, OFFSET_1H);

// Constant ARN strings for testing
const arbEmailLambdaArn = fc.constant('arn:aws:lambda:us-east-1:123456789012:function:VirtualMeetup-EmailSender');
const arbRoleArn = fc.constant('arn:aws:iam::123456789012:role/VirtualMeetup-SchedulerRole');

// --- Property Tests ---

describe('Scheduler Utils Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMock.mockResolvedValue({});
  });

  /**
   * Property 3: Schedule Time Calculation
   * Feature: email-notifications, Property 3: Schedule Time Calculation
   * **Validates: Requirements 3.1, 4.1**
   *
   * For any valid future scheduledStart and any offset (24h or 1h),
   * the computed trigger time equals scheduledStart minus offset exactly.
   */
  describe('Property 3: Schedule Time Calculation', () => {
    it('computed trigger time equals scheduledStart minus offset exactly', () => {
      fc.assert(
        fc.property(
          arbFutureStart,
          arbOffset,
          (scheduledStart, offset) => {
            const result = computeScheduleTime(scheduledStart, offset);

            const expectedMs = new Date(scheduledStart).getTime() - offset;
            const expected = new Date(expectedMs);

            expect(result).toBeInstanceOf(Date);
            expect(result.getTime()).toBe(expected.getTime());
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 5: Scheduler Cleanup on Event Delete
   * Feature: email-notifications, Property 5: Scheduler Cleanup on Event Delete
   * **Validates: Requirements 3.4, 4.4, 8.2**
   *
   * For any event, deleting schedules results in deletion of both
   * `{eventId}-reminder-24h` and `{eventId}-reminder-1h`.
   */
  describe('Property 5: Scheduler Cleanup on Event Delete', () => {
    it('deleteReminderSchedules calls DeleteScheduleCommand with both schedule names', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          async (eventId) => {
            jest.clearAllMocks();
            sendMock.mockResolvedValue({});

            await deleteReminderSchedules(eventId);

            // Verify DeleteScheduleCommand was called exactly twice
            expect(DeleteScheduleCommand).toHaveBeenCalledTimes(2);

            const expectedName24h = `${eventId}-reminder-24h`;
            const expectedName1h = `${eventId}-reminder-1h`;

            // Verify the 24h schedule deletion
            expect(DeleteScheduleCommand).toHaveBeenCalledWith({
              Name: expectedName24h,
              GroupName: SCHEDULER_GROUP,
            });

            // Verify the 1h schedule deletion
            expect(DeleteScheduleCommand).toHaveBeenCalledWith({
              Name: expectedName1h,
              GroupName: SCHEDULER_GROUP,
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 6: Scheduler Update Replaces Triggers
   * Feature: email-notifications, Property 6: Scheduler Update Replaces Triggers
   * **Validates: Requirements 8.1**
   *
   * For any event whose scheduledStart changes from T1 to T2,
   * old schedules (from T1) are deleted and new schedules (from T2) are created.
   */
  describe('Property 6: Scheduler Update Replaces Triggers', () => {
    it('deleting old schedules and creating new ones results in delete calls for old and create calls for new time', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbFutureStart,
          arbFutureStart,
          arbEmailLambdaArn,
          arbRoleArn,
          async (eventId, oldStart, newStart, emailLambdaArn, roleArn) => {
            jest.clearAllMocks();
            sendMock.mockResolvedValue({});

            // Step 1: Delete old schedules (simulates update flow)
            await deleteReminderSchedules(eventId);

            // Verify old schedules were deleted
            expect(DeleteScheduleCommand).toHaveBeenCalledTimes(2);
            expect(DeleteScheduleCommand).toHaveBeenCalledWith({
              Name: `${eventId}-reminder-24h`,
              GroupName: SCHEDULER_GROUP,
            });
            expect(DeleteScheduleCommand).toHaveBeenCalledWith({
              Name: `${eventId}-reminder-1h`,
              GroupName: SCHEDULER_GROUP,
            });

            // Clear mocks to isolate create calls
            jest.clearAllMocks();
            sendMock.mockResolvedValue({});

            // Step 2: Create new schedules with new time
            await createReminderSchedules(eventId, newStart, emailLambdaArn, roleArn);

            // Since newStart is 48+ hours in the future, both schedules should be created
            expect(CreateScheduleCommand).toHaveBeenCalledTimes(2);

            // Verify the new 24h schedule uses the new start time
            const call24h = CreateScheduleCommand.mock.calls[0][0];
            expect(call24h.Name).toBe(`${eventId}-reminder-24h`);
            const expected24hTime = computeScheduleTime(newStart, OFFSET_24H);
            expect(call24h.ScheduleExpression).toBe(formatScheduleExpression(expected24hTime));

            // Verify the new 1h schedule uses the new start time
            const call1h = CreateScheduleCommand.mock.calls[1][0];
            expect(call1h.Name).toBe(`${eventId}-reminder-1h`);
            const expected1hTime = computeScheduleTime(newStart, OFFSET_1H);
            expect(call1h.ScheduleExpression).toBe(formatScheduleExpression(expected1hTime));
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 7: Conditional Schedule Creation for Past Times
   * Feature: email-notifications, Property 7: Conditional Schedule Creation for Past Times
   * **Validates: Requirements 8.4**
   *
   * For any event, only schedules whose trigger time is in the future are created;
   * past trigger times are skipped.
   */
  describe('Property 7: Conditional Schedule Creation for Past Times', () => {
    it('only creates schedules for future trigger times, skips past ones', async () => {
      // Generate scheduledStart between 30 minutes and 25 hours from now
      // This range ensures some offsets produce past times and some produce future times
      const arbMixedStart = fc.integer({ min: 30 * 60 * 1000, max: 25 * 60 * 60 * 1000 })
        .map((offsetMs) => new Date(Date.now() + offsetMs).toISOString());

      await fc.assert(
        fc.asyncProperty(
          arbEventId,
          arbMixedStart,
          arbEmailLambdaArn,
          arbRoleArn,
          async (eventId, scheduledStart, emailLambdaArn, roleArn) => {
            jest.clearAllMocks();
            sendMock.mockResolvedValue({});

            const now = new Date();
            const trigger24h = computeScheduleTime(scheduledStart, OFFSET_24H);
            const trigger1h = computeScheduleTime(scheduledStart, OFFSET_1H);

            const future24h = trigger24h > now;
            const future1h = trigger1h > now;

            await createReminderSchedules(eventId, scheduledStart, emailLambdaArn, roleArn);

            // Count expected create calls
            let expectedCalls = 0;
            if (future24h) expectedCalls++;
            if (future1h) expectedCalls++;

            expect(CreateScheduleCommand).toHaveBeenCalledTimes(expectedCalls);

            // Verify that each created schedule has a future trigger time
            for (let i = 0; i < CreateScheduleCommand.mock.calls.length; i++) {
              const params = CreateScheduleCommand.mock.calls[i][0];
              // Extract the time from the schedule expression at(YYYY-MM-DDTHH:MM:SS)
              const match = params.ScheduleExpression.match(/^at\((.+)\)$/);
              expect(match).not.toBeNull();
              const scheduledTime = new Date(match[1] + 'Z');
              // The scheduled time should be in the future relative to when we computed it
              // (allowing small tolerance for test execution time)
              expect(scheduledTime.getTime()).toBeGreaterThan(now.getTime() - 1000);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
