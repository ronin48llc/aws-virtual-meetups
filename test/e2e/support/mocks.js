'use strict';

/**
 * Network mocking for the mocked-local E2E layer.
 *
 * installMocks() intercepts everything the static frontend would otherwise
 * reach over the network, so specs are deterministic and offline:
 *   1. js/config.js          -> test runtime config (localhost API/WS URLs)
 *   2. external SDK CDNs      -> empty stubs (IVS broadcast, HLS.js, Cognito)
 *   3. REST API              -> in-memory event store (list + detail + writes)
 *
 * WebSocket interception is set up per-spec with page.routeWebSocket() where a
 * test needs to drive real-time messages (see live-attendee.spec.js).
 */

const API_BASE = 'https://api.test.local';
const WS_BASE = 'wss://ws.test.local';

// Replaces frontend/js/config.js. The real file ships prod URLs; we point the
// app at hosts our route handlers own, and at a throwaway Cognito config (the
// core specs drive auth state by seeding localStorage, not via Cognito).
const TEST_CONFIG_JS = `
'use strict';
window.COGNITO_USER_POOL_ID = 'us-east-1_TESTPOOL';
window.COGNITO_CLIENT_ID = 'testclientid';
window.API_BASE_URL = '${API_BASE}';
window.WS_BASE_URL = '${WS_BASE}';
`;

const b64encode = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const b64decode = (s) => Buffer.from(String(s), 'base64').toString('utf8');

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} opts
 * @param {Array<object>} [opts.events]   events returned by GET /events (paginated)
 * @param {number} [opts.pageSize]        page size for the cursor pagination
 * @param {Record<string, object>} [opts.byId] events returned by GET /events/:id
 */
async function installMocks(page, opts = {}) {
  const { events = [], pageSize = 3, byId = {} } = opts;

  // 1. Runtime config.
  await page.route('**/js/config.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: TEST_CONFIG_JS })
  );

  // 2. External SDK CDNs -> harmless empty scripts (kept off the network so the
  //    suite is deterministic; the doubles in sdkDoubles.js stand in instead).
  for (const cdn of [
    'https://web-broadcast.live-video.net/**',
    'https://cdn.jsdelivr.net/**',
    'https://unpkg.com/**',
  ]) {
    await page.route(cdn, (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '/* stubbed in e2e */' })
    );
  }

  // 3. REST API.
  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    // GET /events — cursor pagination over the in-memory list.
    if (method === 'GET' && pathname === '/events') {
      const cursor = url.searchParams.get('cursor');
      const offset = cursor ? Number(b64decode(cursor)) : 0;
      const slice = events.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      const nextCursor = nextOffset < events.length ? b64encode(String(nextOffset)) : undefined;
      return route.fulfill({ json: { events: slice, nextCursor } });
    }

    // GET /events/:id — single event detail.
    const detail = pathname.match(/^\/events\/([^/]+)$/);
    if (method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]);
      const evt = byId[id] || events.find((e) => e.eventId === id);
      return evt
        ? route.fulfill({ json: evt })
        : route.fulfill({ status: 404, json: { message: 'Event not found' } });
    }

    // POST writes (signup, join, ...) — acknowledge with a generic success.
    if (method === 'POST') {
      return route.fulfill({ json: { success: true, role: 'attendee', status: 'live' } });
    }

    return route.fulfill({ status: 200, json: {} });
  });
}

module.exports = { installMocks, API_BASE, WS_BASE };
