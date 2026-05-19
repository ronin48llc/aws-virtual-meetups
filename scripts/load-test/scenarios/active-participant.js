'use strict';

/**
 * Scenario: Active Participant
 * Simulates an attendee who joins, sends messages, raises hand, submits a question, then disconnects.
 * Records operation latencies and errors.
 */
async function execute(user, config) {
  // Authenticate
  await user.authenticate();

  // Get event list
  const events = await user.httpRequest('GET', '/events');
  if (!events || !events.length) {
    throw new Error('No events available for load test');
  }

  const eventId = events[0].eventId || events[0].id;

  // Connect WebSocket
  await user.connectWebSocket(eventId);

  // Join event
  await user.httpRequest('POST', `/events/${eventId}/join`);

  // Send chat messages
  for (let i = 0; i < 3; i++) {
    await user.sendAction('sendMessage', {
      eventId,
      content: `Load test message ${i + 1} from user ${user.userId}`,
    });
    await user.sleep(2000 + Math.random() * 3000);
  }

  // Raise hand
  await user.sendAction('raiseHand', { eventId });
  await user.sleep(5000 + Math.random() * 5000);

  // Lower hand
  await user.sendAction('lowerHand', { eventId });

  // Submit question
  await user.sendAction('submitQuestion', {
    eventId,
    content: `Load test question from user ${user.userId}?`,
  });

  // Idle
  await user.sleep((config.holdSeconds || 30) * 1000 * 0.5);

  // Disconnect
  await user.disconnect();
}

module.exports = { execute };
