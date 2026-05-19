# Requirements Document

## Introduction

A virtual meetup platform for AWS user groups built on Amazon IVS and supporting AWS services. The platform enables presenters to stream live sessions (screen share, video, audio) to attendees, with interactive features like chat, Q&A, and hand-raising. Events can be scheduled in advance, streamed in real-time with transcription/translation, recorded for later playback, and published to GitHub Pages. The goal is to eliminate dependency on costly third-party platforms by leveraging AWS infrastructure at minimal cost.

## Glossary

- **Platform**: The virtual meetup web application that orchestrates events, streaming, and user interactions
- **Presenter**: An authenticated user who hosts or co-hosts a meetup session with streaming and moderation privileges
- **Attendee**: A user who joins a meetup session to watch, listen, and interact within permissions granted by the Presenter
- **Event**: A scheduled meetup session with a defined start time, URL, and associated metadata
- **IVS_Channel**: An Amazon Interactive Video Service channel used for real-time video/audio streaming
- **Streaming_Pipeline**: The combination of MediaLive, MediaPackage, S3, and CloudFront used to ingest, package, store, and deliver streams
- **Chat_Service**: The messaging subsystem that handles group messages, direct messages, and the question queue
- **Question_Queue**: An ordered list of questions submitted by Attendees for the Presenter to address
- **Transcript_Service**: The subsystem responsible for real-time transcription and translation of audio streams
- **Recording**: A packaged HLS/RTMP archive of a completed Event stored in S3
- **Landing_Page**: A public-facing web page for event sign-ups or a waiting room before an Event starts
- **GitHub_Pages_Site**: A Jekyll-based static site hosted on GitHub Pages where Recordings and transcripts are published for public playback

## Requirements

### Requirement 1: Presenter Screen Sharing

**User Story:** As a Presenter, I want to share my screen during a meetup, so that Attendees can see my presentation or demo.

#### Acceptance Criteria

1. WHEN the Presenter initiates screen sharing, THE Platform SHALL capture the selected screen or window and transmit it to the IVS_Channel as a video stream
2. WHEN the Presenter stops screen sharing, THE Platform SHALL cease transmitting the screen capture within 2 seconds
3. IF screen capture permission is denied by the browser, THEN THE Platform SHALL display an error message indicating that screen sharing requires browser permission

### Requirement 2: Presenter Video Sharing

**User Story:** As a Presenter, I want to optionally share my webcam video, so that Attendees can see me while I present.

#### Acceptance Criteria

1. WHERE the Presenter enables video sharing, THE Platform SHALL capture the webcam feed and composite it with the screen share stream to the IVS_Channel
2. WHEN the Presenter disables video sharing, THE Platform SHALL stop transmitting the webcam feed within 2 seconds
3. IF no webcam device is detected, THEN THE Platform SHALL display a message indicating no camera is available and allow the session to continue without video

### Requirement 3: Presenter Audio Sharing

**User Story:** As a Presenter, I want to share audio from my device, so that Attendees can hear system sounds during demos or media playback.

#### Acceptance Criteria

1. WHERE the Presenter enables device audio sharing, THE Platform SHALL capture system audio output and mix it into the IVS_Channel audio stream
2. WHEN the Presenter disables device audio sharing, THE Platform SHALL stop transmitting system audio within 2 seconds
3. IF the browser does not support system audio capture, THEN THE Platform SHALL notify the Presenter that device audio sharing is unavailable

### Requirement 4: Presenter Voice Communication

**User Story:** As a Presenter, I want to speak and listen during the meetup, so that I can communicate with Attendees in real time.

#### Acceptance Criteria

1. THE Platform SHALL capture the Presenter microphone audio and transmit it to the IVS_Channel
2. THE Platform SHALL play back audio from other participants with speaking privileges to the Presenter
3. IF the microphone is unavailable or permission is denied, THEN THE Platform SHALL display an error and prevent the Presenter from starting the session without a microphone

### Requirement 5: Presenter Hand Lowering

**User Story:** As a Presenter, I want to lower raised hands of Attendees, so that I can manage the flow of the session.

#### Acceptance Criteria

1. WHEN the Presenter selects a raised hand and chooses to lower it, THE Platform SHALL remove the raised-hand indicator for that Attendee and notify the Attendee
2. WHEN the Presenter chooses to lower all raised hands, THE Platform SHALL remove all raised-hand indicators and notify all affected Attendees

### Requirement 6: Presenter Messaging

**User Story:** As a Presenter, I want to send and receive group messages and direct messages, so that I can communicate with Attendees during the session.

#### Acceptance Criteria

1. WHEN the Presenter sends a group message, THE Chat_Service SHALL deliver the message to all connected Attendees within 1 second
2. WHEN an Attendee sends a direct message to the Presenter, THE Chat_Service SHALL deliver the message only to the Presenter
3. THE Platform SHALL display incoming messages to the Presenter in chronological order

### Requirement 7: Presenter Co-Presenter Management

**User Story:** As a Presenter, I want to promote Attendees to co-presenter and demote co-presenters back to Attendee, so that I can share hosting duties.

#### Acceptance Criteria

1. WHEN the Presenter promotes an Attendee to co-presenter, THE Platform SHALL grant that user Presenter-level streaming and moderation privileges within 3 seconds
2. WHEN the Presenter demotes a co-presenter, THE Platform SHALL revoke Presenter-level privileges and revert the user to Attendee permissions within 3 seconds
3. THE Platform SHALL notify the affected user when their role changes

### Requirement 8: Presenter Question Queue Management

**User Story:** As a Presenter, I want to view and answer questions from the question queue, so that I can address Attendee questions in an organized manner.

#### Acceptance Criteria

1. THE Platform SHALL display the Question_Queue to the Presenter in submission order
2. WHEN the Presenter marks a question as answered, THE Platform SHALL move the question out of the active queue and notify the submitting Attendee
3. WHEN the Presenter dismisses a question, THE Platform SHALL remove the question from the queue

### Requirement 9: Attendee Group Messaging

**User Story:** As an Attendee, I want to read and send group messages, so that I can participate in the session discussion.

#### Acceptance Criteria

1. WHILE the Presenter has enabled group messaging, THE Chat_Service SHALL allow Attendees to send messages visible to all participants
2. THE Platform SHALL display group messages to the Attendee in chronological order
3. WHILE the Presenter has disabled group messaging, THE Chat_Service SHALL reject Attendee group message submissions and display a notification that messaging is disabled

### Requirement 10: Attendee Direct Messaging to Presenter

**User Story:** As an Attendee, I want to send a private message to the Presenter, so that I can ask questions or provide feedback without the group seeing.

#### Acceptance Criteria

1. WHEN an Attendee sends a direct message, THE Chat_Service SHALL deliver the message only to the Presenter
2. THE Platform SHALL confirm to the Attendee that the direct message was sent

### Requirement 11: Attendee Voice Communication

**User Story:** As an Attendee, I want to speak and listen when granted permission, so that I can participate verbally in the session.

#### Acceptance Criteria

1. WHILE the Presenter has granted speaking permission to the Attendee, THE Platform SHALL capture the Attendee microphone audio and transmit it to all participants
2. THE Platform SHALL play back the IVS_Channel audio stream to the Attendee at all times
3. WHILE the Attendee does not have speaking permission, THE Platform SHALL mute the Attendee microphone input and not transmit audio from that Attendee

### Requirement 12: Attendee Hand Raising

**User Story:** As an Attendee, I want to raise and lower my hand, so that I can signal the Presenter that I want to speak or ask a question.

#### Acceptance Criteria

1. WHEN an Attendee raises their hand, THE Platform SHALL display a raised-hand indicator visible to the Presenter
2. WHEN an Attendee lowers their hand, THE Platform SHALL remove the raised-hand indicator
3. THE Platform SHALL display the order in which hands were raised to the Presenter

### Requirement 13: Attendee Question Submission

**User Story:** As an Attendee, I want to submit a question to the queue, so that the Presenter can address it during the session.

#### Acceptance Criteria

1. WHEN an Attendee submits a question, THE Platform SHALL add the question to the Question_Queue in submission order
2. THE Platform SHALL confirm to the Attendee that the question was queued
3. WHEN the Presenter answers or dismisses the question, THE Platform SHALL notify the submitting Attendee of the status change

### Requirement 14: Event Scheduling

**User Story:** As an event organizer, I want to schedule meetups in advance with a generated URL, so that I can share the event link before the session starts.

#### Acceptance Criteria

1. WHEN an authenticated user creates an Event, THE Platform SHALL generate a unique URL for the Event and store the Event metadata including title, description, and scheduled start time
2. THE Platform SHALL make the generated Event URL accessible immediately after creation
3. IF the scheduled start time is in the past, THEN THE Platform SHALL reject the Event creation and display a validation error

### Requirement 15: Event Sign-Up Landing Page

**User Story:** As a potential Attendee, I want to view a landing page for an upcoming event and sign up, so that I can register my interest and receive notifications.

#### Acceptance Criteria

1. THE Landing_Page SHALL display the Event title, description, scheduled start time, and a sign-up form
2. WHEN a user submits the sign-up form, THE Platform SHALL register the user for the Event and send a confirmation
3. IF the Event has already started or ended, THEN THE Landing_Page SHALL display the current Event status instead of the sign-up form

### Requirement 16: Event Waiting Room

**User Story:** As a registered Attendee, I want to see a waiting page before the event starts, so that I know I am in the right place and can join when the session begins.

#### Acceptance Criteria

1. WHILE the Event has not started, THE Landing_Page SHALL display a waiting room with the Event title, scheduled start time, and a countdown
2. WHEN the Presenter starts the Event, THE Platform SHALL redirect waiting Attendees to the live session within 5 seconds

### Requirement 17: Public Event Listing

**User Story:** As a community member, I want to view upcoming public events, so that I can discover and join meetups that interest me.

#### Acceptance Criteria

1. THE Platform SHALL display a public list of upcoming Events sorted by scheduled start time
2. THE Platform SHALL show the Event title, description, scheduled start time, and a link to the Landing_Page for each Event
3. THE Platform SHALL remove Events from the upcoming list after they have ended

### Requirement 18: Authenticated Event Management

**User Story:** As an event organizer, I want to create, edit, and delete events through an authenticated interface, so that I can manage my meetup schedule.

#### Acceptance Criteria

1. THE Platform SHALL require authentication before allowing Event creation, editing, or deletion
2. WHEN an authenticated user edits an Event, THE Platform SHALL update the Event metadata and retain the existing Event URL
3. WHEN an authenticated user deletes an Event, THE Platform SHALL remove the Event from the public listing and display a cancellation notice on the Event URL

### Requirement 19: Real-Time Transcription and Translation

**User Story:** As an Attendee, I want real-time transcription and translation of the session audio, so that I can follow along in my preferred language.

#### Acceptance Criteria

1. WHILE an Event is live, THE Transcript_Service SHALL generate real-time captions from the audio stream
2. WHERE an Attendee selects a target language, THE Transcript_Service SHALL provide translated captions in the selected language
3. THE Platform SHALL display captions to the Attendee with no more than 5 seconds delay from the spoken audio

### Requirement 20: Live Stream Output

**User Story:** As an event organizer, I want the session to be streamed via HLS, so that Attendees can watch using standard media players.

#### Acceptance Criteria

1. WHILE an Event is live, THE Streaming_Pipeline SHALL ingest the IVS_Channel output, package it as HLS, and deliver it via CloudFront
2. THE Platform SHALL provide an HLS playback URL that is compatible with hls.js or equivalent free media players
3. IF the Streaming_Pipeline encounters an ingestion failure, THEN THE Platform SHALL notify the Presenter and attempt to reconnect within 10 seconds

### Requirement 21: Recording and Playback

**User Story:** As a community member, I want to watch recordings of past meetups, so that I can catch up on sessions I missed.

#### Acceptance Criteria

1. WHEN an Event ends, THE Streaming_Pipeline SHALL store the packaged HLS recording in S3
2. THE Platform SHALL generate a playback page for the Recording including the HLS URL and event metadata
3. THE Platform SHALL publish the playback page to the GitHub_Pages_Site as a Jekyll markdown post within 24 hours of Event completion

### Requirement 22: Transcript and Caption File Generation

**User Story:** As a community member, I want transcript and caption files for recorded sessions, so that I can search and reference session content.

#### Acceptance Criteria

1. WHEN an Event ends, THE Transcript_Service SHALL generate a complete transcript file and a WebVTT caption file from the session audio
2. THE Platform SHALL publish the transcript and caption files alongside the Recording on the GitHub_Pages_Site
3. THE Platform SHALL associate the caption file with the playback page so that viewers can enable captions during playback


### Requirement 23: DDoS and Rate Limit Protection

**User Story:** As a platform operator, I want protection against denial-of-service attacks and abusive request patterns, so that the platform remains available for legitimate users.

#### Acceptance Criteria

1. THE Platform SHALL deploy AWS WAF on all public-facing endpoints (CloudFront, API Gateway REST, API Gateway WebSocket) with rate-limiting rules
2. THE Platform SHALL limit API requests to 100 requests per IP per minute for unauthenticated endpoints and 500 requests per IP per minute for authenticated endpoints
3. IF a client exceeds the rate limit, THEN THE Platform SHALL return HTTP 429 (Too Many Requests) and block further requests from that IP for 5 minutes
4. THE Platform SHALL enable AWS Shield Standard (included at no cost) for volumetric DDoS protection on CloudFront and API Gateway

### Requirement 24: User Abuse Management — Kick and Ban

**User Story:** As a Presenter, I want to kick abusive users from the session and ban them from rejoining, so that I can maintain a safe environment.

#### Acceptance Criteria

1. WHEN the Presenter kicks an Attendee, THE Platform SHALL immediately disconnect the Attendee from the IVS Stage, IVS Chat Room, and WebSocket connection, and display a "You have been removed" message to the Attendee
2. WHEN the Presenter bans an Attendee, THE Platform SHALL kick the Attendee and prevent them from rejoining the current Event by rejecting subsequent join requests with a "You are banned from this event" message
3. THE Platform SHALL maintain a ban list per Event, and the Presenter SHALL be able to view and unban users from the list
4. WHEN a banned user attempts to connect to the Event (via stage token, chat token, or WebSocket), THE Platform SHALL reject the connection attempt

### Requirement 25: Authenticated Participation with Anti-Abuse Sign-Up

**User Story:** As a platform operator, I want all interactive participants to be authenticated with verified identities, so that abusers can be identified and blocked.

#### Acceptance Criteria

1. THE Platform SHALL require Cognito authentication (verified email) for any user who wants to interact (chat, raise hand, ask questions, speak, or join as presenter)
2. THE Platform SHALL enforce email verification before granting interactive capabilities
3. THE Platform SHALL support CAPTCHA (Cognito advanced security features) on sign-up to prevent bot registrations
4. THE Platform SHALL allow anonymous/unauthenticated users to view the public event listing and landing pages only — no interactive participation without sign-in
5. IF a user account is flagged or disabled by an administrator, THEN THE Platform SHALL reject all authentication attempts for that account

### Requirement 26: File Transfer Prevention

**User Story:** As a platform operator, I want to prevent file sharing through the platform, so that the system cannot be used to distribute malicious content.

#### Acceptance Criteria

1. THE Chat_Service SHALL reject any message containing file attachments or binary data
2. THE Platform SHALL NOT provide any file upload mechanism to Attendees or Presenters during a session
3. THE Chat_Service SHALL strip or reject messages containing URLs matching known file-sharing patterns (configurable blocklist)

### Requirement 27: Presenter Mute and Participation Controls

**User Story:** As a Presenter, I want to mute attendees' audio, disable their video, and restrict their chat/question participation, so that I can control the session flow and prevent disruption.

#### Acceptance Criteria

1. WHEN the Presenter mutes an Attendee's audio, THE Platform SHALL stop transmitting that Attendee's microphone audio to other participants and display a "muted by presenter" indicator to the Attendee
2. WHEN the Presenter disables an Attendee's video, THE Platform SHALL stop transmitting that Attendee's camera feed and display a "video disabled by presenter" indicator
3. WHEN the Presenter restricts an Attendee's chat participation, THE Chat_Service SHALL reject messages from that Attendee and display a "chat restricted" notification
4. WHEN the Presenter restricts an Attendee's question submission, THE Platform SHALL reject question submissions from that Attendee
5. THE Platform SHALL NOT allow Attendees to publish screen share streams unless they have been promoted to co-presenter — the token generation SHALL issue SUBSCRIBE-only capabilities for non-promoted Attendees
6. THE Platform SHALL allow the Presenter to apply mute/restrict actions to individual Attendees or to all Attendees at once (global mute)

### Requirement 28: Load Testing Suite

**User Story:** As a platform operator, I want to run load tests that simulate realistic event traffic, so that I can validate the platform handles expected concurrency before going live.

#### Acceptance Criteria

1. THE Platform SHALL include a load testing suite capable of simulating N concurrent attendees joining an event (configurable, default 100)
2. THE load testing suite SHALL simulate realistic user behavior: join event, subscribe to stage, send chat messages, raise hands, submit questions, and disconnect
3. THE load testing suite SHALL report latency percentiles (p50, p95, p99), error rates, and throughput for each operation type
4. THE load testing suite SHALL be runnable against any deployed environment via configuration (API URL, WebSocket URL, auth credentials)
5. THE load testing suite SHALL support ramp-up patterns (gradual increase of concurrent users over a configurable duration)

### Requirement 29: Observability — CloudWatch Dashboards and Alarms

**User Story:** As a platform operator, I want CloudWatch dashboards, saved searches, and alarms, so that I can monitor platform health and be alerted to issues in real time.

#### Acceptance Criteria

1. THE Platform SHALL deploy a CloudWatch dashboard displaying: API latency (p50/p95/p99), error rates (4xx/5xx), WebSocket connection count, Lambda duration/errors/throttles, DynamoDB consumed capacity, and IVS stage participant count
2. THE Platform SHALL configure CloudWatch alarms for: API error rate >5% over 5 minutes, Lambda error rate >1% over 5 minutes, DynamoDB throttling events, and WebSocket connection failures >10/minute
3. THE Platform SHALL send alarm notifications to an SNS topic (configurable email/Slack webhook)
4. THE Platform SHALL create CloudWatch Logs Insights saved queries for: error log search, slow Lambda invocations (>3s), WebSocket disconnection patterns, and failed authentication attempts

### Requirement 30: Structured Logging

**User Story:** As a platform operator, I want all Lambda functions and services to emit structured JSON logs with consistent fields, so that I can search, filter, and correlate events across the system.

#### Acceptance Criteria

1. ALL Lambda functions SHALL emit logs in structured JSON format with fields: timestamp, level, requestId, eventId, userId, action, duration, and error (if applicable)
2. THE Platform SHALL set log retention to 30 days for all CloudWatch Log Groups
3. THE Platform SHALL include correlation IDs (requestId) across API Gateway, Lambda, and WebSocket handlers to enable request tracing
4. THE Platform SHALL log all significant state transitions: event start/stop, user join/leave, role changes, kicks/bans, and recording lifecycle events

### Requirement 31: Public Usage Metrics and Leaderboard

**User Story:** As a community member, I want to see usage metrics for events (attendee counts, engagement stats) displayed on the website, so that I can see community activity and event popularity.

#### Acceptance Criteria

1. FOR live events, THE Platform SHALL display a real-time attendee count visible to all participants
2. FOR past events, THE Platform SHALL display total attendees, peak concurrent attendees, total chat messages, and total questions asked on the event's recording/playback page
3. THE Platform SHALL display a leaderboard or summary view showing the most popular events by attendance and engagement
4. THE Platform SHALL update live attendee counts within 5 seconds of a user joining or leaving

### Requirement 32: Internal Engagement Metrics

**User Story:** As a platform operator, I want detailed internal engagement metrics for each event, so that I can analyze usage patterns and improve the platform.

#### Acceptance Criteria

1. THE Platform SHALL emit CloudWatch custom metrics per event for: attendee count, peak concurrent attendees, total chat messages sent, total questions submitted, total hand raises, average session duration per attendee, and number of co-presenter promotions
2. THE Platform SHALL emit CloudWatch custom metrics for media performance: average video bitrate, average audio bitrate, frames per second (from IVS stage metrics where available), and stream health indicators
3. THE Platform SHALL store per-event engagement summaries in DynamoDB for historical querying (total messages, questions, attendees, duration, media stats)
4. THE Platform SHALL make IVS-provided participant metrics (connection quality, bitrate, packet loss) available for operator review via CloudWatch or the management interface
