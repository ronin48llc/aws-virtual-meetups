'use strict';

/**
 * Scenario: Presenter
 * Simulates a presenter who starts an event, publishes, manages participants, then stops.
 * Records operation latencies and errors.
 */
async function execute(user, config) {
  // Authenticate
  await user.authenticate();

  // Create a test event
  const event = await user.httpRequest('POST', '/events', {
    title: `Load Test Event ${user.userId}`,
    description: 'Automated load test event',
    startTime: new Date(Date.now() + 60000).toISOString(),
  });

  const eventId = event.eventId || event.id;

  // Connect WebSocket
  await user.connectWebSocket(eventId);

  // Start event (creates IVS stage)
  await user.httpRequest('POST', `/events/${eventId}/start`);

  // Simulate managing participants
  await user.sleep(5000);

  // Lower hands (management action)
  await user.sendAction('lowerAllHands', { eventId });
  await user.sleep(3000);

  // Answer a question
  await user.sendAction('answerQuestion', {
    eventId,
    questionId: 'load-test-q',
    answer: 'This is a load test answer',
  });

  // Hold for duration
  await user.sleep((config.holdSeconds || 30) * 1000 * 0.3);

  // Stop event
  await user.httpRequest('POST', `/events/${eventId}/stop`);

  // Disconnect
  await user.disconnect();

  // Cleanup - delete test event
  try {
    await user.httpRequest('DELETE', `/events/${eventId}`);
  } catch (err) {
    // Best effort cleanup
  }
}

module.exports = { execute };
