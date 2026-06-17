'use strict';

const { test, expect } = require('@playwright/test');
const { installMocks } = require('../support/mocks');

// Drives the auth modal UI only (no real Cognito): opening, field presence, and
// switching between sign-in and sign-up. The full Cognito round-trip is out of
// scope for the mocked-local layer.
test.describe('Auth modal', () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page, { events: [] });
    await page.goto('/');
  });

  test('opens the sign-in form with email + password fields', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.locator('#auth-modal-overlay')).toBeVisible();
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.locator('#auth-password')).toBeVisible();
  });

  test('opens the sign-up form with a display-name field', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign Up' }).click();

    await expect(page.locator('#auth-modal-overlay')).toBeVisible();
    await expect(page.locator('#auth-name')).toBeVisible();
    await expect(page.locator('#auth-password-confirm')).toBeVisible();
  });
});
