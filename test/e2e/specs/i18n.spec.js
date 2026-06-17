'use strict';

const { test, expect } = require('@playwright/test');
const { installMocks } = require('../support/mocks');

// Confirms the i18n module loads and switches locale inside the real browser
// runtime (window.I18n), complementing the Layer 1 unit coverage.
test.describe('i18n in the browser', () => {
  test('I18n switches translations at runtime', async ({ page }) => {
    await installMocks(page, { events: [] });
    await page.goto('/');

    const en = await page.evaluate(() => window.I18n.t('buttons.signIn'));
    expect(en).toBe('Sign In');

    const es = await page.evaluate(() => {
      window.I18n.setLocale('es');
      return window.I18n.t('buttons.signIn');
    });
    expect(es).toBe('Iniciar sesión');
  });
});
