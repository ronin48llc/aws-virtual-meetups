# Implementation Plan: Presenter Dashboard

## Overview

This plan implements the Presenter Dashboard feature in four phases: (1) auto-registration in the token generator, (2) WebSocket connect/disconnect modifications for attendee tracking, (3) new signaling actions for presenter dashboard data retrieval and hand management, and (4) the frontend presenter dashboard panel with real-time updates. Each phase includes property-based and unit tests as sub-tasks.

## Tasks

- [x] 1. Implement auto-registration in Token Generator
  - [x] 1.1 Add `autoRegisterIfNeeded` function to `cdk/lambda/token-generator/index.js`
    - Import `PutCommand` from `@aws-sdk/lib-dynamodb`
    - Import `buildSignupSK` from `../shared/dynamo-utils`
    - Implement `autoRegisterIfNeeded(eventId, claims)` that does a conditional PutCommand with `attribute_not_exists(PK)`
    - Item shape: `{ PK: buildEventPK(eventId), SK: buildSignupSK(claims.userId), userId, displayName, email, registeredAt, source: 'auto-join' }`
    - Catch `ConditionalCheckFailedException` silently (already registered)
    - Log and swallow all other errors (non-blocking)
    - _Requirements: 1.2, 1.4, 1.5_

  - [x] 1.2 Call `autoRegisterIfNeeded` in the `joinEvent` function
    - Call `await autoRegisterIfNeeded(eventId, claims)` after event validation and ban check, before token generation
    - Ensure token generation proceeds regardless of auto-registration outcome
    - _Requirements: 1.1, 1.3_

  - [ ]* 1.3 Write property test: Auto-registration idempotency (Property 1)
    - **Property 1: Auto-registration idempotency**
    - For any authenticated user and live event, calling autoRegisterIfNeeded multiple times results in exactly one signup record with the original timestamp preserved
    - **Validates: Requirements 1.2, 1.4**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 1.4 Write property test: Join resilience under registration failure (Property 2)
    - **Property 2: Join resilience under registration failure**
    - For any valid join request, the Token Generator returns valid tokens regardless of whether auto-registration succeeds, fails, or is skipped
    - **Validates: Requirements 1.3, 1.5**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 1.5 Write unit tests for auto-registration
    - Extend `cdk/test/unit/token-generator.test.js`
    - Test: autoRegisterIfNeeded creates signup record with correct key structure
    - Test: autoRegisterIfNeeded silently skips when record already exists
    - Test: autoRegisterIfNeeded logs error but doesn't throw on DynamoDB failure
    - Test: joinEvent calls autoRegisterIfNeeded before token generation
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Modify WebSocket connect handler for attendee tracking
  - [x] 2.1 Store `displayName` and `email` in connection record in `cdk/lambda/websocket/connect.js`
    - Read `displayName` and `email` from `queryStringParameters`
    - Add both fields to the PutCommand Item alongside existing fields (connectionId, eventId, userId, role, connectedAt, ttl)
    - _Requirements: 2.1, 2.4_

  - [x] 2.2 Broadcast `ATTENDEE_JOINED` after storing connection
    - Import `broadcast` from `./broadcast`
    - After successful PutCommand, call `broadcast(eventId, { type: 'ATTENDEE_JOINED', eventId, data: { userId, displayName, email, role, connectionId } })`
    - Wrap broadcast in try/catch — log errors but don't fail the connection
    - _Requirements: 2.2_

  - [ ]* 2.3 Write property test: ATTENDEE_JOINED broadcast field completeness (Property 4)
    - **Property 4: ATTENDEE_JOINED broadcast field completeness**
    - For any WebSocket connection with valid parameters, the broadcast message contains all four fields (userId, displayName, email, role) matching the connection parameters
    - **Validates: Requirements 2.2**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 2.4 Write unit tests for connect handler changes
    - Extend `cdk/test/unit/websocket-connect.test.js`
    - Test: connection record includes displayName and email from query params
    - Test: ATTENDEE_JOINED broadcast is sent with correct payload
    - Test: connection succeeds even if broadcast fails
    - _Requirements: 2.1, 2.2, 2.4_

- [x] 3. Modify WebSocket disconnect handler for attendee tracking
  - [x] 3.1 Read connection before delete and broadcast `ATTENDEE_LEFT` in `cdk/lambda/websocket/disconnect.js`
    - Import `GetCommand` from `@aws-sdk/lib-dynamodb`
    - Import `broadcast` from `./broadcast`
    - Before DeleteCommand, issue GetCommand to read the connection record (get eventId, userId)
    - If connection found: delete it, then broadcast `{ type: 'ATTENDEE_LEFT', eventId, data: { userId, connectionId } }`
    - If connection not found: still attempt delete (idempotent), skip broadcast
    - Wrap broadcast in try/catch — log errors but still return 200
    - _Requirements: 2.3_

  - [ ]* 3.2 Write property test: ATTENDEE_LEFT broadcast correctness (Property 5)
    - **Property 5: ATTENDEE_LEFT broadcast correctness**
    - For any WebSocket disconnection of a stored connection, the broadcast ATTENDEE_LEFT message contains the userId of the disconnected user
    - **Validates: Requirements 2.3**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 3.3 Write unit tests for disconnect handler changes
    - Add tests to `cdk/test/unit/websocket-connect.test.js` or create new file
    - Test: connection is read before delete
    - Test: ATTENDEE_LEFT broadcast contains correct userId
    - Test: disconnect succeeds even if GetCommand fails
    - Test: disconnect succeeds even if broadcast fails
    - _Requirements: 2.3_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement presenter dashboard signaling actions
  - [x] 5.1 Add `acknowledgeHand` action to `cdk/lambda/websocket/signaling.js`
    - Add case `'acknowledgeHand'` to the switch statement routing to `handleAcknowledgeHand`
    - Implement `handleAcknowledgeHand(eventId, body, connectionId)`:
      - Extract userId and timestamp from body
      - Delete hand record (PK=buildEventPK(eventId), SK=buildHandSK(timestamp, userId))
      - Find user's connection via `getConnectionsForEvent(eventId)` and filter by userId
      - Update connection's `hasSpeakPermission` to true
      - Broadcast `HAND_LOWERED` with userId and timestamp
      - Broadcast `SPEAK_PERMISSION_CHANGED` with connectionId, userId, hasSpeakPermission: true
    - _Requirements: 4.2_

  - [x] 5.2 Add `dismissHand` action to `cdk/lambda/websocket/signaling.js`
    - Add case `'dismissHand'` to the switch statement routing to `handleDismissHand`
    - Implement `handleDismissHand(eventId, body, connectionId)`:
      - Extract userId and timestamp from body
      - Delete hand record (same key pattern as acknowledgeHand)
      - Broadcast `HAND_LOWERED` with userId and timestamp
      - Do NOT modify hasSpeakPermission
    - _Requirements: 4.3_

  - [x] 5.3 Add `getAttendeeList` action to `cdk/lambda/websocket/signaling.js`
    - Add case `'getAttendeeList'` to the switch statement routing to `handleGetAttendeeList`
    - Implement `handleGetAttendeeList(eventId, body, connectionId)`:
      - Call `getConnectionsForEvent(eventId)` to get all connections
      - Map to `{ userId, displayName, email, role, connectionId }`
      - Send response to requesting connection via `sendToConnection(connectionId, { type: 'ATTENDEE_LIST', eventId, data: { attendees, count } })`
    - _Requirements: 2.1, 2.4, 2.5_

  - [x] 5.4 Add `getQuestionQueue` action to `cdk/lambda/websocket/signaling.js`
    - Add case `'getQuestionQueue'` to the switch statement routing to `handleGetQuestionQueue`
    - Implement `handleGetQuestionQueue(eventId, body, connectionId)`:
      - Query VirtualMeetupTable with PK=buildEventPK(eventId), SK begins_with KEY_PREFIX.QUESTION, ScanIndexForward: true
      - Filter results to only status === QUESTION_STATUS.QUEUED
      - Map to `{ questionId, userId, displayName, text, status, submittedAt, timestamp }`
      - Send response via `sendToConnection(connectionId, { type: 'QUESTION_QUEUE', eventId, data: { questions, count } })`
    - _Requirements: 3.1, 3.5, 3.6_

  - [x] 5.5 Add `getHandsList` action to `cdk/lambda/websocket/signaling.js`
    - Add case `'getHandsList'` to the switch statement routing to `handleGetHandsList`
    - Implement `handleGetHandsList(eventId, body, connectionId)`:
      - Query VirtualMeetupTable with PK=buildEventPK(eventId), SK begins_with KEY_PREFIX.HAND, ScanIndexForward: true
      - Map to `{ userId, displayName, timestamp }`
      - Send response via `sendToConnection(connectionId, { type: 'HANDS_LIST', eventId, data: { hands, count } })`
    - _Requirements: 4.1, 4.6_

  - [ ]* 5.6 Write property test: Attendee list completeness (Property 3)
    - **Property 3: Attendee list completeness and field presence**
    - For any set of active connections, getAttendeeList response contains exactly those connections with all required fields and correct count
    - **Validates: Requirements 2.1, 2.4, 2.5**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 5.7 Write property test: Question queue filtering and ordering (Property 6)
    - **Property 6: Question queue filtering and ordering**
    - For any set of questions with mixed statuses, getQuestionQueue returns only queued questions in ascending submittedAt order with correct count
    - **Validates: Requirements 3.1, 3.5, 3.6**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 5.8 Write property test: Question status transitions (Property 7)
    - **Property 7: Question status transitions**
    - For any queued question, answerQuestion changes status to "answered" and dismissQuestion changes status to "dismissed", with correct broadcast
    - **Validates: Requirements 3.2, 3.3**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 5.9 Write property test: Hands list chronological ordering (Property 9)
    - **Property 9: Hands list chronological ordering**
    - For any set of hand-raise records, getHandsList returns them in ascending timestamp order with correct fields and count
    - **Validates: Requirements 4.1, 4.6**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 5.10 Write property test: Acknowledge hand grants speak (Property 10)
    - **Property 10: Acknowledge hand grants speak permission**
    - For any raised hand and corresponding connection, acknowledgeHand deletes the hand record, broadcasts HAND_LOWERED, and sets hasSpeakPermission to true
    - **Validates: Requirements 4.2**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 5.11 Write property test: Dismiss hand preserves speak state (Property 11)
    - **Property 11: Dismiss hand preserves speak permission state**
    - For any raised hand and corresponding connection, dismissHand deletes the hand record and broadcasts HAND_LOWERED WITHOUT modifying hasSpeakPermission
    - **Validates: Requirements 4.3**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 5.12 Write unit tests for signaling dashboard actions
    - Create `cdk/test/unit/websocket-signaling-dashboard.test.js`
    - Test: acknowledgeHand deletes hand record and grants speak permission
    - Test: acknowledgeHand broadcasts HAND_LOWERED and SPEAK_PERMISSION_CHANGED
    - Test: dismissHand deletes hand record without granting speak
    - Test: getAttendeeList returns all connections with correct fields
    - Test: getQuestionQueue filters by status and sorts by submittedAt
    - Test: getHandsList returns hands in chronological order
    - Test: all three get* actions return 400 if eventId missing
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 3.5, 3.6, 4.1, 4.2, 4.3, 4.6_

- [x] 6. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement frontend presenter dashboard panel
  - [x] 7.1 Add presenter dashboard HTML structure to `frontend/js/live-session.js`
    - In `renderPage()`, add a presenter dashboard panel (visible only when `userRole === 'presenter'`)
    - Panel has three tabs: Attendees, Questions, Hands
    - Each tab has a count badge
    - Attendees tab: list of `{ displayName, email, role }` entries
    - Questions tab: list of `{ text, displayName, submittedAt }` with Answer/Dismiss buttons
    - Hands tab: list of `{ displayName, timestamp }` with Acknowledge/Dismiss buttons
    - _Requirements: 2.1, 2.5, 3.1, 3.6, 4.1, 4.6_

  - [x] 7.2 Add WebSocket message handlers for real-time updates
    - Handle `ATTENDEE_JOINED`: add entry to attendee list, increment count
    - Handle `ATTENDEE_LEFT`: remove entry from attendee list, decrement count
    - Handle `ATTENDEE_LIST`: populate full attendee list from response
    - Handle `QUESTION_SUBMITTED`: add to question queue, increment count
    - Handle `QUESTION_ANSWERED`: remove from queue, decrement count
    - Handle `QUESTION_DISMISSED`: remove from queue, decrement count
    - Handle `QUESTION_QUEUE`: populate full question queue from response
    - Handle `HAND_RAISED`: add to hands list, increment count
    - Handle `HAND_LOWERED`: remove from hands list, decrement count
    - Handle `HANDS_LIST`: populate full hands list from response
    - _Requirements: 2.2, 2.3, 3.4, 4.4, 4.5_

  - [x] 7.3 Add presenter action functions (acknowledge/dismiss hand, answer/dismiss question)
    - `acknowledgeHand(userId, timestamp)`: send `{ action: 'acknowledgeHand', eventId, data: { userId, timestamp } }` via WebSocket
    - `dismissHand(userId, timestamp)`: send `{ action: 'dismissHand', eventId, data: { userId, timestamp } }` via WebSocket
    - `answerQuestion(questionId, timestamp)`: send `{ action: 'answerQuestion', eventId, data: { questionId, timestamp } }` via WebSocket
    - `dismissQuestion(questionId, timestamp)`: send `{ action: 'dismissQuestion', eventId, data: { questionId, timestamp } }` via WebSocket
    - _Requirements: 3.2, 3.3, 4.2, 4.3_

  - [x] 7.4 Request initial state on dashboard open
    - When presenter dashboard renders, send `getAttendeeList`, `getQuestionQueue`, and `getHandsList` via WebSocket
    - Also re-request on WebSocket reconnect
    - _Requirements: 2.4, 3.5_

  - [ ]* 7.5 Write property test: Real-time question queue growth (Property 8)
    - **Property 8: Real-time question queue growth**
    - For any valid QUESTION_SUBMITTED message applied to a queue state, the queue length increases by exactly one with the correct entry
    - **Validates: Requirements 3.4**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

  - [ ]* 7.6 Write property test: Real-time hands list consistency (Property 12)
    - **Property 12: Real-time hands list consistency**
    - For any HAND_RAISED message, the list grows by one. For any HAND_LOWERED message matching an entry, that entry is removed and the list shrinks by one
    - **Validates: Requirements 4.4, 4.5**
    - File: `cdk/test/property/presenter-dashboard.property.test.js`

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use fast-check and go in `cdk/test/property/presenter-dashboard.property.test.js`
- Unit tests extend existing files or create `cdk/test/unit/websocket-signaling-dashboard.test.js`
- Checkpoints ensure incremental validation between backend and frontend phases
- The design uses JavaScript throughout — no language selection needed
