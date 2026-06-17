'use strict';

const { test, expect } = require('@playwright/test');
const { installMocks } = require('../support/mocks');
const { seedAuth } = require('../support/auth');
const { scheduledEvent } = require('../fixtures/events');

test.describe('Event detail + registration', () => {
  test('an anonymous visitor is prompted to sign in to register', async ({ page }) => {
    await installMocks(page, { byId: { [scheduledEvent.eventId]: scheduledEvent } });
    await page.goto('/#/events/' + scheduledEvent.eventId);

    await expect(page.locator('#event-detail-card h1')).toHaveText(scheduledEvent.title);
    await expect(page.getByRole('button', { name: 'Sign In to Register' })).toBeVisible();
  });

  test('an authenticated attendee can register and sees a confirmation', async ({ page }) => {
    await installMocks(page, { byId: { [scheduledEvent.eventId]: scheduledEvent } });
    await seedAuth(page, { role: 'attendee', email: 'attendee@example.com' });
    await page.goto('/#/events/' + scheduledEvent.eventId);

    const register = page.getByRole('button', { name: 'Register for this Event' });
    await expect(register).toBeVisible();
    await register.click();

    await expect(page.locator('#signup-message')).toContainText('Registered');
  });
});
