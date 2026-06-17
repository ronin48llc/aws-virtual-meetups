'use strict';

const { test, expect } = require('@playwright/test');
const { installMocks } = require('../support/mocks');
const { homeEvents } = require('../fixtures/events');

test.describe('Home / event listing', () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page, { events: homeEvents, pageSize: 3 });
  });

  test('renders the hero and fills the live / upcoming / past sections', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'AWS Virtual Meetups', level: 1 })
    ).toBeVisible();

    await expect(page.locator('#events-live')).toContainText('Live Keynote');
    await expect(page.locator('#events-list .card').first()).toBeVisible();
  });

  test('search filters the upcoming list down to matches', async ({ page }) => {
    await page.goto('/');
    // Wait for the upcoming list to populate (2 scheduled cards on page 1).
    await expect(page.locator('#events-list .card__title').first()).toBeVisible();

    await page.fill('#event-search', 'lambda');

    const visibleTitles = page.locator('#events-list .card:visible .card__title');
    await expect(visibleTitles).toHaveText([/Lambda/i]);
  });

  test('"Load more" fetches the next page and then disappears', async ({ page }) => {
    await page.goto('/');
    const loadMore = page.locator('#events-load-more');
    await expect(loadMore).toBeVisible();

    await loadMore.click();

    await expect(page.locator('#events-load-more')).toHaveCount(0);
    // The previously-hidden past event is now rendered.
    await expect(page.locator('#events-past')).toContainText('Past Summit');
  });
});
