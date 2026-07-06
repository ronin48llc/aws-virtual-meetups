'use strict';

const { API_URL, SITE_URL } = require('./env');

// An Actor wraps one browser context/page and gives each persona the verbs
// it actually performs on the site. UI-facing steps click real elements
// (that's the surface under test); setup/plumbing steps that aren't the
// point of a given assertion use the in-page API via the real ID token, so
// a flaky unrelated widget can't fail a test about something else.

class Actor {
  constructor(page, name) {
    this.page = page;
    this.name = name;
    this._logErrors();
  }

  _logErrors() {
    this.page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${this.name}] page error: ${m.text().slice(0, 200)}`);
    });
    // Auto-accept confirm()/alert() dialogs (End Session, unban, etc.).
    this.page.on('dialog', (d) => d.accept().catch(() => {}));
  }

  async open(path = '/') {
    // NOT networkidle: the live session page keeps a WebSocket + IVS WebRTC
    // stream open, so the network never goes idle and goto would hang until
    // the test timeout. domcontentloaded + an explicit readiness wait per
    // page is both correct and fast.
    await this.page.goto(SITE_URL + '/#' + path, { waitUntil: 'domcontentloaded' });
    // The SPA is hash-routed; wait for the router to render into #app.
    await this.page.waitForFunction(
      () => { const a = document.querySelector('#app'); return a && a.children.length > 0; },
      { timeout: 20000 }
    ).catch(() => { /* some routes render elsewhere; specs assert their own readiness */ });
  }

  // --- Auth ---

  async signIn(email, password) {
    await this.open('/');
    await this.page.waitForFunction(() => typeof Auth !== 'undefined' && Auth.signIn);
    await this.page.evaluate(async ({ e, p }) => { await Auth.signIn(e, p); }, { e: email, p: password });
  }

  async isSignedIn() {
    return this.page.evaluate(() => typeof Auth !== 'undefined' && Auth.isAuthenticated());
  }

  async idToken() {
    return this.page.evaluate(() => Auth.getIdToken());
  }

  // --- Authenticated REST (uses the page's real token) ---

  async api(method, path, body) {
    return this.page.evaluate(async ({ api, m, pth, b }) => {
      const res = await fetch(api + pth, {
        method: m,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + Auth.getIdToken(),
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* non-json */ }
      return { status: res.status, body: json, text };
    }, { api: API_URL, m: method, pth: path, b: body });
  }

  // Public GET (no auth) — used to poll event status as an outsider.
  async publicGet(path) {
    return this.page.evaluate(async ({ api, pth }) => {
      const res = await fetch(api + pth);
      return { status: res.status, body: await res.json().catch(() => null) };
    }, { api: API_URL, pth: path });
  }

  // --- Navigation to persona pages ---

  async goHome() { await this.open('/'); }
  async goToEvent(eventId) { await this.open('/events/' + eventId); }
  async goToLive(eventId) { await this.open('/events/' + eventId + '/live'); }
  async goToManage() { await this.open('/manage'); }
}

module.exports = { Actor };
