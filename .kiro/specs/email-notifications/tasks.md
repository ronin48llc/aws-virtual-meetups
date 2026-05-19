# Implementation Plan: Email Notifications

## Overview

This plan implements transactional email notifications and enhanced playback for the Virtual Meetup Platform. It adds an Email Sender Lambda with HTML/plain-text templates, EventBridge Scheduler utilities for timed reminders, a CDK Email Stack (SES, Scheduler group, IAM, DLQ), integration with existing Lambdas (event-crud, signup, session-manager, publisher), frontend playback enhancements (download, screenshot, deep-link, captions, transcript), and comprehensive property-based and unit tests. Tasks build incrementally from shared utilities through infrastructure to integration wiring.

## Tasks

- [x] 1. Email templates and sender Lambda
  - [x] 1.1 Create email template renderer module
    - Create `cdk/lambda/email-sender/templates.js` with `renderTemplate(type, data)` and `formatEmailDate(isoDate)` functions
    - Implement templates for all 6 email types: `event-created`, `signup-confirmation`, `day-before-reminder`, `hour-before-reminder`, `event-started`, `recap`
    - Each template returns `{ subject, html, text }` with branded HTML (AWS orange header), plain-text fallback, and footer with unsubscribe instruction
    - Subject lines prefixed with `[Virtual Meetup Platform]`
    - Date formatting includes timezone identifier (e.g., "Saturday, March 15, 2024 at 6:00 PM UTC")
    - Recap template mentions captions, transcript, download, and screenshot features
    - _Requirements: 1.2, 2.2, 3.3, 4.3, 5.2, 6.2, 6.3, 9.1, 9.2, 9.3, 9.4_

  - [x] 1.2 Create email sender Lambda handler
    - Create `cdk/lambda/email-sender/index.js` with handler that routes by `type` field in invocation payload
    - For single-recipient types (`event-created`, `signup-confirmation`): use `recipientEmail` from payload
    - For bulk types (`day-before-reminder`, `hour-before-reminder`, `event-started`, `recap`): query DynamoDB for all attendees (PK=`EVENT#{eventId}`, SK begins_with `SIGNUP#`)
    - Query event metadata (PK=`EVENT#{eventId}`, SK=`METADATA`) for event details when needed
    - Send via SES with `Source: 'Virtual Meetup Platform <phannah@thenetwerk.net>'`
    - Wrap all SES calls in try/catch — log failures with eventId and recipient but never throw
    - Skip sending if no attendees found for bulk types (log and return)
    - Skip sending if event not found (orphaned trigger case — log and return)
    - Environment variables: `TABLE_NAME`, `SES_SENDER`, `FRONTEND_URL`
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.3, 2.4, 3.2, 3.5, 4.2, 4.5, 5.1, 5.3, 5.4, 6.1, 6.4, 6.5, 8.3_

  - [x] 1.3 Write property tests for email templates
    - **Property 1: Email Template Content Completeness** — For any valid event data and any email type, the rendered template contains all required fields in both HTML and plain-text bodies
    - **Validates: Requirements 1.2, 2.2, 3.3, 4.3, 5.2, 6.2**

  - [x] 1.4 Write property test for email structural format
    - **Property 8: Email Structural Format** — For any composed email, it has a non-empty HTML body, non-empty plain-text body, subject containing "Virtual Meetup Platform", and unsubscribe instruction in footer
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 1.5 Write property test for date formatting
    - **Property 9: Date Formatting Includes Timezone** — For any valid ISO 8601 date string, the formatted output contains a human-readable date with timezone identifier
    - **Validates: Requirements 9.4**

  - [x] 1.6 Write property test for email failure resilience
    - **Property 2: Email Failure Resilience** — For any email send operation encountering an SES error, the handler resolves without throwing and logs the error with eventId and recipient
    - **Validates: Requirements 1.4, 2.4, 5.4, 6.5**

  - [x] 1.7 Write property test for bulk email sends
    - **Property 4: Bulk Email Sends to All Attendees** — For any event with N attendees (N > 0), the bulk email function produces exactly N send calls, one per unique attendee email
    - **Validates: Requirements 3.2, 4.2, 5.1, 6.1**

  - [x] 1.8 Write unit tests for email sender Lambda
    - Test handler routing for each email type
    - Test SES call construction (Source, Destination, Message structure)
    - Test error handling (SES failure logged, no exception thrown)
    - Test empty attendee list skips sending
    - Test orphaned trigger (deleted event) skips sending
    - Test From address is always `phannah@thenetwerk.net`
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.3, 2.4, 3.5, 5.4, 6.5, 8.3_

- [x] 2. Scheduler utilities
  - [x] 2.1 Create scheduler utilities module
    - Create `cdk/lambda/shared/scheduler-utils.js` with functions: `createReminderSchedules`, `deleteReminderSchedules`, `computeScheduleTime`, `buildScheduleName`
    - `createReminderSchedules(eventId, scheduledStart, emailLambdaArn, roleArn)`: creates 24h and 1h schedules, skipping any whose trigger time is in the past
    - `deleteReminderSchedules(eventId)`: deletes both schedules by deterministic name (`{eventId}-reminder-24h`, `{eventId}-reminder-1h`)
    - `computeScheduleTime(scheduledStart, offsetMs)`: returns Date = scheduledStart minus offset
    - `buildScheduleName(eventId, reminderType)`: returns `{eventId}-reminder-{type}`
    - Uses EventBridge Scheduler API: `CreateSchedule` with `ActionAfterCompletion: DELETE`, `FlexibleTimeWindow: OFF`, group `VirtualMeetup-Reminders`
    - Wrap schedule operations in try/catch — log failures but don't throw (best-effort)
    - _Requirements: 3.1, 3.4, 4.1, 4.4, 8.1, 8.2, 8.4_

  - [x] 2.2 Write property test for schedule time calculation
    - **Property 3: Schedule Time Calculation** — For any valid future scheduledStart and any offset (24h or 1h), the computed trigger time equals scheduledStart minus offset exactly
    - **Validates: Requirements 3.1, 4.1**

  - [x] 2.3 Write property test for scheduler cleanup on delete
    - **Property 5: Scheduler Cleanup on Event Delete** — For any event, deleting schedules results in deletion of both `{eventId}-reminder-24h` and `{eventId}-reminder-1h`
    - **Validates: Requirements 3.4, 4.4, 8.2**

  - [x] 2.4 Write property test for scheduler update replaces triggers
    - **Property 6: Scheduler Update Replaces Triggers** — For any event whose scheduledStart changes from T1 to T2, old schedules (from T1) are deleted and new schedules (from T2) are created
    - **Validates: Requirements 8.1**

  - [x] 2.5 Write property test for conditional schedule creation
    - **Property 7: Conditional Schedule Creation for Past Times** — For any event, only schedules whose trigger time is in the future are created; past trigger times are skipped
    - **Validates: Requirements 8.4**

  - [x] 2.6 Write unit tests for scheduler utilities
    - Test `buildScheduleName` produces correct format
    - Test `computeScheduleTime` arithmetic for 24h and 1h offsets
    - Test `createReminderSchedules` skips past trigger times
    - Test `createReminderSchedules` creates both schedules for future times
    - Test `deleteReminderSchedules` calls DeleteSchedule for both names
    - Test error handling (schedule creation failure logged, not thrown)
    - _Requirements: 3.1, 4.1, 8.1, 8.2, 8.4_

- [x] 3. Checkpoint — Email sender and scheduler utilities
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. CDK Email Stack
  - [x] 4.1 Implement email-stack.js CDK construct
    - Create `cdk/lib/email-stack.js` defining the email notification infrastructure
    - Create Email Sender Lambda function (`VirtualMeetup-EmailSender`, Node.js 20.x runtime, `cdk/lambda/email-sender` code path)
    - Set Lambda environment variables: `TABLE_NAME`, `SES_SENDER` (`phannah@thenetwerk.net`), `FRONTEND_URL`
    - Create SES email identity for verified sender (`phannah@thenetwerk.net`)
    - Create EventBridge Scheduler Group (`VirtualMeetup-Reminders`)
    - Create IAM Role for Scheduler to invoke the Email Lambda (`VirtualMeetup-SchedulerRole`)
    - Grant Email Lambda permissions: SES SendEmail/SendRawEmail, DynamoDB read on VirtualMeetupTable
    - Create SQS Dead Letter Queue for failed async Lambda invocations
    - Configure Lambda async invoke config with DLQ destination
    - Export Email Lambda ARN and Scheduler Role ARN as CloudFormation outputs
    - _Requirements: 1.1, 3.1, 4.1_

  - [x] 4.2 Wire Email Stack into CDK app
    - Add Email Stack instantiation in `cdk/bin/app.js`
    - Pass cross-stack references: DynamoDB table name/ARN from Data Stack, frontend URL from Frontend Stack
    - Ensure correct dependency ordering (Data Stack → Email Stack)
    - _Requirements: All (deployment)_

  - [x] 4.3 Write unit tests for Email Stack
    - Test Lambda function is created with correct runtime and environment variables
    - Test SES identity resource is created
    - Test Scheduler Group is created with correct name
    - Test IAM Role for Scheduler has Lambda invoke permission
    - Test Email Lambda has SES and DynamoDB permissions
    - Test DLQ is created and wired to Lambda
    - _Requirements: 1.1, 3.1, 4.1_

- [x] 5. Integration with existing Lambdas
  - [x] 5.1 Integrate email trigger into Event CRUD Lambda
    - Modify `cdk/lambda/event-crud/index.js` to async invoke Email Lambda with `event-created` type after successful event creation (include organizer email, event title, description, scheduledStart, eventUrl in payload)
    - After event creation: call `createReminderSchedules` with eventId, scheduledStart, emailLambdaArn, roleArn
    - After event update (if scheduledStart changed): call `deleteReminderSchedules` then `createReminderSchedules` with new time
    - After event deletion: call `deleteReminderSchedules`
    - All email/scheduler operations wrapped in try/catch — failures logged but don't block API response
    - Add `EMAIL_LAMBDA_ARN` and `SCHEDULER_ROLE_ARN` environment variables to Event CRUD Lambda in CDK
    - _Requirements: 1.1, 1.4, 3.1, 3.4, 4.1, 4.4, 8.1, 8.2_

  - [x] 5.2 Integrate email trigger into Signup Lambda
    - Modify `cdk/lambda/signup/index.js` to async invoke Email Lambda with `signup-confirmation` type after successful sign-up (include attendee email, name, event title, scheduledStart, eventUrl in payload)
    - Wrap in try/catch — failure logged but doesn't block sign-up response
    - Add `EMAIL_LAMBDA_ARN` environment variable to Signup Lambda in CDK
    - _Requirements: 2.1, 2.4_

  - [x] 5.3 Integrate email trigger into Session Manager Lambda
    - Modify `cdk/lambda/session-manager/index.js` to async invoke Email Lambda with `event-started` type after event start (include eventId in payload)
    - Wrap in try/catch — failure logged but doesn't block event start operation
    - Add `EMAIL_LAMBDA_ARN` environment variable to Session Manager Lambda in CDK
    - _Requirements: 5.1, 5.4_

  - [x] 5.4 Integrate email trigger into Publisher Lambda
    - Modify `cdk/lambda/publisher/index.js` to async invoke Email Lambda with `recap` type after successful publication (include eventId, playbackUrl, duration in payload)
    - Wrap in try/catch — failure logged but doesn't affect recording publication process
    - Add `EMAIL_LAMBDA_ARN` environment variable to Publisher Lambda in CDK
    - _Requirements: 6.1, 6.5_

  - [x] 5.5 Update CDK stacks to pass Email Lambda ARN and Scheduler Role ARN
    - Update API Stack to add `EMAIL_LAMBDA_ARN` and `SCHEDULER_ROLE_ARN` env vars to Event CRUD Lambda
    - Update API Stack to add `EMAIL_LAMBDA_ARN` env var to Signup Lambda
    - Update Streaming Stack to add `EMAIL_LAMBDA_ARN` env var to Session Manager Lambda
    - Update Publication Stack to add `EMAIL_LAMBDA_ARN` env var to Publisher Lambda
    - Grant Lambda invoke permission on Email Lambda to event-crud, signup, session-manager, and publisher Lambdas
    - Grant EventBridge Scheduler permissions (CreateSchedule, DeleteSchedule) to Event CRUD Lambda
    - _Requirements: All integration requirements_

  - [x] 5.6 Write unit tests for integration points
    - Test event-crud invokes Email Lambda asynchronously on create
    - Test event-crud creates schedules on create
    - Test event-crud deletes and recreates schedules on time update
    - Test event-crud deletes schedules on event delete
    - Test signup invokes Email Lambda on successful sign-up
    - Test session-manager invokes Email Lambda on event start
    - Test publisher invokes Email Lambda on successful publication
    - Test all integrations handle invoke failures gracefully
    - _Requirements: 1.1, 1.4, 2.1, 2.4, 3.1, 5.1, 5.4, 6.1, 6.5, 8.1, 8.2_

- [x] 6. Checkpoint — Infrastructure and integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Frontend playback enhancements
  - [x] 7.1 Implement enhanced playback features
    - Modify `frontend/js/playback.js` to add download button that allows users to download the recording file
    - Add screenshot button that captures current video frame via canvas and downloads as PNG
    - Add deep-link timestamp support: parse `?t=` URL parameter and seek video to specified seconds on load
    - Add conditional rendering: only show video player section when `hlsPlaybackUrl` is present in event data
    - Display event title, description, and scheduled start time alongside the video player
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6, 7.7_

  - [x] 7.2 Implement captions and transcript panel
    - Add WebVTT caption track loading and display during playback (synchronized captions)
    - Add language selector for captions and transcripts (populated from available translated languages)
    - Add full transcript panel alongside video player with clickable timestamps that seek video to corresponding position
    - _Requirements: 7.3, 7.8, 7.9, 7.10_

  - [x] 7.3 Write property test for timestamp deep-link parsing
    - **Property 10: Timestamp Deep-Link Parsing** — For any non-negative integer timestamp parameter, the parser correctly converts it to a seek position in seconds
    - **Validates: Requirements 7.6**

  - [x] 7.4 Write unit tests for playback enhancements
    - Test video player hidden when no playback URL
    - Test video player shown when playback URL present
    - Test hls.js initialization with correct manifest URL
    - Test download button rendered and functional
    - Test screenshot button rendered
    - Test timestamp parameter parsing (valid, invalid, missing)
    - Test caption track loaded from WebVTT URL
    - Test language selector rendered with available languages
    - Test transcript panel with clickable timestamps
    - Test event metadata (title, description, date) displayed alongside player
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

- [x] 8. Final checkpoint — All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–11)
- Unit tests validate specific examples and edge cases
- All email operations are fire-and-forget — they never block the calling API response
- The design uses JavaScript (Node.js 20.x) matching the existing platform stack
