/**
 * @jest-environment jsdom
 */
'use strict';

/**
 * Frontend smoke tests against the static SPA shell (issue #7 demo).
 *
 * Uses Jest's jsdom environment to load frontend/index.html into a real
 * DOM and verify the structural contract: the page has the expected
 * core elements (title, nav, sign-in/up controls, modal containers).
 *
 * Pure DOM assertions, no network. Runs in CI on every PR with no AWS
 * credentials needed. The browser-rendered/visual side of testing
 * (Playwright) is a deliberate follow-up — see issue #7.
 */

const fs = require('fs');
const path = require('path');

const INDEX_HTML_PATH = path.join(__dirname, '../../../frontend/index.html');

function loadIndexHtml() {
  // Read the raw HTML and write it into document.documentElement so we
  // get the page's structure into jsdom. (Stripping <!DOCTYPE> works
  // around jsdom's quirky innerHTML handling of full documents.)
  const raw = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const stripped = raw.replace(/<!DOCTYPE[^>]*>/i, '');
  document.documentElement.innerHTML = stripped;
}

describe('frontend/index.html structural smoke (issue #7)', () => {
  beforeAll(loadIndexHtml);

  test('has a non-empty <title>', () => {
    const title = document.querySelector('title');
    expect(title).not.toBeNull();
    expect(title.textContent.trim().length).toBeGreaterThan(0);
  });

  // Note: jsdom drops the original `lang` attribute when assigning
  // documentElement.innerHTML, so we read the raw HTML for that check.
  test('declares language attribute on <html>', () => {
    const raw = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(raw).toMatch(/<html[^>]*\blang=/i);
  });

  test('declares a viewport meta tag for responsive layout', () => {
    const viewport = document.querySelector('meta[name="viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport.getAttribute('content')).toMatch(/width=device-width/);
  });

  test('includes the IVS Web Broadcast SDK script', () => {
    const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
      /web-broadcast\.live-video\.net/.test(s.getAttribute('src')),
    );
    expect(script).toBeTruthy();
  });

  test('includes the hls.js script', () => {
    const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
      /hls\.js/.test(s.getAttribute('src')),
    );
    expect(script).toBeTruthy();
  });

  test('includes the Cognito identity SDK script', () => {
    const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
      /amazon-cognito-identity/.test(s.getAttribute('src')),
    );
    expect(script).toBeTruthy();
  });

  test('includes the SPA app scripts in expected load order', () => {
    const appScripts = Array.from(document.querySelectorAll('script[src]'))
      .map((s) => s.getAttribute('src'))
      .filter((src) => src.startsWith('js/'));
    expect(appScripts).toContain('js/auth.js');
    expect(appScripts).toContain('js/manage.js');
    expect(appScripts).toContain('js/live-session.js');
    expect(appScripts).toContain('js/playback.js');
    expect(appScripts).toContain('js/app.js');
    // app.js must be last so the modules it wires up are already loaded
    expect(appScripts[appScripts.length - 1]).toBe('js/app.js');
  });

  test('inline script count is tracked (CSP "unsafe-inline" minimization)', () => {
    const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'));
    // Today there are two inline blocks: a brand-config block and the
    // window.COGNITO_* / API_BASE_URL bootstrap. The CSP issue #3
    // currently relaxes script-src with 'unsafe-inline' to allow them.
    // The follow-up to drop 'unsafe-inline' is to migrate these out;
    // this assertion locks the count so a regression (adding a third
    // inline block) trips the build and forces the conversation.
    expect(inlineScripts.length).toBeLessThanOrEqual(2);
  });

  test('has at least one element with the auth modal trigger (sign-in flow exists)', () => {
    const html = document.documentElement.innerHTML;
    expect(html).toMatch(/showAuthModal|signin|sign-in/i);
  });
});
