'use strict';

/**
 * End-to-End Event Lifecycle Smoke Test
 * Validates the full happy path: create → list → signup → start → join → stop → verify ended → cleanup.
 */
async function run(config, { pass, fail, skip, withRetry }) {
  if (!config.apiUrl) {
    skip('E2E lifecycle test', 'apiUrl not configured');
    return;
  }

  const token = await getAuthToken(config);
  if (!token) {
    skip('E2E lifecycle test', 'Could not obtain auth token');
    return;
  }

  let eventId;

  try {
    // 1. Create event
    const createRes = await fetch(`${config.apiUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: 'E2E Smoke Test Event',
        description: 'End-to-end lifecycle smoke test',
        startTime: new Date(Date.now() + 60000).toISOString(),
      }),
    });

    if (!createRes.ok) throw new Error(`Create event failed: ${createRes.status}`);
    const created = await createRes.json();
    eventId = created.eventId || created.id;
    pass('E2E: Create event');

    // 2. Verify in listing
    await withRetry(async () => {
      const listRes = await fetch(`${config.apiUrl}/events`);
      const events = await listRes.json();
      const found = events.find(e => (e.eventId || e.id) === eventId);
      if (!found) throw new Error('Event not found in listing');
    }, config, 'E2E: Verify in listing');
    pass('E2E: Event appears in listing');

    // 3. Sign up
    const signupRes = await fetch(`${config.apiUrl}/events/${eventId}/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: 'Smoke Test User', email: 'smoke@test.com' }),
    });
    if (signupRes.ok || signupRes.status === 201) {
      pass('E2E: Sign up for event');
    } else {
      fail('E2E: Sign up for event', new Error(`Got ${signupRes.status}`));
    }

    // 4. Start event
    const startRes = await fetch(`${config.apiUrl}/events/${eventId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (startRes.ok) {
      pass('E2E: Start event');
    } else {
      fail('E2E: Start event', new Error(`Got ${startRes.status}`));
    }

    // 5. Join event (get tokens)
    const joinRes = await fetch(`${config.apiUrl}/events/${eventId}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (joinRes.ok) {
      const joinData = await joinRes.json();
      if (joinData.participantToken || joinData.token || joinData.chatToken) {
        pass('E2E: Join event returns tokens');
      } else {
        pass('E2E: Join event succeeds');
      }
    } else {
      fail('E2E: Join event', new Error(`Got ${joinRes.status}`));
    }

    // 6. Stop event
    const stopRes = await fetch(`${config.apiUrl}/events/${eventId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (stopRes.ok) {
      pass('E2E: Stop event');
    } else {
      fail('E2E: Stop event', new Error(`Got ${stopRes.status}`));
    }

    // 7. Verify status is "ended"
    await withRetry(async () => {
      const getRes = await fetch(`${config.apiUrl}/events/${eventId}`);
      const event = await getRes.json();
      if (event.status !== 'ended') throw new Error(`Expected status "ended", got "${event.status}"`);
    }, config, 'E2E: Verify ended');
    pass('E2E: Event status is "ended"');

  } catch (err) {
    fail('E2E lifecycle test', err);
  } finally {
    // Cleanup
    if (eventId) {
      try {
        await fetch(`${config.apiUrl}/events/${eventId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        // Best effort cleanup
      }
    }
  }
}

async function getAuthToken(config) {
  if (!config.cognitoClientId) return null;
  try {
    const res = await fetch(`https://cognito-idp.us-east-1.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: config.cognitoClientId,
        AuthParameters: {
          USERNAME: config.testUsername,
          PASSWORD: config.testPassword,
        },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.AuthenticationResult && data.AuthenticationResult.IdToken;
    }
  } catch (err) {
    // Auth not available
  }
  return null;
}

module.exports = { run };
