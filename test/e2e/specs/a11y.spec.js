'use strict';

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installMocks } = require('../support/mocks');
const { homeEvents, scheduledEvent } = require('../fixtures/events');

/**
 * Layer 3 — accessibility. Gates on both `serious` and `critical` WCAG 2 A/AA
 * violations (the prior `color-contrast` serious issues were fixed in the
 * frontend, so the bar is now zero of either).
 */
async function violations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact})`);
}

test.describe('Accessibility', () => {
  test('home page has no serious/critical a11y violations', async ({ page }) => {
    await installMocks(page, { events: homeEvents });
    await page.goto('/');
    await page.locator('#events-list .card').first().waitFor();
    expect(await violations(page)).toEqual([]);
  });

  test('event detail page has no serious/critical a11y violations', async ({ page }) => {
    await installMocks(page, { byId: { [scheduledEvent.eventId]: scheduledEvent } });
    await page.goto('/#/events/' + scheduledEvent.eventId);
    await page.locator('#event-detail-card h1').waitFor();
    expect(await violations(page)).toEqual([]);
  });
});
