# Implementation Plan: Event Duration

## Overview

This plan implements event duration management for the Virtual Meetup Platform. The implementation follows an incremental approach: starting with pure utility functions, then integrating into existing CRUD and session flows, adding scheduler-based auto-stop and warnings, extending WebSocket broadcasts, updating CDK infrastructure, and finally updating email templates and frontend display. Each step builds on the previous, ensuring no orphaned code.

## Tasks

- [x] 1. Implement duration computation and validation utilities
  - [x] 1.1 Add `computeDurationFields` function to `cdk/lambda/shared/validation.js`
    - Accept `scheduledStart` and request data with optional `scheduledEnd` or `durationMinutes`
    - Throw validation error if both are provided (mutual exclusivity)
    - Compute derived value: `scheduledEnd` from `durationMinutes` or vice versa
    - Return `{ scheduledEnd, durationMinutes }` or `null` for open-ended events
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Add `validateDurationFields` function to `cdk/lambda/shared/validation.js`
    - Validate `scheduledEnd` is a valid ISO 8601 date
    - Validate `scheduledEnd` is after `scheduledStart`
    - Validate `durationMinutes` is a positive integer in range [1, 480]
    - Return `{ valid, error }` object
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 1.3 Write property test: Duration computation round-trip
    - **Property 1: Duration computation round-trip**
    - **Validates: Requirements 1.1, 1.2, 3.1, 3.2, 3.3**

  - [x] 1.4 Write property test: Mutual exclusivity rejection
    - **Property 2: Mutual exclusivity rejection**
    - **Validates: Requirements 1.3**

  - [x] 1.5 Write property test: scheduledEnd must be after scheduledStart
    - **Property 3: scheduledEnd after scheduledStart validation**
    - **Validates: Requirements 2.2, 2.5**

  - [x] 1.6 Write property test: durationMinutes range validation
    - **Property 4: durationMinutes range validation**
    - **Validates: Requirements 2.3, 2.4, 2.6**

- [x] 2. Integrate duration fields into event-crud Lambda (create and update)
  - [x] 2.1 Update `createEvent` in `cdk/lambda/event-crud/index.js` to handle duration fields
    - Call `computeDurationFields` and `validateDurationFields` after parsing body
    - Store `scheduledEnd` and `durationMinutes` on the DynamoDB item when provided
    - Return both fields in the creation response
    - Pass `scheduledEnd` and `durationMinutes` to the email Lambda payload
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 2.2 Update `updateEvent` in `cdk/lambda/event-crud/index.js` to handle duration fields
    - Reject `scheduledEnd`/`durationMinutes` updates when event status is "live" (return 400)
    - Call `computeDurationFields` and `validateDurationFields` for scheduled events
    - Recompute `scheduledEnd` when `scheduledStart` changes and `durationMinutes` exists
    - Update DynamoDB with new duration fields
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.3 Update `getEvent` in `cdk/lambda/event-crud/index.js` to return duration fields
    - Include `scheduledEnd` and `durationMinutes` in GET response when present
    - Compute and include `remainingSeconds` when event is live and has `scheduledEnd`
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 2.4 Update `listEvents` in `cdk/lambda/event-crud/index.js` to return duration fields
    - Include `scheduledEnd` and `durationMinutes` in list response items when present
    - _Requirements: 10.1_

  - [x] 2.5 Write property test: Live events reject duration field updates
    - **Property 5: Live events reject duration field updates**
    - **Validates: Requirements 3.4**

  - [x] 2.6 Write property test: GET response includes duration fields when present
    - **Property 12: GET response includes duration fields**
    - **Validates: Requirements 10.1, 10.2, 7.2**

  - [x] 2.7 Write property test: remainingSeconds computation
    - **Property 13: remainingSeconds computation**
    - **Validates: Requirements 10.3**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Extend scheduler-utils with auto-stop and warning schedule functions
  - [x] 4.1 Add `buildAutoStopScheduleName` and `buildWarningScheduleName` to `cdk/lambda/shared/scheduler-utils.js`
    - `buildAutoStopScheduleName(eventId)` returns `{eventId}-auto-stop`
    - `buildWarningScheduleName(eventId, warningType)` returns `{eventId}-warning-{warningType}`
    - Export both functions
    - _Requirements: 8.4_

  - [x] 4.2 Add `createAutoStopSchedule` and `deleteAutoStopSchedule` to `cdk/lambda/shared/scheduler-utils.js`
    - Create a one-time EventBridge Scheduler trigger at `scheduledEnd` targeting session-manager Lambda
    - Use `ActionAfterCompletion: DELETE` for self-cleanup
    - Payload: `{ action: 'auto-stop', eventId }`
    - Delete function removes the schedule by name (graceful on not-found)
    - _Requirements: 4.1, 4.4, 8.1, 8.2_

  - [x] 4.3 Add `createWarningSchedules` and `deleteWarningSchedules` to `cdk/lambda/shared/scheduler-utils.js`
    - Create 5-min and 1-min warning schedules before `scheduledEnd`
    - Only create schedules for times still in the future
    - Payload: `{ action: 'time-warning', eventId, warningType: '5min' | '1min' }`
    - Use `ActionAfterCompletion: DELETE`
    - Delete function removes both warning schedules
    - _Requirements: 7.3, 7.4_

  - [x] 4.4 Write property test: Auto-stop schedule name non-collision
    - **Property 10: Auto-stop schedule name non-collision**
    - **Validates: Requirements 8.4**

- [x] 5. Integrate auto-stop and warnings into session-manager Lambda
  - [x] 5.1 Add auto-stop scheduling to `startEvent` in `cdk/lambda/session-manager/index.js`
    - After setting status to "live", create auto-stop schedule if event has `scheduledEnd`
    - Create warning schedules (5-min and 1-min) if event has `scheduledEnd`
    - Skip scheduling for open-ended events (no `scheduledEnd`)
    - Include `scheduledEnd` in the start response
    - _Requirements: 4.1, 4.5, 7.1_

  - [x] 5.2 Add auto-stop schedule cleanup to `stopEvent` in `cdk/lambda/session-manager/index.js`
    - Delete pending auto-stop schedule on manual stop
    - Delete pending warning schedules on manual stop
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 5.3 Add `handleAutoStop` handler to `cdk/lambda/session-manager/index.js`
    - Handle direct invocation with payload `{ action: 'auto-stop', eventId }`
    - Check event status — skip if not "live" (stale trigger)
    - Stop the event (update status to "ended", set `endedAt`)
    - Broadcast EVENT_ENDED to all connected clients
    - _Requirements: 4.2, 4.3, 8.3_

  - [x] 5.4 Add `handleTimeWarning` handler to `cdk/lambda/session-manager/index.js`
    - Handle direct invocation with payload `{ action: 'time-warning', eventId, warningType }`
    - Check event status — skip if not "live"
    - Broadcast TIME_WARNING (5min) or FINAL_WARNING (1min) with `remainingSeconds` and `scheduledEnd`
    - _Requirements: 7.3, 7.4_

  - [x] 5.5 Update Lambda handler routing in `cdk/lambda/session-manager/index.js`
    - Detect direct invocation (no `httpMethod`) vs HTTP API request
    - Route `action: 'auto-stop'` to `handleAutoStop`
    - Route `action: 'time-warning'` to `handleTimeWarning`
    - _Requirements: 4.2, 7.3, 7.4_

  - [x] 5.6 Write property test: Auto-stop is a no-op for non-live events
    - **Property 6: Auto-stop is a no-op for non-live events**
    - **Validates: Requirements 4.3, 8.3**

- [x] 6. Implement extend event duration endpoint
  - [x] 6.1 Add `extendEvent` handler to `cdk/lambda/session-manager/index.js`
    - Handle POST /events/{id}/extend with body `{ additionalMinutes }`
    - Validate event is in "live" status (reject with 400 otherwise)
    - Validate `additionalMinutes` is a positive integer
    - Validate new total duration does not exceed 480 minutes
    - Compute new `scheduledEnd` and `durationMinutes`
    - Update DynamoDB with new values
    - Delete old auto-stop and warning schedules, create new ones
    - Broadcast DURATION_EXTENDED to all connected clients
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 6.2 Add route for POST /events/{id}/extend in session-manager handler
    - Route `POST /events/{id}/extend` to `extendEvent`
    - _Requirements: 6.1_

  - [x] 6.3 Write property test: Extension computation correctness
    - **Property 7: Extension computation correctness**
    - **Validates: Requirements 6.1**

  - [x] 6.4 Write property test: Extension validation
    - **Property 8: Extension validation**
    - **Validates: Requirements 6.2**

  - [x] 6.5 Write property test: Extend rejected for non-live events
    - **Property 9: Extend rejected for non-live events**
    - **Validates: Requirements 6.5**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Update CDK infrastructure for new route and permissions
  - [x] 8.1 Add POST /events/{id}/extend route to `cdk/lib/api-stack.js`
    - Add HTTP API route with Cognito authorizer pointing to session-manager integration
    - _Requirements: 6.1_

  - [x] 8.2 Add scheduler permissions to session-manager Lambda in `cdk/lib/api-stack.js`
    - Add `scheduler:CreateSchedule` and `scheduler:DeleteSchedule` permissions
    - Add `iam:PassRole` for the scheduler role ARN
    - Add `SESSION_MANAGER_ARN` and `SCHEDULER_ROLE_ARN` environment variables to session-manager
    - _Requirements: 4.1, 6.3, 8.1, 8.2_

- [x] 9. Update email templates with duration information
  - [x] 9.1 Update `renderEventCreated` in `cdk/lambda/email-sender/templates.js`
    - Include `scheduledEnd` and `durationMinutes` in the email body when present
    - Show formatted end time and duration (e.g., "Duration: 1h 30m")
    - _Requirements: 9.1_

  - [x] 9.2 Update `renderDayBeforeReminder` and `renderHourBeforeReminder` templates
    - Include expected duration in the email body when event has duration constraints
    - _Requirements: 9.2_

  - [x] 9.3 Update `renderEventStarted` template
    - Include expected end time in the email body when event has `scheduledEnd`
    - _Requirements: 9.3_

  - [x] 9.4 Update `renderRecap` template to show actual duration
    - Compute actual duration from `startedAt` and `endedAt` if available
    - Display actual vs planned duration
    - _Requirements: 9.4_

  - [x] 9.5 Write property test: Email templates include duration information
    - **Property 11: Email templates include duration info**
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 10. Update auto-stop schedule cleanup on event delete/update
  - [x] 10.1 Update `deleteEvent` in `cdk/lambda/event-crud/index.js`
    - Delete auto-stop and warning schedules when a scheduled event with duration is deleted
    - _Requirements: 8.1_

  - [x] 10.2 Update `updateEvent` in `cdk/lambda/event-crud/index.js` for scheduledEnd changes
    - When `scheduledEnd` changes on a scheduled event, delete old auto-stop/warning schedules (if they exist) and note that new ones will be created at start time
    - _Requirements: 8.2_

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Update frontend to display duration and countdown
  - [x] 12.1 Update `frontend/js/manage.js` to include duration fields in event creation/update forms
    - Add optional `scheduledEnd` or `durationMinutes` input to the create/update event form
    - Send the field in the POST/PUT request body
    - _Requirements: 1.1, 1.2, 3.1, 3.2_

  - [x] 12.2 Update `frontend/js/live-session.js` to display countdown timer
    - Read `scheduledEnd` from session state
    - Compute and display remaining time locally (client-side countdown)
    - Handle TIME_WARNING and FINAL_WARNING WebSocket messages with visual alerts
    - Handle DURATION_EXTENDED message to update the countdown
    - Hide countdown for open-ended events
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 6.4_

  - [x] 12.3 Update `frontend/js/app.js` to display duration on event listings
    - Show `durationMinutes` or formatted duration on event cards
    - Show `scheduledEnd` on event detail page
    - _Requirements: 10.1, 10.2_

- [x] 13. Write unit tests for all components
  - [x] 13.1 Write unit tests for duration computation and validation in `cdk/test/unit/event-duration.test.js`
    - Test `computeDurationFields` with specific examples (30 min, 60 min, 480 min)
    - Test open-ended event creation (no duration fields)
    - Test mutual exclusivity rejection
    - Test validation edge cases (boundary values, invalid types)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 13.2 Write unit tests for event-crud duration integration in `cdk/test/unit/event-duration.test.js`
    - Test create event with `scheduledEnd`
    - Test create event with `durationMinutes`
    - Test update with `scheduledStart` change triggering recomputation
    - Test rejection of duration updates on live events
    - _Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 3.4_

  - [x] 13.3 Write unit tests for auto-stop and warning handlers in `cdk/test/unit/event-duration.test.js`
    - Test `handleAutoStop` with live event (stops it)
    - Test `handleAutoStop` with non-live event (no-op)
    - Test `handleTimeWarning` broadcasts correct message type
    - Test handler routing for direct invocation vs HTTP
    - _Requirements: 4.2, 4.3, 7.3, 7.4, 8.3_

  - [x] 13.4 Write unit tests for extend endpoint in `cdk/test/unit/event-duration.test.js`
    - Test extend happy path with mocked DynamoDB and Scheduler
    - Test extend validation (non-positive, exceeds 480 total)
    - Test extend rejected for non-live events
    - Test DURATION_EXTENDED broadcast payload
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 13.5 Write unit tests for email template duration rendering in `cdk/test/unit/event-duration.test.js`
    - Test event-created template includes duration info
    - Test reminder templates include duration info
    - Test event-started template includes end time
    - Test recap template shows actual duration
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All property tests go in `cdk/test/property/event-duration.property.test.js`
- All unit tests go in `cdk/test/unit/event-duration.test.js`
- The project uses Jest as test runner and fast-check for property-based tests
