# Requirements Document

## Introduction

Email notifications for the Virtual Meetup Platform. The system sends transactional emails at key points in the event lifecycle: when an event is created, when a user signs up, before the event starts (24-hour and 1-hour reminders), when the event goes live, and after the event ends with a recap including the recording playback link. The implementation uses Amazon SES for email delivery and Amazon EventBridge Scheduler for timed reminders. Additionally, past events with available recordings display a playback section on the event detail page.

## Glossary

- **Email_Service**: The subsystem responsible for composing and sending transactional emails via Amazon SES
- **Scheduler_Service**: The subsystem that creates and manages timed triggers via Amazon EventBridge Scheduler for sending reminder emails
- **Organizer**: An authenticated user with the organizer role who creates and manages events
- **Attendee**: A user who has signed up for an event
- **Event_Detail_Page**: The frontend page that displays event information, accessible at the event URL
- **Playback_URL**: The HLS recording URL for a completed event, stored in the event metadata after publication
- **Platform**: The Virtual Meetup Platform application
- **SES_Sender**: The verified email identity used as the From address for all outgoing emails (phannah@thenetwerk.net)

## Requirements

### Requirement 1: Event Scheduled Confirmation Email

**User Story:** As an Organizer, I want to receive a confirmation email when I create an event, so that I have a record of the event details and can verify the event was created successfully.

#### Acceptance Criteria

1. WHEN an Organizer successfully creates an Event, THE Email_Service SHALL send a confirmation email to the Organizer email address within 30 seconds
2. THE Email_Service SHALL include the Event title, description, scheduled start time, and Event URL in the confirmation email body
3. THE Email_Service SHALL use the SES_Sender as the From address for the confirmation email
4. IF the email delivery fails, THEN THE Email_Service SHALL log the failure with the Event ID and Organizer email but SHALL NOT block the Event creation response

### Requirement 2: User Sign-Up Confirmation Email

**User Story:** As an Attendee, I want to receive a confirmation email when I sign up for an event, so that I have a record of my registration and the event details.

#### Acceptance Criteria

1. WHEN a user successfully signs up for an Event, THE Email_Service SHALL send a confirmation email to the Attendee email address within 30 seconds
2. THE Email_Service SHALL include the Event title, scheduled start time, and Event URL in the sign-up confirmation email body
3. THE Email_Service SHALL use the SES_Sender as the From address for the sign-up confirmation email
4. IF the email delivery fails, THEN THE Email_Service SHALL log the failure with the Event ID and Attendee email but SHALL NOT block the sign-up response

### Requirement 3: Day-Before Reminder Email

**User Story:** As an Attendee, I want to receive a reminder email 24 hours before the event starts, so that I can plan my schedule and prepare to attend.

#### Acceptance Criteria

1. THE Scheduler_Service SHALL create a scheduled trigger for 24 hours before the Event scheduled start time when an Event is created
2. WHEN the 24-hour reminder trigger fires, THE Email_Service SHALL send a reminder email to all Attendees registered for the Event
3. THE Email_Service SHALL include the Event title, scheduled start time, and Event URL in the day-before reminder email body
4. IF the Event is deleted or cancelled before the reminder trigger fires, THEN THE Scheduler_Service SHALL remove the scheduled trigger
5. IF no Attendees are registered for the Event at trigger time, THEN THE Email_Service SHALL skip sending and log that no recipients were found

### Requirement 4: Hour-Before Reminder Email

**User Story:** As an Attendee, I want to receive a reminder email 1 hour before the event starts, so that I have a final prompt to join the session.

#### Acceptance Criteria

1. THE Scheduler_Service SHALL create a scheduled trigger for 1 hour before the Event scheduled start time when an Event is created
2. WHEN the 1-hour reminder trigger fires, THE Email_Service SHALL send a reminder email to all Attendees registered for the Event
3. THE Email_Service SHALL include the Event title, scheduled start time, and Event URL in the hour-before reminder email body
4. IF the Event is deleted or cancelled before the reminder trigger fires, THEN THE Scheduler_Service SHALL remove the scheduled trigger
5. IF no Attendees are registered for the Event at trigger time, THEN THE Email_Service SHALL skip sending and log that no recipients were found

### Requirement 5: Event Started Notification Email

**User Story:** As an Attendee, I want to receive an email when the event starts, so that I can join the live session immediately with the correct link.

#### Acceptance Criteria

1. WHEN the Organizer starts an Event, THE Email_Service SHALL send a notification email to all Attendees registered for the Event within 60 seconds
2. THE Email_Service SHALL include the Event title and a direct join link to the live session in the event-started notification email body
3. THE Email_Service SHALL use the SES_Sender as the From address for the event-started notification email
4. IF the email delivery fails for one or more recipients, THEN THE Email_Service SHALL log each failure but SHALL NOT block the Event start operation

### Requirement 6: Recap Email After Event Ends

**User Story:** As an Attendee, I want to receive a recap email after the event ends with a link to the recording, so that I can rewatch the session or catch up if I missed part of it.

#### Acceptance Criteria

1. WHEN a Recording becomes available for a completed Event, THE Email_Service SHALL send a recap email to all Attendees registered for the Event
2. THE Email_Service SHALL include the Event title, a playback link to the recording on the Event_Detail_Page, and a summary of event duration in the recap email body
3. THE Email_Service SHALL mention the availability of captions, transcript, download, and screenshot features in the recap email body
4. THE Email_Service SHALL use the SES_Sender as the From address for the recap email
5. IF the email delivery fails for one or more recipients, THEN THE Email_Service SHALL log each failure but SHALL NOT affect the recording publication process
6. IF no recording is available within 48 hours of Event end, THEN THE Email_Service SHALL NOT send a recap email

### Requirement 7: Event Detail Page Playback Display

**User Story:** As a community member, I want to see a video player with the recording on the event detail page after an event ends, so that I can watch the recording without navigating to a separate site.

#### Acceptance Criteria

1. WHEN an Event has a Playback_URL stored in its metadata, THE Event_Detail_Page SHALL display an embedded video player with the recording
2. WHILE an Event does not have a Playback_URL, THE Event_Detail_Page SHALL NOT display the video player section
3. THE Event_Detail_Page SHALL display the recording playback using an HLS-compatible player (hls.js)
4. THE Event_Detail_Page SHALL display the Event title, description, and scheduled start time alongside the video player
5. THE Event_Detail_Page SHALL provide a download button that allows users to download the recording file
6. THE Event_Detail_Page SHALL support deep linking to a specific timestamp in the recording via a URL parameter (e.g., ?t=120 for 2 minutes)
7. THE Event_Detail_Page SHALL provide a screenshot button that captures the current video frame and downloads it as a PNG image
8. THE Event_Detail_Page SHALL display synchronized captions from the WebVTT caption file during playback
9. THE Event_Detail_Page SHALL provide a language selector for captions and transcripts, allowing users to choose from available translated languages
10. THE Event_Detail_Page SHALL display a full transcript panel alongside the video player with clickable timestamps that seek the video to the corresponding position

### Requirement 8: Scheduler Lifecycle Management

**User Story:** As a platform operator, I want reminder schedules to be properly managed when events are updated or deleted, so that stale or incorrect reminders are never sent.

#### Acceptance Criteria

1. WHEN an Organizer updates the scheduled start time of an Event, THE Scheduler_Service SHALL delete the existing reminder triggers and create new triggers based on the updated start time
2. WHEN an Organizer deletes an Event, THE Scheduler_Service SHALL delete all associated reminder triggers for that Event
3. IF a reminder trigger fires for an Event that no longer exists, THEN THE Email_Service SHALL skip sending and log the orphaned trigger
4. THE Scheduler_Service SHALL NOT create reminder triggers for times that have already passed (e.g., if an event is created less than 24 hours from start, only the applicable reminders are scheduled)

### Requirement 9: Email Content and Formatting

**User Story:** As a recipient, I want notification emails to be well-formatted and clearly branded, so that I can quickly identify them and find the relevant information.

#### Acceptance Criteria

1. THE Email_Service SHALL send emails in HTML format with a plain-text fallback
2. THE Email_Service SHALL include the platform name "Virtual Meetup Platform" in the email subject line prefix
3. THE Email_Service SHALL include an unsubscribe instruction in the email footer (manual process via platform contact)
4. THE Email_Service SHALL format dates and times in a human-readable format including the timezone
