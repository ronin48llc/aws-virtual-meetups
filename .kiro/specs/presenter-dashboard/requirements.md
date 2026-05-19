# Requirements Document

## Introduction

The Presenter Dashboard feature enhances the Virtual Meetup Platform with four capabilities: automatic event registration when attendees join a live session, a real-time attendee list visible to the presenter, a persistent question queue with management controls, and a raised hands panel with acknowledge/dismiss actions. These features streamline the presenter's workflow during live events and remove friction from the attendee join flow.

## Glossary

- **Platform**: The virtual meetup web application that orchestrates events, streaming, and user interactions
- **Presenter**: An authenticated user who hosts a meetup session with streaming and moderation privileges
- **Attendee**: An authenticated user who joins a meetup session to watch, listen, and interact
- **Token_Generator**: The Lambda function handling POST /events/{id}/join that generates IVS stage and chat tokens
- **Signup_Service**: The Lambda function handling POST /events/{id}/signup that registers users for events
- **WebSocket_Service**: The WebSocket API and associated Lambda handlers managing real-time communication
- **Connections_Table**: The DynamoDB table storing active WebSocket connections with user metadata (connectionId, eventId, userId, role, displayName, email)
- **Events_Table**: The DynamoDB table storing event metadata, sign-ups, questions, and hand-raise records using single-table design
- **Question_Queue**: An ordered list of questions submitted by Attendees, stored in the Events_Table with status tracking (queued, answered, dismissed)
- **Presenter_Dashboard**: The frontend UI panel visible to the Presenter during a live session, displaying attendee list, question queue, and raised hands
- **Auto_Registration**: The process of automatically creating a sign-up record for an Attendee when they join a live event

## Requirements

### Requirement 1: Auto-Registration on Join

**User Story:** As an Attendee, I want to be automatically registered for an event when I join the live session, so that I do not need to explicitly sign up before participating.

#### Acceptance Criteria

1. WHEN an authenticated Attendee calls the join endpoint for a live event, THE Token_Generator SHALL check if a sign-up record exists for that user and event
2. IF no sign-up record exists for the Attendee, THEN THE Token_Generator SHALL create a sign-up record in the Events_Table with the user's userId, email, displayName, and the current timestamp
3. WHEN the Token_Generator creates an auto-registration record, THE Token_Generator SHALL proceed with token generation without returning an error or requiring additional user action
4. IF a sign-up record already exists for the Attendee, THEN THE Token_Generator SHALL skip registration and proceed with token generation
5. IF the auto-registration write fails, THEN THE Token_Generator SHALL log the error and continue with token generation without blocking the join flow

### Requirement 2: Presenter Attendee List

**User Story:** As a Presenter, I want to see a real-time list of currently connected attendees during my session, so that I know who is participating.

#### Acceptance Criteria

1. WHILE a live session is active, THE Presenter_Dashboard SHALL display a list of all currently connected participants showing displayName, email, and role for each entry
2. WHEN a new Attendee connects to the event via WebSocket, THE WebSocket_Service SHALL broadcast an ATTENDEE_JOINED message containing the userId, displayName, email, and role to all connections for that event
3. WHEN an Attendee disconnects from the event via WebSocket, THE WebSocket_Service SHALL broadcast an ATTENDEE_LEFT message containing the userId to all connections for that event
4. WHEN the Presenter opens the Presenter_Dashboard, THE Platform SHALL retrieve the current list of connected attendees from the Connections_Table for the active event
5. THE Presenter_Dashboard SHALL display the total count of connected attendees

### Requirement 3: Presenter Question Queue Panel

**User Story:** As a Presenter, I want to see and manage incoming questions from attendees in a dedicated panel, so that I can address questions in an organized manner during the session.

#### Acceptance Criteria

1. THE Presenter_Dashboard SHALL display all questions with status "queued" in submission-time order, showing the question text, submitter displayName, and submission timestamp for each entry
2. WHEN the Presenter marks a question as answered, THE WebSocket_Service SHALL update the question status to "answered" in the Events_Table and broadcast a QUESTION_ANSWERED message to all connections
3. WHEN the Presenter dismisses a question, THE WebSocket_Service SHALL update the question status to "dismissed" in the Events_Table and broadcast a QUESTION_DISMISSED message to all connections
4. WHEN a new question is submitted by an Attendee, THE Presenter_Dashboard SHALL add the question to the queue in real time without requiring a page refresh
5. WHEN the Presenter refreshes the page during a live session, THE Presenter_Dashboard SHALL reload all questions with status "queued" from the Events_Table and display them in submission order
6. THE Presenter_Dashboard SHALL display a count of pending questions in the queue

### Requirement 4: Presenter Raised Hands Management

**User Story:** As a Presenter, I want to see and manage raised hands from attendees, so that I can call on people in the order they raised their hand.

#### Acceptance Criteria

1. THE Presenter_Dashboard SHALL display a list of attendees with raised hands in the chronological order they were raised, showing displayName and the time the hand was raised
2. WHEN the Presenter acknowledges an Attendee's raised hand, THE WebSocket_Service SHALL remove the hand-raise record from the Events_Table, broadcast a HAND_LOWERED message, and grant speak permission to that Attendee
3. WHEN the Presenter dismisses an Attendee's raised hand without acknowledging, THE WebSocket_Service SHALL remove the hand-raise record from the Events_Table and broadcast a HAND_LOWERED message without granting speak permission
4. WHEN an Attendee raises their hand, THE Presenter_Dashboard SHALL add the entry to the raised hands list in real time
5. WHEN an Attendee lowers their own hand, THE Presenter_Dashboard SHALL remove the entry from the raised hands list in real time
6. THE Presenter_Dashboard SHALL display a count of currently raised hands
