# Features

## Live Streaming

- **IVS Real-Time Stages** — Sub-300ms latency WebRTC streaming for presenters and attendees
- **Screen sharing** — Share entire screen, application window, or browser tab
- **Webcam** — HD video (up to 720p) from selected camera device
- **Microphone** — Audio input with device selection and level monitoring
- **Device audio** — Share system audio for demos and media playback
- **Multi-presenter** — Up to 12 simultaneous publishers per stage
- **Adaptive bitrate** — IVS handles quality adaptation based on network conditions

## Green Room

- **Staging mode** — Presenter previews audio/video before going live
- **Device picker** — Select camera, microphone, and audio output from available devices
- **Preview panel** — See exactly what attendees will see
- **Go Live button** — Single click to transition from staging to broadcasting
- **Composition start** — Server-side recording begins automatically on Go Live
- **Attendee notification** — All registered attendees notified when event goes live

## Chat

- **IVS Chat integration** — Native IVS Chat rooms with low-latency message delivery
- **Group messages** — Visible to all participants in the event
- **Direct messages** — Private messages sent only to the presenter
- **Tab filtering** — Switch between "All", "Group", and "Direct" message views
- **System notifications** — Automated messages for role changes, event state updates
- **Chat toggle** — Presenter can enable/disable group chat during session
- **Persistent room** — Chat room created with event, persists across session restarts

## Q&A

- **Submit questions** — Attendees submit text questions to the presenter queue
- **Answer with text** — Presenter types a response; answer broadcast to all attendees
- **Pin Q&A** — Pin important questions to the top of the attendee view
- **Unpin Q&A** — Remove pin to return question to normal position
- **Question history** — All questions preserved with status (queued, answered, dismissed)
- **FIFO ordering** — Questions displayed in submission order
- **Dismiss** — Presenter can dismiss irrelevant questions from the queue

## Hand Raising

- **Raise hand** — Attendee signals desire to speak or ask a question
- **Lower hand** — Attendee can lower their own hand
- **Presenter acknowledge** — Visual indicator that presenter has seen the raised hand
- **Presenter dismiss** — Lower a specific attendee's hand without granting speak
- **Lower all hands** — Clear all raised hands at once
- **Grant speak permission** — Promote attendee to publisher (mic goes live)
- **Revoke speak permission** — Return attendee to subscribe-only mode
- **Ordered list** — Hands displayed in chronological order (first raised = first in list)

## Presenter Dashboard

- **Attendee list** — Real-time list of all connected participants with roles
- **Question queue** — Incoming questions in submission order with action buttons
- **Hands panel** — Raised hands with acknowledge, grant speak, and dismiss actions
- **Role indicators** — Visual badges for organizer, co-presenter, attendee roles
- **Connection count** — Live count of connected attendees
- **Session timer** — Elapsed time and remaining duration display

## Moderation

- **Mute audio** — Remotely mute a participant's microphone
- **Restrict chat** — Prevent a specific user from sending group messages
- **Kick** — Remove a user from the live session (can rejoin)
- **Ban** — Permanently remove a user (cannot rejoin the session)
- **Ban system** — Banned users stored in DynamoDB; checked on connection and token generation
- **Admin API** — Disable/enable Cognito user accounts for platform-level bans

## Event Duration

- **Scheduled end time** — Events have a defined duration set at creation
- **Auto-stop** — EventBridge Scheduler triggers automatic session stop when duration expires
- **Countdown timer** — Client-side countdown displayed to presenter and attendees
- **Extend duration** — Presenter can extend the event by 15/30/60 minutes
- **5-minute warning** — Broadcast notification when 5 minutes remain
- **Graceful shutdown** — Auto-stop triggers composition end and attendee notification

## Recordings

- **Server-side composition** — IVS combines all publisher streams into single HD recording
- **HLS format** — HTTP Live Streaming with `.m3u8` manifest and `.ts` segments
- **CloudFront delivery** — Recordings served via CDN with CORS headers
- **HLS.js playback** — Browser-based player for recording playback
- **S3 lifecycle** — Recordings transition to IA (30 days) then Glacier (90 days)
- **Recording metadata** — Duration, participant count, and timestamps stored in DynamoDB
- **Publication pipeline** — Automatic GitHub Pages publication via EventBridge + Lambda

## Email Notifications

Six email types covering the full event lifecycle:

| Email | Trigger | Recipients |
|-------|---------|-----------|
| Event Created | Event creation | Organizer |
| Signup Confirmation | Attendee registers | Attendee |
| Event Reminder | 1 hour before start (EventBridge Scheduler) | All sign-ups |
| Event Started | Go Live | All sign-ups |
| Event Cancelled | Event deleted | All sign-ups |
| Event Recap | Recording published | All sign-ups |

- **Amazon SES** — Transactional email with DKIM domain verification
- **EventBridge Scheduler** — Time-based triggers for reminders and auto-stop
- **Dead letter queue** — Failed emails captured in SQS for retry/investigation
- **Fire-and-forget** — Email sending is non-blocking (async Lambda invocation)
- **HTML templates** — Branded email templates with event details and action links

## Custom Domain

- **Route53 hosted zone** — DNS management for `awsvirtualmeetups.com`
- **ACM certificate** — Wildcard TLS certificate (apex + `*.awsvirtualmeetups.com`)
- **CloudFront custom domain** — Frontend served at `awsvirtualmeetups.com` and `www.`
- **API Gateway custom domain** — HTTP API at `api.awsvirtualmeetups.com`
- **WebSocket custom domain** — WebSocket API at `ws.awsvirtualmeetups.com`
- **DNS validation** — Automatic CNAME record creation for certificate validation
- **A record aliases** — Route53 alias records pointing to CloudFront and API Gateway

## Authentication

- **Cognito User Pool** — Email-based sign-up with verification
- **SRP authentication** — Secure Remote Password protocol (no client secret)
- **Email verification** — Required before account activation
- **Custom role attribute** — `custom:role` (organizer or member)
- **Role-based access** — Organizers can create/manage events; members can attend
- **API Gateway authorizer** — Cognito User Pool authorizer on protected HTTP routes
- **WebSocket auth** — Token passed via query string on `$connect`
- **Advanced security** — Audit mode for compromised credential detection
- **Account lockout** — 5 failed attempts triggers 15-minute temporary lock
- **Identity Pool** — Federated identity for AWS service access

## Observability

- **CloudWatch dashboard** — Single pane of glass with API latency, errors, Lambda duration, DynamoDB capacity, WebSocket connections, and engagement metrics
- **CloudWatch alarms** — API error rate, Lambda errors, DynamoDB throttling, WebSocket failures, high Lambda duration
- **SNS notifications** — Alarm actions send to email subscribers
- **Structured logging** — JSON-formatted logs with correlation IDs, action names, and context
- **Log retention** — 30-day retention on all Lambda log groups
- **Saved queries** — CloudWatch Logs Insights queries for errors, slow invocations, disconnections, failed auth
- **IVS metrics** — EventBridge rule captures stage participant events for custom metrics
- **Engagement metrics** — Custom CloudWatch metrics for chat messages, questions submitted, attendee count

## Security

- **WAF (CloudFront)** — CLOUDFRONT-scoped WebACL protecting the frontend distribution
- **WAF (API)** — REGIONAL-scoped WebACL for API Gateway protection
- **Rate limiting** — 100 req/min unauthenticated, 500 req/min authenticated (per IP)
- **AWS Managed Rules** — Common Rule Set, SQL Injection, Known Bad Inputs
- **Size restriction** — 4KB max body for WebSocket/chat payloads
- **CORS** — Strict origin allowlist (`awsvirtualmeetups.com` only)
- **Input validation** — Server-side validation on all Lambda handlers
- **Ban system** — User-level bans stored in DynamoDB, enforced on connect and token generation
- **S3 block public access** — All buckets use BlockPublicAccess.BLOCK_ALL
- **Origin Access Identity** — CloudFront accesses S3 via OAI (no direct S3 access)
- **SES DKIM** — Domain-level email authentication to prevent spoofing
- **Cognito advanced security** — Compromised credential blocking, adaptive authentication
- **HTTP 429 responses** — Custom WAF response body for rate-limited requests
