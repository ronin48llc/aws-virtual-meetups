# Requirements Document

## Introduction

Event Duration management for the Virtual Meetup Platform. This feature allows organizers to specify a scheduled end time or a duration when creating or updating an event. The system computes the derived value (end time from duration or vice versa), enforces validation rules, schedules an auto-stop when the end time is reached, displays a countdown of remaining time during live sessions, and handles edge cases such as manual early stop and time extensions. The implementation integrates with the existing event-crud Lambda, session-manager Lambda, EventBridge Scheduler, WebSocket broadcast, and email notification system.

## Glossary

- **Event_CRUD**: The Lambda function responsible for creating, reading, updating, and deleting event records in DynamoDB
- **Session_Manager**: The Lambda function responsible for starting and stopping live event sessions (IVS Real-Time Stage and Chat Room lifecycle)
- **Auto_Stop_Scheduler**: The subsystem that creates a one-time EventBridge Scheduler trigger to invoke the Session_Manager stop operation when the scheduled end time is reached
- **Organizer**: An authenticated user with the organizer role who creates and manages events
- **Attendee**: A user who has signed up for an event
- **Scheduled_End_Time**: The ISO 8601 timestamp at which the event is expected to end, either directly specified or computed from start time plus duration
- **Duration**: A positive integer representing the event length in minutes
- **Countdown_Service**: The subsystem that computes and broadcasts remaining time information to connected clients via WebSocket
- **Platform**: The Virtual Meetup Platform application

## Requirements

### Requirement 1: Specify End Time or Duration at Event Creation

**User Story:** As an Organizer, I want to specify either a scheduled end time or a duration when creating an event, so that the platform knows when the event should conclude.

#### Acceptance Criteria

1. WHEN an Organizer creates an Event with a scheduledEnd field, THE Event_CRUD SHALL store the scheduledEnd value and compute the duration in minutes from the difference between scheduledEnd and scheduledStart
2. WHEN an Organizer creates an Event with a durationMinutes field, THE Event_CRUD SHALL compute the scheduledEnd by adding durationMinutes to the scheduledStart and store both values
3. WHEN an Organizer creates an Event with both scheduledEnd and durationMinutes fields, THE Event_CRUD SHALL reject the request with a validation error indicating that only one may be provided
4. WHEN an Organizer creates an Event without scheduledEnd and without durationMinutes, THE Event_CRUD SHALL accept the request and store the event without duration constraints (open-ended event)
5. THE Event_CRUD SHALL return both scheduledEnd and durationMinutes in the event creation response when either is provided

### Requirement 2: End Time and Duration Validation

**User Story:** As an Organizer, I want the system to validate my end time and duration inputs, so that I cannot create events with illogical time boundaries.

#### Acceptance Criteria

1. WHEN an Organizer provides a scheduledEnd value, THE Event_CRUD SHALL validate that scheduledEnd is a valid ISO 8601 date
2. WHEN an Organizer provides a scheduledEnd value, THE Event_CRUD SHALL validate that scheduledEnd is after scheduledStart
3. WHEN an Organizer provides a durationMinutes value, THE Event_CRUD SHALL validate that durationMinutes is a positive integer greater than zero
4. WHEN an Organizer provides a durationMinutes value, THE Event_CRUD SHALL validate that durationMinutes does not exceed 480 (8 hours)
5. IF scheduledEnd is not after scheduledStart, THEN THE Event_CRUD SHALL return a 400 error with the message "scheduledEnd must be after scheduledStart"
6. IF durationMinutes is not a positive integer or exceeds 480, THEN THE Event_CRUD SHALL return a 400 error with a descriptive message

### Requirement 3: Update End Time or Duration

**User Story:** As an Organizer, I want to update the end time or duration of a scheduled event, so that I can adjust the event length before it starts.

#### Acceptance Criteria

1. WHEN an Organizer updates an Event with a new scheduledEnd value, THE Event_CRUD SHALL recompute durationMinutes and store both updated values
2. WHEN an Organizer updates an Event with a new durationMinutes value, THE Event_CRUD SHALL recompute scheduledEnd and store both updated values
3. WHEN an Organizer updates scheduledStart on an Event that has a durationMinutes value, THE Event_CRUD SHALL recompute scheduledEnd based on the new scheduledStart and existing durationMinutes
4. WHILE an Event is in "live" status, THE Event_CRUD SHALL reject updates to scheduledEnd and durationMinutes with a 400 error indicating that extensions must use the dedicated extend endpoint
5. THE Event_CRUD SHALL apply the same validation rules for updated scheduledEnd and durationMinutes as for creation

### Requirement 4: Auto-Stop Scheduling

**User Story:** As an Organizer, I want the event to automatically stop when the scheduled end time is reached, so that events do not run indefinitely and consume resources.

#### Acceptance Criteria

1. WHEN the Session_Manager starts an Event that has a scheduledEnd value, THE Auto_Stop_Scheduler SHALL create a one-time EventBridge Scheduler trigger set to fire at the scheduledEnd time
2. WHEN the auto-stop trigger fires, THE Auto_Stop_Scheduler SHALL invoke the Session_Manager stop operation for the corresponding Event
3. IF the Event has already been stopped manually before the auto-stop trigger fires, THEN THE Auto_Stop_Scheduler SHALL detect the non-live status and skip the stop operation
4. WHEN the auto-stop trigger completes, THE Auto_Stop_Scheduler SHALL delete itself (ActionAfterCompletion: DELETE)
5. WHEN an Organizer starts an Event without a scheduledEnd value, THE Auto_Stop_Scheduler SHALL NOT create an auto-stop trigger (open-ended event)

### Requirement 5: Manual Stop Before End Time

**User Story:** As an Organizer, I want to manually stop an event before the scheduled end time, so that I can end the session early if the content is complete.

#### Acceptance Criteria

1. WHEN an Organizer manually stops a live Event that has an auto-stop schedule, THE Session_Manager SHALL stop the Event and THE Auto_Stop_Scheduler SHALL delete the pending auto-stop trigger
2. THE Session_Manager SHALL record the actual end time (endedAt) regardless of whether the stop was manual or automatic
3. WHEN the Event is stopped manually, THE Session_Manager SHALL broadcast an EVENT_ENDED message to all connected clients with the actual end time

### Requirement 6: Extend Event Duration

**User Story:** As an Organizer, I want to extend the duration of a live event, so that I can continue the session if the discussion is still active.

#### Acceptance Criteria

1. WHEN an Organizer sends an extend request with an additionalMinutes value for a live Event, THE Session_Manager SHALL add additionalMinutes to the current scheduledEnd and update the stored scheduledEnd and durationMinutes
2. THE Session_Manager SHALL validate that additionalMinutes is a positive integer and that the new total duration does not exceed 480 minutes
3. WHEN the scheduledEnd is extended, THE Auto_Stop_Scheduler SHALL delete the existing auto-stop trigger and create a new trigger at the updated scheduledEnd time
4. WHEN the scheduledEnd is extended, THE Session_Manager SHALL broadcast a DURATION_EXTENDED message to all connected clients with the new scheduledEnd and remaining time
5. IF the Event is not in "live" status, THEN THE Session_Manager SHALL reject the extend request with a 400 error

### Requirement 7: Remaining Time Countdown Display

**User Story:** As an Attendee, I want to see a countdown of remaining time during a live event, so that I know how much time is left in the session.

#### Acceptance Criteria

1. WHEN a client connects to a live Event that has a scheduledEnd value, THE Platform SHALL include the scheduledEnd in the session state so the client can compute remaining time locally
2. THE Platform SHALL include scheduledEnd and durationMinutes in the GET /events/{id} response when the Event is in "live" status and has duration constraints
3. WHEN the remaining time reaches 5 minutes, THE Countdown_Service SHALL broadcast a TIME_WARNING message to all connected clients with the remaining seconds
4. WHEN the remaining time reaches 1 minute, THE Countdown_Service SHALL broadcast a FINAL_WARNING message to all connected clients
5. WHILE an Event is live and has no scheduledEnd, THE Platform SHALL NOT display a countdown (open-ended event)

### Requirement 8: Auto-Stop Scheduler Lifecycle Management

**User Story:** As a platform operator, I want auto-stop schedules to be properly managed when events are updated or deleted, so that stale triggers do not fire for cancelled or modified events.

#### Acceptance Criteria

1. WHEN an Organizer deletes a scheduled Event that has an auto-stop trigger, THE Auto_Stop_Scheduler SHALL delete the auto-stop trigger
2. WHEN an Organizer updates the scheduledEnd of a scheduled Event, THE Auto_Stop_Scheduler SHALL delete the existing auto-stop trigger and create a new one at the updated scheduledEnd
3. IF an auto-stop trigger fires for an Event that is no longer in "live" status, THEN THE Auto_Stop_Scheduler SHALL log the stale trigger and take no action
4. THE Auto_Stop_Scheduler SHALL use a distinct schedule name pattern (e.g., "{eventId}-auto-stop") to avoid conflicts with reminder schedules

### Requirement 9: Email Notification Integration with Duration

**User Story:** As an Attendee, I want reminder and notification emails to include the event duration information, so that I can plan my time accordingly.

#### Acceptance Criteria

1. WHEN the Email_Service sends an event-created confirmation email for an Event with duration constraints, THE Email_Service SHALL include the scheduled end time and duration in the email body
2. WHEN the Email_Service sends reminder emails (24-hour and 1-hour) for an Event with duration constraints, THE Email_Service SHALL include the expected duration in the email body
3. WHEN the Email_Service sends an event-started notification for an Event with duration constraints, THE Email_Service SHALL include the expected end time in the email body
4. WHEN the Email_Service sends a recap email, THE Email_Service SHALL include the actual event duration (difference between startedAt and endedAt) in the email body

### Requirement 10: Event Listing and Detail Display with Duration

**User Story:** As a community member, I want to see the expected duration of upcoming events, so that I can decide which events fit my schedule.

#### Acceptance Criteria

1. WHEN listing upcoming Events, THE Event_CRUD SHALL include scheduledEnd and durationMinutes in the response for Events that have duration constraints
2. WHEN retrieving a single Event, THE Event_CRUD SHALL include scheduledEnd and durationMinutes in the response when present
3. WHILE an Event is in "live" status and has a scheduledEnd, THE Event_CRUD SHALL include a computed remainingSeconds field in the GET response
