# Implementation Plan: Virtual Meetup Platform

## Overview

This plan implements the Virtual Meetup Platform as a serverless AWS application using CDK (JavaScript) for infrastructure, Lambda (Node.js) for compute, DynamoDB for data, Amazon IVS Real-Time for streaming, IVS Chat for messaging, and GitHub Pages for recording publication. Tasks are organized by CDK stack/component, building incrementally from foundational infrastructure to integrated features. Property-based tests use fast-check to validate the 22 correctness properties defined in the design.

## Tasks

- [x] 1. Project scaffolding and shared utilities
  - [x] 1.1 Initialize CDK project structure
    - Create `cdk/` directory with `bin/app.js` entry point
    - Create `cdk/lib/` with placeholder stack files (auth, data, api, streaming, transcription, frontend, publication)
    - Create `cdk/lambda/` directories for each handler (event-crud, session-manager, token-generator, websocket, signup, transcription, publisher)
    - Create `cdk/test/unit/`, `cdk/test/property/`, `cdk/test/integration/` directories
    - Initialize `package.json` with aws-cdk-lib, constructs, fast-check, and testing dependencies
    - _Requirements: All (project foundation)_

  - [x] 1.2 Implement shared constants and utility modules
    - Create `cdk/lambda/shared/constants.js` with event statuses (`scheduled`, `live`, `ended`, `published`), DynamoDB key prefixes (`EVENT#`, `USER#`, `SIGNUP#`, `CONN#`, `HAND#`, `QUESTION#`), and branding colors
    - Create `cdk/lambda/shared/dynamo-utils.js` with helper functions for building DynamoDB keys, parsing entity types, and batch operations
    - Create `cdk/lambda/shared/response.js` with standard API response builders (200, 400, 401, 403, 500)
    - Create `cdk/lambda/shared/validation.js` with input validation helpers (required fields, future date check, email format)
    - _Requirements: All (shared infrastructure)_

- [x] 2. Auth Stack — Cognito User Pool and Identity Pool
  - [x] 2.1 Implement auth-stack.js CDK construct
    - Create Cognito User Pool with email sign-up and verification
    - Add custom attribute `custom:role` (organizer | member)
    - Create App Client with SRP auth flow (no client secret for SPA)
    - Create Identity Pool linked to User Pool
    - Export User Pool ID, User Pool Client ID, and Identity Pool ID as CloudFormation outputs
    - _Requirements: 18.1_

  - [x] 2.2 Write unit tests for auth stack
    - Test that User Pool is created with email verification
    - Test that custom attributes are defined
    - Test that App Client has correct auth flows
    - _Requirements: 18.1_

- [x] 3. Data Stack — DynamoDB tables and GSIs
  - [x] 3.1 Implement data-stack.js CDK construct
    - Create `VirtualMeetupTable` with PK/SK string keys, on-demand billing
    - Add GSI1 (GSI1PK/GSI1SK) for upcoming events by start time
    - Add GSI2 (GSI2PK/GSI2SK) for events by owner
    - Create `WebSocketConnections` table with connectionId as PK, TTL attribute
    - Add GSI `EventConnections` (eventId PK, connectionId SK) for broadcast lookups
    - Export table names and ARNs as CloudFormation outputs
    - _Requirements: 14.1, 17.1_

  - [x] 3.2 Write unit tests for data stack
    - Test table creation with correct key schema
    - Test GSI definitions match design
    - Test on-demand billing mode is set
    - Test TTL is enabled on connections table
    - _Requirements: 14.1, 17.1_

- [x] 4. API Stack — REST API, WebSocket API, and Lambda functions
  - [x] 4.1 Implement Event CRUD Lambda handler
    - Create `cdk/lambda/event-crud/index.js` handling POST/GET/PUT/DELETE /events
    - Implement event creation with unique ID generation, URL generation, and DynamoDB put (with GSI1/GSI2 attributes)
    - Implement event listing via GSI1 query (upcoming events sorted by start time)
    - Implement event get by ID (direct PK/SK lookup)
    - Implement event update (preserve URL, update metadata and GSI sort keys)
    - Implement event deletion (remove from table, handled events show cancellation)
    - Validate scheduled start time is in the future on creation
    - Require authentication for create/edit/delete; allow public access for GET
    - _Requirements: 14.1, 14.2, 14.3, 17.1, 17.2, 17.3, 18.1, 18.2, 18.3_

  - [x] 4.2 Write property tests for event management
    - **Property 12: Event Creation Produces Unique URL with All Metadata**
    - **Validates: Requirements 14.1**
    - **Property 13: Past Start Time Rejected**
    - **Validates: Requirements 14.3**
    - **Property 14: Event URL Preserved Across Edits**
    - **Validates: Requirements 18.2**
    - **Property 15: Authentication Required for Protected Operations**
    - **Validates: Requirements 18.1**
    - **Property 16: Deleted Events Removed from Public Listing**
    - **Validates: Requirements 18.3**
    - **Property 17: Upcoming Event List Contains Only Future Non-Ended Events, Sorted**
    - **Validates: Requirements 17.1, 17.3**
    - **Property 18: Event List Contains All Required Fields**
    - **Validates: Requirements 17.2**

  - [x] 4.3 Implement Sign-Up Lambda handler
    - Create `cdk/lambda/signup/index.js` handling POST /events/{id}/signup and GET /events/{id}/signups
    - Store sign-up as `EVENT#{eventId}` / `SIGNUP#{userId}` in DynamoDB
    - Return confirmation to attendee on successful sign-up
    - List sign-ups for organizer (authenticated, event owner only)
    - _Requirements: 15.2, 15.1_

  - [x] 4.4 Write property test for sign-up registration
    - **Property 22: Sign-Up Registers User for Event**
    - **Validates: Requirements 15.2**

  - [x] 4.5 Implement WebSocket connect/disconnect handlers
    - Create `cdk/lambda/websocket/connect.js` — authenticate via query string token, store connection in WebSocketConnections table with eventId, userId, role, TTL
    - Create `cdk/lambda/websocket/disconnect.js` — remove connection from table
    - Create `cdk/lambda/websocket/broadcast.js` — utility to fan out messages to all connections for an event via API Gateway Management API
    - _Requirements: 5.1, 5.2, 12.1, 12.2_

  - [x] 4.6 Implement WebSocket signaling handler — hand raising
    - Create `cdk/lambda/websocket/signaling.js` handling `raiseHand`, `lowerHand`, `lowerAllHands` actions
    - Store raised hands as `EVENT#{eventId}` / `HAND#{timestamp}#{userId}` in DynamoDB
    - On `lowerHand`: delete specific hand item, broadcast HAND_LOWERED to event
    - On `lowerAllHands`: batch delete all HAND# items for event, broadcast HANDS_CLEARED with count
    - On `raiseHand`: put hand item, broadcast HAND_RAISED to event
    - _Requirements: 5.1, 5.2, 12.1, 12.2, 12.3_

  - [x] 4.7 Write property tests for hand-raising logic
    - **Property 1: Hand Lowering Removes Specific Hand**
    - **Validates: Requirements 5.1**
    - **Property 2: Lower All Hands Clears All**
    - **Validates: Requirements 5.2**
    - **Property 10: Hand Raise/Lower Round-Trip**
    - **Validates: Requirements 12.1, 12.2**
    - **Property 11: Raised Hands Ordered by Time**
    - **Validates: Requirements 12.3**

  - [x] 4.8 Implement WebSocket signaling handler — question queue
    - Add `submitQuestion`, `answerQuestion`, `dismissQuestion` actions to signaling handler
    - Store questions as `EVENT#{eventId}` / `QUESTION#{timestamp}#{questionId}` in DynamoDB
    - On `answerQuestion`: update question status to "answered", remove from active query results, notify submitter
    - On `dismissQuestion`: update question status to "dismissed", remove from active query results
    - Query active questions sorted by SK (timestamp-based FIFO order)
    - _Requirements: 8.1, 8.2, 8.3, 13.1, 13.2, 13.3_

  - [x] 4.9 Write property tests for question queue
    - **Property 6: Question Queue Maintains Submission Order**
    - **Validates: Requirements 8.1, 13.1**
    - **Property 7: Answered or Dismissed Questions Removed from Active Queue**
    - **Validates: Requirements 8.2, 8.3**

  - [x] 4.10 Implement WebSocket signaling handler — role management and chat control
    - Add `promoteUser`, `demoteUser`, `grantSpeak`, `revokeSpeak`, `toggleChat` actions
    - On `promoteUser`: update connection role to co-presenter, broadcast ROLE_CHANGED
    - On `demoteUser`: revert connection role to attendee, revoke speak permission, broadcast ROLE_CHANGED
    - On `grantSpeak`/`revokeSpeak`: update hasSpeakPermission on connection, broadcast SPEAK_PERMISSION_CHANGED
    - On `toggleChat`: store chat enabled/disabled state on event metadata, broadcast CHAT_STATE_CHANGED
    - _Requirements: 7.1, 7.2, 7.3, 9.1, 9.3, 11.1, 11.3_

  - [x] 4.11 Write property tests for role and permission management
    - **Property 5: Role Promotion/Demotion Round-Trip**
    - **Validates: Requirements 7.1, 7.2**
    - **Property 8: Chat Permission Controls Message Acceptance**
    - **Validates: Requirements 9.1, 9.3**
    - **Property 9: Speaking Permission Controls Audio Transmission**
    - **Validates: Requirements 11.1, 11.3**

  - [x] 4.12 Implement API Gateway REST and WebSocket CDK constructs in api-stack.js
    - Create HTTP API with Cognito authorizer for protected routes
    - Define all REST routes (POST/GET/PUT/DELETE /events, POST /events/{id}/start|stop|join|signup, GET /events/{id}/signups)
    - Create WebSocket API with $connect, $disconnect, and custom routes (raiseHand, lowerHand, lowerAllHands, submitQuestion, answerQuestion, dismissQuestion, promoteUser, demoteUser, grantSpeak, revokeSpeak, toggleChat, eventStateUpdate)
    - Create Lambda functions with appropriate IAM roles (DynamoDB access, IVS access, API Gateway Management API)
    - Wire Lambda integrations to API routes
    - Export API endpoint URLs
    - _Requirements: All API-related requirements_

- [x] 5. Checkpoint — Core API and data layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Streaming Stack — IVS Real-Time and Chat
  - [x] 6.1 Implement Session Manager Lambda handler
    - Create `cdk/lambda/session-manager/index.js` handling POST /events/{id}/start and POST /events/{id}/stop
    - On start: create IVS Stage, create IVS Chat Room, update event status to "live", store stageArn and chatRoomArn on event item, broadcast EVENT_STARTED via WebSocket
    - On stop: start Server-Side Composition (S3 destination), update event status to "ended", broadcast EVENT_ENDED, delete stage after composition starts
    - _Requirements: 1.1, 20.1, 21.1_

  - [x] 6.2 Implement Token Generator Lambda handler
    - Create `cdk/lambda/token-generator/index.js` handling POST /events/{id}/join
    - Determine capabilities based on role: presenter/co-presenter get PUBLISH+SUBSCRIBE, attendees with speak permission get PUBLISH+SUBSCRIBE, regular attendees get SUBSCRIBE only
    - Call IVS `createParticipantToken` with stageArn, userId, capabilities, 12-hour duration
    - Call IVS Chat `createChatToken` with roomIdentifier, userId, capabilities (SEND_MESSAGE + DISCONNECT_USER for presenters)
    - Return both tokens to client
    - _Requirements: 4.1, 4.2, 7.1, 11.1_

  - [x] 6.3 Implement streaming-stack.js CDK construct
    - Create S3 bucket for recordings with intelligent-tiering lifecycle rule
    - Create IAM roles for IVS Composition to write to S3
    - Grant Lambda functions permissions to create/manage IVS stages and chat rooms
    - Export recording bucket name and ARN
    - _Requirements: 20.1, 21.1_

  - [x] 6.4 Write unit tests for token generator
    - Test presenter gets PUBLISH+SUBSCRIBE capabilities
    - Test attendee gets SUBSCRIBE only
    - Test attendee with speak permission gets PUBLISH+SUBSCRIBE
    - Test token duration is set to 12 hours
    - _Requirements: 7.1, 11.1_

- [x] 7. Chat and messaging logic
  - [x] 7.1 Implement chat message handling in WebSocket signaling
    - Handle group messages: validate chat is enabled before accepting, reject with CHAT_DISABLED notification if disabled
    - Handle direct messages: route only to presenter's connection(s), confirm delivery to sender
    - Ensure messages include timestamp for chronological ordering on client
    - _Requirements: 6.1, 6.2, 6.3, 9.1, 9.2, 9.3, 10.1, 10.2_

  - [x] 7.2 Write property tests for messaging
    - **Property 3: Direct Messages Delivered Only to Presenter**
    - **Validates: Requirements 6.2, 10.1**
    - **Property 4: Messages Displayed in Chronological Order**
    - **Validates: Requirements 6.3, 9.2**

- [x] 8. Abuse Prevention and Security
  - [x] 8.1 Implement AWS WAF rules in CDK
    - Add WAF WebACL to `api-stack.js` associated with API Gateway REST API and WebSocket API
    - Add WAF WebACL to `frontend-stack.js` associated with CloudFront distribution
    - Configure IP rate-limiting rule: 100 req/min for unauthenticated, 500 req/min for authenticated
    - Add AWS Managed Rules: Bot Control, SQL Injection, XSS, Size Restriction (4KB max for WebSocket/Chat payloads)
    - Configure 5-minute block action on rate limit breach (HTTP 429)
    - _Requirements: 23.1, 23.2, 23.3, 23.4_

  - [x] 8.2 Implement kick and ban WebSocket handlers
    - Add `kickUser`, `banUser`, `unbanUser` routes to WebSocket signaling handler
    - On `kickUser`: call IVS `DisconnectParticipant`, IVS Chat `DisconnectUser`, delete WebSocket connection from DDB, send USER_KICKED message before closing connection
    - On `banUser`: execute kick flow + write `BAN#{userId}` item to DynamoDB with bannedBy, reason, timestamp
    - On `unbanUser`: delete `BAN#{userId}` item from DynamoDB
    - Add ban list query endpoint for presenter (list all BAN# items for event)
    - _Requirements: 24.1, 24.2, 24.3, 24.4_

  - [x] 8.3 Implement ban check in Token Generator
    - Before issuing IVS stage token or chat token, query DynamoDB for `BAN#{userId}` on the event
    - If ban exists, return 403 with "You are banned from this event" message
    - Also check ban on WebSocket `$connect` — reject connection if user is banned
    - _Requirements: 24.4, 25.1_

  - [x] 8.4 Implement Cognito anti-abuse configuration in auth-stack.js
    - Enable Advanced Security Features on Cognito User Pool (adaptive authentication, compromised credential detection)
    - Configure CAPTCHA challenge on sign-up flow
    - Set account lockout: 5 failed attempts → 15-minute temporary lock
    - Enforce email verification as mandatory before token issuance
    - Add admin API to disable/enable user accounts
    - _Requirements: 25.1, 25.2, 25.3, 25.5_

  - [x] 8.5 Implement authentication gate in Token Generator
    - Verify Cognito access token is valid and not expired
    - Check `email_verified: true` claim — reject if not verified
    - Check user account is enabled (not disabled by admin)
    - Ensure unauthenticated users can only view (no tokens issued without auth)
    - _Requirements: 25.1, 25.2, 25.4_

  - [x] 8.6 Implement file transfer prevention
    - Create IVS Chat Message Review Handler Lambda (`cdk/lambda/chat-review/index.js`)
    - Reject messages >500 characters, containing base64 data patterns, or matching URL blocklist
    - Attach message review handler to IVS Chat Room on creation
    - Ensure no file upload endpoints exist in the API (validation/audit)
    - Store URL blocklist in DynamoDB or Lambda environment variable (configurable)
    - _Requirements: 26.1, 26.2, 26.3_

  - [x] 8.7 Implement presenter mute and participation controls
    - Add `muteAudio`, `muteVideo`, `restrictChat`, `restrictQuestions`, `globalMuteAudio`, `globalMuteVideo` WebSocket routes
    - On individual mute: update connection record with `audioMuted`/`videoDisabled`/`chatRestricted`/`questionsRestricted` flags, broadcast state change to affected attendee
    - On global mute: update event metadata with `globalAudioMute`/`globalVideoMute` flags, broadcast to all attendees
    - Enforce in chat handler: check `chatRestricted` and `globalAudioMute` flags before accepting messages
    - Enforce in question handler: check `questionsRestricted` flag before accepting questions
    - Enforce screen share prevention: Token Generator NEVER issues PUBLISH capability to non-promoted attendees (SUBSCRIBE-only tokens for regular attendees)
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6_

  - [x] 8.8 Write property tests for abuse prevention
    - **Property 23: Banned users cannot obtain tokens** — For any banned user attempting to join an event, the token request is rejected with 403
    - **Validates: Requirements 24.4**
    - **Property 24: Non-promoted attendees cannot publish** — For any attendee without co-presenter promotion, the issued token has SUBSCRIBE-only capabilities (no PUBLISH)
    - **Validates: Requirements 27.5**
    - **Property 25: Kicked users are disconnected from all services** — For any kicked user, they are removed from IVS Stage, IVS Chat, and WebSocket simultaneously
    - **Validates: Requirements 24.1**
    - **Property 26: Chat-restricted users cannot send messages** — For any user with chatRestricted=true, message submissions are rejected
    - **Validates: Requirements 27.3**

- [x] 9. Transcription Stack — Real-time captions and translation
  - [x] 9.1 Implement Transcription Orchestrator Lambda
    - Create `cdk/lambda/transcription/index.js` that generates pre-signed URLs for Amazon Transcribe Streaming WebSocket API
    - Implement endpoint for presenter's browser to obtain Transcribe streaming credentials
    - Support language selection for Amazon Translate (generate translate-ready configuration)
    - _Requirements: 19.1, 19.2, 19.3_

  - [x] 9.2 Implement transcription-stack.js CDK construct
    - Create IAM roles for Transcribe Streaming and Translate access
    - Create Lambda function for transcription orchestration
    - Grant permissions for Transcribe StartStreamTranscription and Translate TranslateText
    - _Requirements: 19.1, 19.2_

  - [x] 9.3 Write unit tests for transcription orchestrator
    - Test pre-signed URL generation includes correct service endpoint
    - Test language configuration is passed correctly
    - _Requirements: 19.1, 19.2_

- [x] 10. Checkpoint — Streaming, transcription, and abuse prevention
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Publication Stack — Recording publication to GitHub Pages
  - [x] 11.1 Implement Publisher Lambda handler
    - Create `cdk/lambda/publisher/index.js` triggered by EventBridge on S3 recording completion
    - Read recording metadata from S3 (event metadata, duration, HLS manifest URL)
    - Generate Jekyll markdown post with event title, description, date, CloudFront HLS playback URL, and WebVTT caption reference
    - Generate WebVTT caption file from transcript segments
    - Commit markdown post, transcript, and WebVTT files to GitHub repository via GitHub API
    - _Requirements: 21.2, 21.3, 22.1, 22.2, 22.3_

  - [x] 11.2 Write property tests for publication
    - **Property 20: Playback Page Contains Required Content**
    - **Validates: Requirements 21.2, 22.3**
    - **Property 21: WebVTT Generation from Transcription Segments**
    - **Validates: Requirements 22.1**

  - [x] 11.3 Implement publication-stack.js CDK construct
    - Create EventBridge rule to trigger Publisher Lambda on S3 object creation in recordings prefix
    - Store GitHub token in Secrets Manager, grant Lambda read access
    - Create DLQ (SQS) for failed publication attempts (retry up to 3 times)
    - _Requirements: 21.3, 22.2_

- [x] 12. Event Landing Page and state display logic
  - [x] 12.1 Implement landing page state logic in Event CRUD handler
    - Add endpoint or logic to return event display mode based on status: "scheduled" → show sign-up form, "live"/"ended" → show current status
    - Ensure waiting room data includes event title, scheduled start time, and countdown information
    - _Requirements: 15.1, 15.3, 16.1_

  - [x] 12.2 Write property test for landing page state
    - **Property 19: Event State Determines Landing Page Display Mode**
    - **Validates: Requirements 15.3**

- [x] 13. Frontend Stack — S3 hosting and CloudFront
  - [x] 13.1 Implement frontend-stack.js CDK construct
    - Create S3 bucket for SPA hosting (index.html, JS, CSS, assets)
    - Create CloudFront distribution with S3 origin, OAI, and SPA routing (error page → index.html)
    - Configure custom error responses for 403/404 → index.html (SPA routing)
    - Export CloudFront distribution URL
    - _Requirements: 20.2_

  - [x] 13.2 Implement frontend application shell
    - Create `frontend/index.html` with responsive layout, AWS community branding (Orange #FF9900, Squid Ink #232F3E)
    - Create `frontend/js/app.js` with client-side router for pages: `/`, `/events/:id`, `/events/:id/waiting`, `/events/:id/live`, `/manage`
    - Create `frontend/js/auth.js` with Cognito SDK integration (sign-in, sign-up, token management)
    - Create `frontend/css/styles.css` with design system (colors, typography, responsive breakpoints at 640px/1024px/1280px)
    - _Requirements: 15.1, 16.1, 17.1, 17.2_

  - [x] 13.3 Implement live session page
    - Create `frontend/js/live-session.js` with IVS Web Broadcast SDK integration for stage participation
    - Implement presenter controls: screen share, webcam toggle, mic toggle, device audio toggle
    - Implement attendee view: video player, hand raise/lower button, question submission form
    - Integrate IVS Chat SDK for group and direct messaging UI
    - Implement caption display area with language selector
    - Apply dark theme (Squid Ink background) for live session view
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 11.1, 11.2, 11.3_

  - [x] 13.4 Implement WebSocket client for real-time signaling
    - Create `frontend/js/websocket.js` with connection management (connect, disconnect, auto-reconnect with exponential backoff)
    - Handle incoming messages: HAND_RAISED, HAND_LOWERED, HANDS_CLEARED, QUESTION_SUBMITTED, QUESTION_ANSWERED, QUESTION_DISMISSED, ROLE_CHANGED, SPEAK_PERMISSION_CHANGED, CHAT_STATE_CHANGED, EVENT_STARTED, EVENT_ENDED
    - Implement send actions: raiseHand, lowerHand, submitQuestion, promoteUser, demoteUser, grantSpeak, revokeSpeak, toggleChat
    - _Requirements: 5.1, 5.2, 7.1, 7.2, 8.1, 8.2, 8.3, 12.1, 12.2, 13.1, 13.2, 13.3_

  - [x] 13.5 Implement event management page
    - Create `frontend/js/manage.js` with event CRUD UI (create, edit, delete events)
    - Implement event list for organizer showing their events
    - Implement start/stop event controls
    - Implement sign-up list viewer for organizers
    - _Requirements: 14.1, 14.2, 14.3, 18.1, 18.2, 18.3_

  - [x] 13.6 Implement recording playback with hls.js
    - Create `frontend/js/playback.js` with hls.js integration for HLS playback
    - Implement caption/subtitle track loading from WebVTT file
    - Display event metadata (title, description, date) alongside player
    - _Requirements: 20.2, 21.2, 22.3_

- [x] 14. Checkpoint — Frontend and full integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. CDK app wiring and deployment configuration
  - [x] 15.1 Wire all stacks in bin/app.js
    - Instantiate all 7 stacks with correct dependency order (Auth → Data → API → Streaming → Transcription → Frontend → Publication)
    - Pass cross-stack references (table names, user pool IDs, bucket ARNs) via stack props
    - Configure environment (account, region) from CDK context or environment variables
    - _Requirements: All (deployment)_

  - [x] 15.2 Create CDK deployment documentation and scripts
    - Create `cdk/README.md` with deployment instructions, prerequisites, and environment setup
    - Create `cdk/cdk.json` with app entry point and context defaults
    - Ensure `cdk synth` produces valid CloudFormation for all stacks
    - _Requirements: All (deployment)_

- [x] 16. Observability and metrics
  - [x] 16.1 Implement shared structured logging utility
    - Create `cdk/lambda/shared/logger.js` emitting JSON with timestamp, level, requestId, eventId, userId, action, duration, error fields
    - Integrate logger into all existing Lambda handlers (replace console.log calls)
    - Ensure API Gateway request ID is propagated as correlation ID through all handlers
    - _Requirements: 30.1, 30.3_

  - [x] 16.2 Implement CloudWatch dashboard in CDK
    - Create `cdk/lib/observability-stack.js` with CloudWatch dashboard (`VirtualMeetupPlatform-{env}`)
    - Add widgets: API latency (p50/p95/p99), error rates, Lambda duration/errors/throttles, DynamoDB consumed capacity, WebSocket connections, live event count, chat messages/min, questions/min
    - Set log retention to 30 days for all Lambda Log Groups
    - _Requirements: 29.1, 30.2_

  - [x] 16.3 Implement CloudWatch alarms and SNS notifications
    - Create alarms: API error rate >5%, Lambda error rate >1%, DynamoDB throttling, WebSocket failures >10/min, Lambda p99 >5s, recording composition failures
    - Create SNS topic `VirtualMeetupAlarms-{env}` with configurable email subscribers (via CDK context)
    - Wire all alarms to SNS topic
    - _Requirements: 29.2, 29.3_

  - [x] 16.4 Implement CloudWatch Logs Insights saved queries
    - Create saved queries: error search, slow Lambda invocations (>3s), WebSocket disconnection patterns, failed auth attempts
    - Deploy via CDK custom resource or CloudFormation
    - _Requirements: 29.4_

  - [x] 16.5 Implement custom engagement metrics (CloudWatch EMF)
    - Add EMF metric emission to WebSocket handler: AttendeeCount, ChatMessagesSent, QuestionsSubmitted, HandRaises, CoPresenterPromotions, SessionDuration, KicksIssued, BansIssued
    - Namespace: `VirtualMeetup/{env}`, dimension: `eventId`
    - Emit PeakConcurrentAttendees periodically during live events
    - _Requirements: 32.1_

  - [x] 16.6 Implement IVS media metrics collection
    - Create EventBridge rule to capture IVS stage participant events
    - Create Lambda handler to extract media metrics (bitrate, FPS, packet loss, connection quality) and emit as CloudWatch custom metrics
    - Dimension by eventId and participantId
    - _Requirements: 32.2, 32.4_

  - [x] 16.7 Implement per-event engagement summary storage
    - Add `METRICS` record to DynamoDB (PK: `EVENT#{eventId}`, SK: `METRICS`)
    - Use atomic counters (DynamoDB `ADD`) to increment totalAttendees, totalChatMessages, totalQuestions, totalHandRaises during event
    - Finalize peakConcurrent, avgSessionDuration, media stats on event end
    - _Requirements: 32.3_

  - [x] 16.8 Implement public usage metrics display
    - Add real-time attendee count broadcast via WebSocket (every 5 seconds or on join/leave) for live events
    - Add engagement summary to GET /events/{id} response (from METRICS record) for past events
    - Implement leaderboard endpoint: GET /events/leaderboard returning top events by engagement score
    - Display metrics on frontend: live count badge, past event stats on playback page, leaderboard on homepage
    - _Requirements: 31.1, 31.2, 31.3, 31.4_

  - [x] 16.9 Implement state transition logging
    - Ensure all significant state transitions are logged: event start/stop, user join/leave, role changes, kicks/bans, recording lifecycle, transcription start/stop, publication success/failure
    - Each log entry includes eventId, userId, action, previous state, new state
    - _Requirements: 30.4_

- [x] 17. Load testing suite
  - [x] 17.1 Implement load test framework
    - Create `scripts/load-test/` directory with orchestrator (`index.js`), virtual user (`virtual-user.js`), config (`config.js`), and report (`report.js`)
    - Use `ws` package for WebSocket connections and native `fetch`/`undici` for HTTP
    - Accept target environment config (API URL, WebSocket URL, Cognito credentials) via config file or env vars
    - Implement linear ramp-up: 0 to N users over T seconds (configurable, default 100 users over 60s)
    - _Requirements: 28.1, 28.4, 28.5_

  - [x] 17.2 Implement virtual user scenarios
    - Create `scenarios/join-and-watch.js`: authenticate → join → subscribe → idle → disconnect
    - Create `scenarios/active-participant.js`: authenticate → join → send messages → raise hand → submit question → disconnect
    - Create `scenarios/presenter.js`: authenticate → start event → publish → manage (lower hands, answer questions) → stop event
    - Each scenario records operation latencies and errors
    - _Requirements: 28.2_

  - [x] 17.3 Implement load test reporting
    - Collect latency percentiles (p50, p95, p99) per operation type
    - Calculate error rates and throughput
    - Output console summary table and optional JSON report file
    - Support CI integration (exit code 1 if error rate > threshold)
    - _Requirements: 28.3_

- [x] 18. Diagram generation and documentation
  - [x] 18.1 Implement Mermaid diagram rendering script
    - Create `scripts/generate-diagrams.js` using `@mermaid-js/mermaid-cli` (mmdc) to render architecture diagrams from design document Mermaid blocks to PNG/SVG
    - Generate: high-level architecture, data flow, streaming pipeline, recording/publication pipeline diagrams
    - Output diagrams to `docs/diagrams/` directory for GitHub Pages publication
    - _Requirements: Design document diagram generation requirement_

- [x] 19. Post-deployment smoke tests
  - [x] 19.1 Implement smoke test framework and configuration
    - Create `test/smoke/` directory with test runner script (`scripts/smoke-test.js`)
    - Accept deployment outputs (API URL, WebSocket URL, CloudFront URL, Cognito details) via environment variables or a `smoke-config.json` generated by CDK outputs
    - Use lightweight HTTP client (native `fetch` or `undici`) — no heavy test framework needed for smoke tests
    - Include retry logic for eventual consistency (CloudFront propagation, DynamoDB)
    - _Requirements: All (deployment validation)_

  - [x] 19.2 Implement API smoke tests
    - Test GET /events returns 200 with valid JSON array (public, no auth)
    - Test POST /events without auth returns 401
    - Test POST /events with valid auth and future start time returns 201 with event URL
    - Test GET /events/{id} returns created event with correct metadata
    - Test PUT /events/{id} preserves event URL
    - Test DELETE /events/{id} removes event from listing
    - Test POST /events/{id}/signup returns confirmation
    - _Requirements: 14.1, 14.3, 15.2, 17.1, 18.1, 18.2, 18.3_

  - [x] 19.3 Implement WebSocket smoke tests
    - Test $connect with valid auth token succeeds (101 upgrade)
    - Test $connect without auth is rejected
    - Test raiseHand action returns HAND_RAISED broadcast
    - Test lowerHand action returns HAND_LOWERED broadcast
    - Test submitQuestion action returns confirmation
    - _Requirements: 5.1, 12.1, 13.1_

  - [x] 19.4 Implement IVS resource smoke tests
    - Test POST /events/{id}/start creates IVS stage (event status transitions to "live")
    - Test POST /events/{id}/join returns valid participant token and chat token
    - Test POST /events/{id}/stop transitions event to "ended"
    - Verify IVS stage ARN is stored on event record
    - _Requirements: 1.1, 4.1, 20.1, 21.1_

  - [x] 19.5 Implement frontend smoke tests
    - Test CloudFront URL returns 200 with HTML content
    - Test SPA routing (any path returns index.html, not 404)
    - Test static assets (CSS, JS) are accessible and return correct content-type
    - Test Cognito hosted UI redirect is configured correctly
    - _Requirements: 15.1, 16.1, 17.1_

  - [x] 19.6 Implement end-to-end event lifecycle smoke test
    - Create event → verify in listing → sign up → start event → join (get tokens) → stop event → verify status "ended"
    - Validate the full happy path works against deployed infrastructure
    - Clean up test resources after run (delete test event)
    - _Requirements: All (integration validation)_

- [x] 20. GitHub Actions CI/CD pipeline
  - [x] 20.1 Implement CI workflow (test on push/PR)
    - Create `.github/workflows/ci.yml` triggered on push to any branch and pull requests to main
    - Steps: checkout, install dependencies, run linter (eslint), run unit tests, run property-based tests (fast-check)
    - Cache node_modules for faster runs
    - Fail the build if any test fails
    - _Requirements: All (quality gate)_

  - [x] 20.2 Implement CD workflow (deploy on merge to main)
    - Create `.github/workflows/deploy.yml` triggered on push to main branch only
    - Steps: checkout, install dependencies, run tests, `cdk synth`, `cdk deploy --all --require-approval never`
    - Use GitHub OIDC for AWS authentication (no long-lived access keys)
    - Store AWS account ID and region as GitHub repository secrets
    - Export CDK stack outputs to `smoke-config.json` artifact
    - _Requirements: All (deployment automation)_

  - [x] 20.3 Implement post-deploy smoke test job
    - Add job in deploy workflow that runs after successful CDK deploy
    - Download `smoke-config.json` artifact from deploy job
    - Run `scripts/smoke-test.js` against deployed environment
    - On smoke test failure: post GitHub comment on commit, optionally trigger rollback
    - _Requirements: All (deployment validation)_

  - [x] 20.4 Implement environment and branch strategy
    - Support `dev` and `prod` environments via CDK context (`-c env=dev` / `-c env=prod`)
    - Deploy `dev` on push to `develop` branch, deploy `prod` on push to `main` branch
    - Smoke tests run against the deployed environment
    - Create `.github/workflows/destroy.yml` for tearing down dev stacks on branch deletion
    - _Requirements: All (environment management)_

- [x] 21. Final checkpoint — Complete system validation
  - Run full test suite (unit + property + smoke against deployed env)
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate the 22 universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- Smoke tests validate deployed infrastructure works end-to-end
- The frontend uses vanilla JavaScript with IVS SDKs — no heavy framework dependency
- CDK stacks are independently deployable with cross-stack references
- All Lambda handlers use Node.js runtime with shared utility modules
- CI/CD uses GitHub Actions with OIDC for secure AWS access (no stored credentials)
- Developer workflow: code in Kiro → push → CI tests → merge → deploy → smoke tests → use
