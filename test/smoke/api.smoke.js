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

  // GET /health - dependency-checking probe; 503 means the Lambda cannot
  // reach DynamoDB even though API Gateway is up.
  try {
    await withRetry(async () => {
      const res = await fetch(`${config.apiUrl}/health`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const data = await res.json();
      if (data.status !== 'ok') throw new Error(`Expected status ok, got ${data.status}`);
    }, config, 'GET /health');
    pass('GET /health returns 200 with status ok');
  } catch (err) {
    fail('GET /health returns 200 with status ok', err);
  }

  // GET /events - public, no auth required. The endpoint returns a paginated
  // object { events: [...] }, not a bare array — accept either shape (matches
  // how the frontend and live-e2e read it).
  try {
    await withRetry(async () => {
      const res = await fetch(`${config.apiUrl}/events`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data && data.events;
      if (!Array.isArray(list)) throw new Error('Expected an events array (bare or under .events)');
    }, config, 'GET /events');
    pass('GET /events returns 200 with an events array');
  } catch (err) {
    fail('GET /events returns 200 with an events array', err);
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
