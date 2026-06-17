'use strict';

const { test, expect } = require('@playwright/test');
const { installMocks, WS_BASE } = require('../support/mocks');
const { seedAuth } = require('../support/auth');
const { installSdkDoubles } = require('../support/sdkDoubles');
const { liveEvent } = require('../fixtures/events');

/**
 * Proves the heaviest path is testable end-to-end without real services: an
 * authenticated attendee opens a live session with IVS/HLS/Chat doubles in
 * place and the signaling WebSocket intercepted. We assert the live scaffold
 * renders; richer flows (raise hand, Q&A, scripted server messages) extend this
 * same harness via the routeWebSocket handler below.
 */
test.describe('Live session (attendee)', () => {
  test('renders the live session scaffold with mocked media + signaling', async ({ page }) => {
    await installSdkDoubles(page);
    await installMocks(page, { byId: { [liveEvent.eventId]: liveEvent } });
    await seedAuth(page, { role: 'attendee', email: 'attendee@example.com' });

    // Intercept the signaling socket so no real connection is attempted. The
    // handler is where scripted server->client messages would be pushed.
    await page.routeWebSocket(`${WS_BASE}/**`, () => { /* accept and hold open */ });

    await page.goto('/#/events/' + liveEvent.eventId + '/live');

    await expect(page.locator('#live-session-container')).toBeVisible({ timeout: 10_000 });
  });
});
