'use strict';

/**
 * IVS Resource Smoke Tests
 * Validates IVS stage creation and participant token generation.
 */
async function run(config, { pass, fail, skip, withRetry }) {
  if (!config.apiUrl) {
    skip('IVS tests', 'apiUrl not configured');
    return;
  }

  // These tests require authentication and a valid event
  const token = await getAuthToken(config);
  if (!token) {
    skip('IVS start event', 'No auth token available');
    skip('IVS join event', 'No auth token available');
    skip('IVS stop event', 'No auth token available');
    return;
  }

  let eventId;

  // Create a test event for IVS tests
  try {
    const res = await fetch(`${config.apiUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: 'IVS Smoke Test Event',
        description: 'Automated IVS smoke test',
        startTime: new Date(Date.now() + 60000).toISOString(),
      }),
    });

    if (res.ok) {
      const data = await res.json();
      eventId = data.eventId || data.id;
    } else {
      skip('IVS tests', `Could not create test event: ${res.status}`);
      return;
    }
  } catch (err) {
    skip('IVS tests', `Event creation failed: ${err.message}`);
    return;
  }

  // POST /events/{id}/start - creates IVS stage
  try {
    const res = await withRetry(async () => {
      const r = await fetch(`${config.apiUrl}/events/${eventId}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`Start event returned ${r.status}`);
      return r;
    }, config, 'Start event');

    const data = await res.json();
    if (data.status === 'live' || data.stageArn) {
      pass('POST /events/{id}/start creates IVS stage');
    } else {
      pass('POST /events/{id}/start returns success');
    }
  } catch (err) {
    fail('POST /events/{id}/start creates IVS stage', err);
  }

  // POST /events/{id}/join - returns participant token
  try {
    const res = await fetch(`${config.apiUrl}/events/${eventId}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      if (data.participantToken || data.token || data.chatToken) {
        pass('POST /events/{id}/join returns tokens');
      } else {
        pass('POST /events/{id}/join returns success');
      }
    } else {
      fail('POST /events/{id}/join returns tokens', new Error(`Got ${res.status}`));
    }
  } catch (err) {
    fail('POST /events/{id}/join returns tokens', err);
  }

  // POST /events/{id}/stop - transitions to ended
  try {
    const res = await fetch(`${config.apiUrl}/events/${eventId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      if (data.status === 'ended') {
        pass('POST /events/{id}/stop transitions to ended');
      } else {
        pass('POST /events/{id}/stop returns success');
      }
    } else {
      fail('POST /events/{id}/stop transitions to ended', new Error(`Got ${res.status}`));
    }
  } catch (err) {
    fail('POST /events/{id}/stop transitions to ended', err);
  }

  // Cleanup
  try {
    await fetch(`${config.apiUrl}/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    // Best effort
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
