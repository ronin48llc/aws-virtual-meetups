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

    const goLive = await presenter.api('POST', '/events/' + shared.eventId + '/go-live');
    expect(goLive.status, 'go-live should succeed: ' + goLive.text).toBe(200);

    // The waiting attendee should transition into the session automatically:
    // the 5s poll issues tokens once the event is live, then LiveSession
    // renders the live UI (which has a #btn-hand-raise control the waiting
    // room never has). Assert on that element, not just the absence of copy
    // — the poll cycle + stage connect can take a couple of cycles.
    await attendee.page.waitForSelector('#btn-hand-raise', { timeout: 45000 });
  });

  test('screen share composites with the webcam into the published stream', async () => {
    const p = presenter.page;
    // Webcam already on from go-live. Start screen share (headless chromium
    // auto-approves via --auto-select-desktop-capture-source).
    await p.evaluate(async () => { await LiveSession.toggleScreenShare(); });
    await sleep(3000);

    // Both sources live → the published video is the 1280x720 composite
    // canvas (screen full-frame + webcam PiP), NOT one source on top of the
    // other. The self-view plays the published track, so its dimensions
    // prove what attendees and the RECORDING receive.
    const mode = await p.evaluate(() => LiveSession.getPublishVideoMode());
    expect(mode).toBe('composite');
    await p.waitForFunction(() => {
      // Any container video at the composite resolution (the self-view);
      // the device-picker preview element also lives here at camera size.
      const vids = Array.from(document.querySelectorAll('#stage-video-container video'));
      return vids.some((v) => v.videoWidth === 1280 && v.videoHeight === 720);
    }, { timeout: 15000 });

    // The self-view is a labeled PROGRAM monitor (what attendees see).
    await p.waitForSelector('#program-badge', { timeout: 10000 });

    // Stop sharing → back to camera-only, publish still healthy.
    await p.evaluate(async () => { await LiveSession.toggleScreenShare(); });
    await sleep(2000);
    expect(await p.evaluate(() => LiveSession.getPublishVideoMode())).toBe('camera');
    expect(await p.evaluate(() =>
      document.querySelectorAll('#stage-video-container video').length
    )).toBeGreaterThan(0);
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

  test('attendee group chat reaches the presenter', async () => {
    // Group chat rides the native IVS Chat room both personas joined — a
    // real cross-service round-trip (send via SDK → IVS → deliver to the
    // other participant's message listener), not our WebSocket.
    const marker = 'e2e-chat-' + Date.now();
    const a = attendee.page;
    await a.waitForSelector('#chat-input', { timeout: 15000 });
    await a.fill('#chat-input', marker);
    await a.locator('#chat-form').dispatchEvent('submit');

    // The presenter's chat pane should show the attendee's message.
    await presenter.page.waitForFunction(
      (m) => {
        const el = document.getElementById('chat-messages');
        return el && el.textContent.includes(m);
      },
      marker,
      { timeout: 20000 }
    );
  });

  test('promoting the attendee changes only their role, not everyone\'s', async () => {
    // Regression guard for two ROLE_CHANGED bugs: the handler read the wrong
    // field (role vs newRole) so promotion never applied, and it lacked a
    // self-target check so a broadcast role change could hit every recipient.
    const attendeeSub = await attendee.page.evaluate(
      () => JSON.parse(atob(Auth.getIdToken().split('.')[1])).sub
    );

    await presenter.page.evaluate(() => LiveSession.switchDashboardTab('attendees'));
    const promoteBtn = presenter.page.locator(
      `[data-action="promote-user"][data-user-id="${attendeeSub}"]`
    );
    await promoteBtn.waitFor({ timeout: 15000 });
    await promoteBtn.dispatchEvent('click');

    // The promoted attendee becomes co-presenter…
    await attendee.page.waitForFunction(
      () => LiveSession.getRole && LiveSession.getRole() === 'co-presenter',
      { timeout: 30000 }
    );
    // …and the presenter stays a presenter (the self-target guard prevents
    // a broadcast role change from affecting non-targeted recipients).
    const presenterRole = await presenter.page.evaluate(() => LiveSession.getRole());
    expect(presenterRole).toBe('presenter');
    // Co-presenter *publishing* is verified in the next test.
  });

  test('promoted co-presenter can actually publish audio and video', async () => {
    // The prior test left the attendee as co-presenter. Promotion delivers a
    // PUBLISH-capable IVS token to that user alone, so publishing now works
    // end-to-end: the split A/V controls render, the co-presenter sees a
    // self-view, AND the presenter (a separate IVS participant) subscribes to
    // the newly published stream. If the publish token were never minted or
    // never delivered, IVS would reject the publish and the presenter would
    // see no new stream.
    const a = attendee.page;

    // The A/V publish controls (#btn-mic lives in #publish-controls) render
    // for a co-presenter; a plain attendee never has this button.
    await a.waitForSelector('#btn-mic', { timeout: 30000 });

    // Let the promotion-triggered stage re-join (leave + rejoin with the
    // publish token) settle before capturing tracks.
    await sleep(4000);

    // Baseline: streams the presenter renders before the co-presenter
    // publishes. Nobody else is publishing (anon + attendee were subscribers).
    const beforeCount = await presenter.page.evaluate(
      () => document.querySelectorAll('#stage-video-container video').length
    );

    // Co-presenter turns on mic + webcam (fake devices). getUserMedia +
    // publish only reaches IVS if the token carries PUBLISH capability.
    await a.evaluate(async () => {
      await LiveSession.toggleMic();
      await LiveSession.toggleWebcam();
    });

    // The co-presenter captures their own webcam — the local self-view
    // element only renders when getUserMedia + publish succeed.
    await a.waitForSelector('#video-local-preview', { timeout: 20000 });

    // The presenter subscribes to the co-presenter's new stream — a real IVS
    // round-trip that only happens when the publish token is accepted.
    await presenter.page.waitForFunction(
      (before) => document.querySelectorAll('#stage-video-container video').length > before,
      beforeCount,
      { timeout: 45000 }
    );
  });

  test('presenter bans then unbans the attendee', async () => {
    const attendeeSub = await attendee.page.evaluate(
      () => JSON.parse(atob(Auth.getIdToken().split('.')[1])).sub
    );

    // Ban from the attendee row (auto-accepts the confirm dialog via the
    // Actor's dialog handler). Server-side: a BAN#<sub> record appears.
    await presenter.page.evaluate(() => LiveSession.switchDashboardTab('attendees'));
    const banBtn = presenter.page.locator(
      `[data-action="ban-user"][data-user-id="${attendeeSub}"]`
    );
    await banBtn.waitFor({ timeout: 15000 });
    await banBtn.dispatchEvent('click');

    // The ban WS write and a Bans-tab listBans query race if fired back to
    // back (observed: listBans returned count 0 before the ban persisted).
    // Give the write a beat, then open the Bans tab (fires a fresh
    // listBans) and re-fire it each poll until the ban shows.
    await sleep(3000);
    await presenter.page.waitForFunction(
      (sub) => {
        LiveSession.switchDashboardTab('bans'); // re-query each poll
        const p = document.getElementById('dashboard-panel-bans');
        return p && p.textContent.includes(sub);
      },
      attendeeSub,
      { timeout: 15000, polling: 2000 }
    );

    // Unban — the ban record is removed and the row leaves the Bans list.
    const unbanBtn = presenter.page.locator(
      `[data-action="unban-user"][data-user-id="${attendeeSub}"]`
    );
    await unbanBtn.dispatchEvent('click');
    await presenter.page.waitForFunction(
      (sub) => {
        const p = document.getElementById('dashboard-panel-bans');
        return p && !p.textContent.includes(sub);
      },
      attendeeSub,
      { timeout: 15000 }
    );
  });

  test('presenter extends the event duration', async () => {
    const before = await presenter.publicGet('/events/' + shared.eventId);
    // The extend control sits in the presenter toolbar, which the published
    // self-view video overlaps in a headless viewport. A forced click lands
    // on whatever pixel is on top (the video), so it never reaches the
    // button. dispatchEvent delivers straight to the element and bubbles to
    // the document-level [data-action] delegation — exercising the real
    // handler → API → persisted scheduledEnd path without pixel geometry.
    await presenter.page.locator('[data-action="extend-duration"][data-minutes="15"]')
      .dispatchEvent('click');
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

    // End Session via the real button (same toolbar overlap → dispatchEvent).
    await presenter.page.locator('[data-action="end-session"]').dispatchEvent('click');

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
    // The live session tears down its body-appended device-picker overlay on
    // disconnect (navigating away from /live), so nothing lingers over Manage —
    // a normal click reaches the button.
    await p.locator(`[data-action="view-signups"][data-event-id="${shared.eventId}"]`)
      .click();

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
