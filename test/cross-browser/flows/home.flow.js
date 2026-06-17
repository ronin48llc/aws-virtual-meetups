'use strict';

const { until, By } = require('selenium-webdriver');

/**
 * Critical happy path: the SPA boots and the hero renders. Uses the same stable
 * selectors as the Layer 2 specs, but against a REAL deployed build — so it
 * exercises real CloudFront delivery, CSP, and SDK loads per browser engine.
 */
module.exports = async function home(driver, { baseUrl }) {
  await driver.get(baseUrl.replace(/\/$/, '') + '/#/');
  const hero = await driver.wait(until.elementLocated(By.css('.hero__title')), 15000);
  await driver.wait(until.elementIsVisible(hero), 15000);
  const text = await hero.getText();
  if (!/AWS Virtual Meetups/i.test(text)) {
    throw new Error(`unexpected hero title: "${text}"`);
  }
};
