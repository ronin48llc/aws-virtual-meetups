'use strict';

/**
 * Full event lifecycle across three personas against the REAL environment.
 *
 * Personas share ONE event as it moves scheduled → staging → live → ended,
 * so the steps are a single serial describe. Each `test` is a phase; within
 * a phase the personas act in the order a real event would unfold.
 *
 *   Presenter  — organizer: schedules, runs the green room, goes live,
 *                publishes A/V, moderates, extends, ends, reviews stats.
 *   Attendee   — signed-in member: discovers, RSVPs, waits, auto-joins,
 *                raises a hand, asks a question, chats, plays the recording.
 *   Anonymous  — no account: browses, watches live as a guest.
 *
 * Requirement mapping lives in ../COVERAGE.md.
 */

const { test, expect, chromium } = require('@playwright/test');
const { Actor } = require('../support/actors');
const { loadPersonas } = require('../support/personas');
const { LIVE_HOLD_MS, RECORDING_WAIT_MS } = require('../support/env');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared across phases.
let browser;
let presenter, attendee, anon;
let personas;
const shared = { eventId: null, recordingUrl: null };

test.describe.configure({ mode: 'serial' });

test.describe('Event lifecycle — presenter / attendee / anonymous', () => {
  test.beforeAll(async () => {
    personas = loadPersonas();
    browser = await chromium.launch();
    // One context per persona = isolated cookies/localStorage, like three
    // real people on three machines.
    presenter = new Actor(await (await browser.newContext()).newPage(), 'presenter');
    attendee = new Actor(await (await browser.newContext()).newPage(), 'attendee');
    anon = new Actor(await (await browser.newContext()).newPage(), 'anonymous');
  });

  test.afterAll(async () => {
    await browser.close();
  });

  // ---------------------------------------------------------------------
  // BEFORE THE EVENT
  // ---------------------------------------------------------------------

  test('presenter schedules an event', async () => {
    await presenter.signIn(personas.presenter.email, personas.presenter.password);
    expect(await presenter.isSignedIn()).toBe(true);

    // Create via the real UI (the create form is the surface under test).
    await presenter.goToManage();
    const p = presenter.page;
    await p.waitForFunction(() => document.querySelector('[data-action="show-create-form"]'));
    await p.click('[data-action="show-create-form"]');
    await p.waitForSelector('#event-title');
    await p.fill('#event-title', 'Live E2E — ' + new Date().toISOString());
    await p.fill('#event-description', 'Automated lifecycle verification.');
    // datetime-local: 2 minutes out so we can exercise the waiting room.
    const start = new Date(Date.now() + 2 * 60 * 1000);
    const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
    await p.fill('#event-start-time', local);
    await p.fill('#event-duration', '30');
    await p.click('#form-submit-btn');

    // The new event should appear in the presenter's Manage list. Grab its
    // id from the API (the list is owner-scoped) to drive later phases.
    await sleep(2000);
    const mine = await presenter.api('GET', '/events');
    expect(mine.status).toBe(200);
    const list = Array.isArray(mine.body) ? mine.body : (mine.body.events || []);
    const created = list.find((e) => (e.title || '').startsWith('Live E2E —'));
    expect(created, 'created event should be listed').toBeTruthy();
    shared.eventId = created.eventId || created.id;
    console.log('[live-e2e] eventId=' + shared.eventId);
  });

  test('attendee discovers the event and RSVPs', async () => {
    await attendee.signIn(personas.attendee.email, personas.attendee.password);
    expect(await attendee.isSignedIn()).toBe(true);

    // Discovery: the public event page renders for a scheduled event.
    await attendee.goToEvent(shared.eventId);
    const a = attendee.page;
    await a.waitForSelector('[data-action="event-signup"]', { timeout: 15000 });

    // RSVP via the real button.
    await a.click('[data-action="event-signup"]');
    await a.waitForFunction(() => {
      const el = document.querySelector('#signup-message');
      return el && el.style.display !== 'none';
    }, { timeout: 15000 });

    // Confirm server-side: the attendee is now on the presenter's list.
    const signups = await presenter.api('GET', '/events/' + shared.eventId + '/signups');
    expect(signups.status).toBe(200);
    const emails = (signups.body.signups || []).map((s) => s.email);
    expect(emails).toContain(personas.attendee.email);
  });

  test('anonymous visitor can browse the event page', async () => {
    await anon.goToEvent(shared.eventId);
    const an = anon.page;
    // A guest sees the event and a sign-in-to-register prompt (never a
    // one-click RSVP, and never another user's email).
    await an.waitForSelector('[data-action="show-auth-modal"]', { timeout: 15000 });
    const bodyText = await an.textContent('body');
    expect(bodyText).not.toContain(personas.attendee.email);
    expect(bodyText).not.toContain(personas.presenter.email);
  });

  // ---------------------------------------------------------------------
  // DURING THE EVENT
  // ---------------------------------------------------------------------

  test('attendee in the waiting room auto-joins when the presenter goes live', async () => {
    // Attendee opens the live URL before the event starts → waiting room.
    await attendee.goToLive(shared.eventId);
    await attendee.page.waitForFunction(() => {
      const t = document.body.textContent || '';
      return /hasn.t started|Waiting for presenter|Starting soon/i.test(t);
    }, { timeout: 20000 });

    // Presenter enters the green room (start), then goes live.
    let r = await presenter.api('POST', '/events/' + shared.eventId + '/start');
    expect(r.status).toBe(200);

    // Presenter opens the live page and publishes A/V (fake devices).
    await presenter.goToLive(shared.eventId);
    await sleep(6000);
    await presenter.page.evaluate(async () => {
      await LiveSession.toggleMic();
      await LiveSession.toggleWebcam();
    });
    await sleep(3000);
    const selfView = await presenter.page.evaluate(
      () => document.querySelectorAll('#stage-video-container video').length
    );
    expect(selfView, 'presenter should see own published video').toBeGreaterThan(0);

    r = await presenter.api('POST', '/events/' + shared.eventId + '/go-live');
    expect(r.status).toBe(200);

    // The waiting attendee should transition into the session automatically
    // (poll issues tokens once live) — the connecting/live UI replaces the
    // waiting copy within a couple of poll cycles.
    await attendee.page.waitForFunction(() => {
      const t = document.body.textContent || '';
      return !/hasn.t started|Waiting for presenter/i.test(t);
    }, { timeout: 30000 });
  });

  test('anonymous viewer watches the live session as a guest', async () => {
    await anon.goToLive(shared.eventId);
    // Anonymous live view initializes (fingerprint → join-anonymous →
    // stage subscribe). We assert it reaches a connected/among-viewers
    // state rather than the not-live screen.
    await anon.page.waitForFunction(() => {
      const t = document.body.textContent || '';
      return /Connecting to live|Anonymous|Live/i.test(t) || document.querySelector('video');
    }, { timeout: 30000 });

    // Presenter's dashboard should count an anonymous viewer.
    await sleep(4000);
    const anonCount = await presenter.page.evaluate(() => {
      const el = document.querySelector('#dashboard-anonymous-count');
      return el ? parseInt(el.textContent, 10) : 0;
    });
    expect(anonCount, 'presenter dashboard should show ≥1 anonymous viewer').toBeGreaterThanOrEqual(1);
  });

  test('attendee raises a hand and asks a question', async () => {
    const a = attendee.page;
    // Raise hand.
    await a.waitForSelector('#btn-hand-raise', { timeout: 15000 });
    await a.click('#btn-hand-raise');
    // Ask a question.
    await a.click('[data-action="toggle-question-form"]');
    await a.waitForSelector('#question-input');
    await a.fill('#question-input', 'Is this recording verified end to end?');
    await a.click('#question-form button[type="submit"]');

    // Presenter dashboard reflects the hand and the question.
    await sleep(4000);
    const counts = await presenter.page.evaluate(() => ({
      hands: parseInt((document.querySelector('#dashboard-count-hands') || {}).textContent || '0', 10),
      questions: parseInt((document.querySelector('#dashboard-count-questions') || {}).textContent || '0', 10),
    }));
    expect(counts.hands, 'hand should reach presenter').toBeGreaterThanOrEqual(1);
    expect(counts.questions, 'question should reach presenter').toBeGreaterThanOrEqual(1);
  });

  test('presenter extends the event duration', async () => {
    const before = await presenter.publicGet('/events/' + shared.eventId);
    await presenter.page.click('[data-action="extend-duration"][data-minutes="15"]');
    await sleep(3000);
    const after = await presenter.publicGet('/events/' + shared.eventId);
    // scheduledEnd moves later (both personas also get a DURATION_EXTENDED
    // notification, but the persisted end time is the durable check).
    expect(new Date(after.body.scheduledEnd).getTime())
      .toBeGreaterThan(new Date(before.body.scheduledEnd).getTime());
  });

  test('presenter holds live long enough for IVS to record, then ends the session', async () => {
    console.log(`[live-e2e] holding live ${Math.round(LIVE_HOLD_MS / 1000)}s for recording`);
    await sleep(LIVE_HOLD_MS);

    // End Session via the real button.
    await presenter.page.click('[data-action="end-session"]');

    // Presenter UI clears to the ended state (the stuck-"Ending…" fix).
    await presenter.page.waitForFunction(() => {
      const t = document.body.textContent || '';
      return /has ended|Thanks for joining/i.test(t);
    }, { timeout: 20000 });

    // Server-side: event is ended.
    await sleep(2000);
    const evt = await presenter.publicGet('/events/' + shared.eventId);
    expect(evt.body.status).toBe('ended');
  });

  // ---------------------------------------------------------------------
  // AFTER THE EVENT
  // ---------------------------------------------------------------------

  test('recording becomes available and plays back', async () => {
    // The event API returns recordingStatus 'processing' until IVS finishes
    // writing the manifest, then a verified recordingUrl.
    const deadline = Date.now() + RECORDING_WAIT_MS;
    let url = null;
    while (Date.now() < deadline) {
      const evt = await attendee.publicGet('/events/' + shared.eventId);
      if (evt.body && evt.body.recordingUrl) { url = evt.body.recordingUrl; break; }
      console.log('[live-e2e] recording ' + ((evt.body && evt.body.recordingStatus) || 'pending') + ' — waiting');
      await sleep(15000);
    }
    expect(url, 'recording URL should be exposed after processing').toBeTruthy();
    shared.recordingUrl = url;

    // The manifest is real, valid HLS, served over the recordings CDN.
    const manifest = await attendee.page.evaluate(async (u) => {
      const res = await fetch(u);
      return { status: res.status, text: await res.text() };
    }, url);
    expect(manifest.status).toBe(200);
    expect(manifest.text).toContain('#EXTM3U');

    // The event page shows a player (not the processing message).
    await attendee.goToEvent(shared.eventId);
    await attendee.page.waitForSelector('#recording-player, video', { timeout: 15000 });
  });

  test('presenter reviews sign-up stats and attendance', async () => {
    await presenter.goToManage();
    const p = presenter.page;
    await p.waitForSelector(`[data-action="view-signups"][data-event-id="${shared.eventId}"]`, { timeout: 15000 });
    await p.click(`[data-action="view-signups"][data-event-id="${shared.eventId}"]`);

    // Stats strip renders with the show-rate metrics.
    await p.waitForFunction(() => {
      const t = document.body.textContent || '';
      return /RSVP show rate/i.test(t) && /Pre-registered/i.test(t);
    }, { timeout: 15000 });

    // The attendee RSVP'd AND joined → counts as attended. Verify from the
    // authoritative API rather than scraping the exact rendered number.
    const signups = await presenter.api('GET', '/events/' + shared.eventId + '/signups');
    const attendeeRecord = (signups.body.signups || []).find((s) => s.email === personas.attendee.email);
    expect(attendeeRecord, 'attendee should be on the list').toBeTruthy();
    expect(attendeeRecord.attendedAt, 'attendee who joined should be marked attended').toBeTruthy();
  });
});
