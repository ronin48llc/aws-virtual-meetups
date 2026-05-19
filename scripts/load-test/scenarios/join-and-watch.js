'use strict';

/**
 * Scenario: Join and Watch
 * Simulates a passive attendee who joins, subscribes to the stream, idles, then disconnects.
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

  // Join event (get participant token)
  await user.httpRequest('POST', `/events/${eventId}/join`);

  // Idle for hold period (simulating watching)
  const holdMs = (config.holdSeconds || 30) * 1000;
  const jitter = Math.random() * 5000;
  await user.sleep(holdMs + jitter);

  // Disconnect
  await user.disconnect();
}

module.exports = { execute };
