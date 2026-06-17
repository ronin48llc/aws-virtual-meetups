'use strict';

const { until, By } = require('selenium-webdriver');

/**
 * Critical happy path: the events listing section mounts (the API call to the
 * real backend resolves and the upcoming-events container is present).
 */
module.exports = async function eventList(driver, { baseUrl }) {
  await driver.get(baseUrl.replace(/\/$/, '') + '/#/');
  await driver.wait(until.elementLocated(By.id('events-list')), 15000);
};
