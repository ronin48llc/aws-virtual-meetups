'use strict';

const { test, expect } = require('@playwright/test');
const { installMocks } = require('../support/mocks');
const { seedAuth } = require('../support/auth');

// The "Manage Events" nav entry is organizer-gated by updateAuthUI(), which
// toggles the link's parent <li> based on the decoded custom:role claim.
test.describe('Organizer gating of Manage Events', () => {
  const manageLink = '[data-route="/manage"]';

  test('an organizer sees the Manage Events nav link', async ({ page }) => {
    await installMocks(page, { events: [] });
    await seedAuth(page, { role: 'organizer' });
    await page.goto('/');
    await expect(page.locator(manageLink)).toBeVisible();
  });

  test('an attendee does not see the Manage Events nav link', async ({ page }) => {
    await installMocks(page, { events: [] });
    await seedAuth(page, { role: 'attendee' });
    await page.goto('/');
    await expect(page.locator(manageLink)).toBeHidden();
  });

  test('an anonymous visitor does not see the Manage Events nav link', async ({ page }) => {
    await installMocks(page, { events: [] });
    await page.goto('/');
    await expect(page.locator(manageLink)).toBeHidden();
  });
});
