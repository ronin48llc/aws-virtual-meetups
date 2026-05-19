'use strict';

/**
 * API Smoke Tests
 * Validates REST API endpoints are responding correctly.
 */
async function run(config, { pass, fail, skip, withRetry }) {
  if (!config.apiUrl) {
    skip('API tests', 'apiUrl not configured');
    return;
  }

  // GET /events - public, no auth required
  try {
    await withRetry(async () => {
      const res = await fetch(`${config.apiUrl}/events`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Expected JSON array');
    }, config, 'GET /events');
    pass('GET /events returns 200 with JSON array');
  } catch (err) {
    fail('GET /events returns 200 with JSON array', err);
  }

  // POST /events without auth - should return 401
  try {
    const res = await fetch(`${config.apiUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke Test', startTime: new Date(Date.now() + 86400000).toISOString() }),
    });
    if (res.status === 401 || res.status === 403) {
      pass('POST /events without auth returns 401/403');
    } else {
      fail('POST /events without auth returns 401/403', new Error(`Got ${res.status}`));
    }
  } catch (err) {
    fail('POST /events without auth returns 401/403', err);
  }

  // POST /events with auth - should return 201
  if (!config.testUsername) {
    skip('POST /events with auth', 'No test credentials configured');
    return;
  }

  try {
    // Attempt authenticated request (requires valid token)
    const token = await getAuthToken(config);
    if (!token) {
      skip('POST /events with auth', 'Could not obtain auth token');
      return;
    }

    const eventData = {
      title: 'Smoke Test Event',
      description: 'Automated smoke test',
      startTime: new Date(Date.now() + 86400000).toISOString(),
    };

    const res = await fetch(`${config.apiUrl}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(eventData),
    });

    if (res.status === 201 || res.status === 200) {
      const created = await res.json();
      pass('POST /events with auth creates event');

      // GET /events/{id}
      const eventId = created.eventId || created.id;
      if (eventId) {
        const getRes = await fetch(`${config.apiUrl}/events/${eventId}`);
        if (getRes.status === 200) {
          pass('GET /events/{id} returns created event');
        } else {
          fail('GET /events/{id} returns created event', new Error(`Got ${getRes.status}`));
        }

        // Cleanup - DELETE
        const delRes = await fetch(`${config.apiUrl}/events/${eventId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (delRes.status === 200 || delRes.status === 204) {
          pass('DELETE /events/{id} removes event');
        } else {
          fail('DELETE /events/{id} removes event', new Error(`Got ${delRes.status}`));
        }
      }
    } else {
      fail('POST /events with auth creates event', new Error(`Got ${res.status}`));
    }
  } catch (err) {
    fail('POST /events with auth creates event', err);
  }
}

async function getAuthToken(config) {
  // Attempt Cognito USER_PASSWORD_AUTH flow
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
