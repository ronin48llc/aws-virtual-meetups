'use strict';

const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const firefox = require('selenium-webdriver/firefox');

/**
 * Build a WebDriver for one browser.
 *  - With a remote URL (Selenium Grid or BrowserStack/Sauce), drive that hub.
 *  - Without one, run locally in headless mode (Chrome/Firefox only); Selenium
 *    Manager downloads the matching driver on demand.
 *
 * @param {{name:string, browserName:string}} browser
 * @param {{remoteUrl?: string}} [opts]
 * @returns {Promise<import('selenium-webdriver').WebDriver>}
 */
async function buildDriver(browser, opts = {}) {
  const { remoteUrl } = opts;
  const builder = new Builder().forBrowser(browser.browserName);

  if (remoteUrl) {
    builder.usingServer(remoteUrl);
    return builder.build();
  }

  // Local headless mode.
  if (browser.browserName === 'chrome') {
    builder.setChromeOptions(
      new chrome.Options().addArguments(
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1280,900'
      )
    );
  } else if (browser.browserName === 'firefox') {
    builder.setFirefoxOptions(new firefox.Options().addArguments('-headless'));
  }
  return builder.build();
}

module.exports = { buildDriver };
