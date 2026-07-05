'use strict';
/* Synthetic presenter: drives the REAL dev site end-to-end with a fake
 * webcam/mic and verifies the recording pipeline. Run from test/e2e so
 * @playwright/test resolves. */
const { chromium } = require('@playwright/test');
const fs = require('fs');

const SITE = 'https://awsvirtualmeetups.com';
const API = 'https://api.awsvirtualmeetups.com';
const EMAIL = 'synthetic-presenter@test.invalid';
const PASS = fs.readFileSync(process.env.PASS_FILE, 'utf8').trim();
const LIVE_MINUTES = 3;

function log(msg) { console.log(new Date().toISOString().slice(11, 19), msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('PAGE ERROR: ' + m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept()); // auto-accept confirm() dialogs

  log('loading site');
  await page.goto(SITE, { waitUntil: 'networkidle' });

  log('signing in');
  await page.evaluate(async ({ email, pass }) => { await Auth.signIn(email, pass); }, { email: EMAIL, pass: PASS });

  log('creating event');
  const eventId = await page.evaluate(async (api) => {
    const res = await fetch(api + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Auth.getIdToken() },
      body: JSON.stringify({
        title: 'Synthetic E2E recording test',
        description: 'Automated verification run',
        scheduledStart: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        durationMinutes: 30,
      }),
    });
    if (!res.ok) throw new Error('create failed: ' + res.status + ' ' + (await res.text()));
    const body = await res.json();
    return body.eventId || (body.event && body.event.eventId);
  }, API);
  log('eventId=' + eventId);

  log('starting event (green room)');
  await page.evaluate(async ({ api, id }) => {
    const res = await fetch(api + '/events/' + id + '/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + Auth.getIdToken() },
    });
    if (!res.ok) throw new Error('start failed: ' + res.status + ' ' + (await res.text()));
  }, { api: API, id: eventId });

  log('opening live page and joining stage');
  await page.goto(SITE + '/#/events/' + eventId + '/live', { waitUntil: 'networkidle' });
  await sleep(6000); // join + stage connect

  log('enabling mic + webcam (fake devices)');
  await page.evaluate(async () => { await LiveSession.toggleMic(); await LiveSession.toggleWebcam(); });
  await sleep(4000);
  const videoCount = await page.evaluate(() => document.querySelectorAll('#stage-video-container video').length);
  log('self-view video elements: ' + videoCount + (videoCount > 0 ? '  (PUBLISHING CONFIRMED)' : '  (WARNING: no self-view)'));

  log('going LIVE');
  await page.evaluate(async ({ api, id }) => {
    const res = await fetch(api + '/events/' + id + '/go-live', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + Auth.getIdToken() },
    });
    if (!res.ok) throw new Error('go-live failed: ' + res.status + ' ' + (await res.text()));
  }, { api: API, id: eventId });

  log('LIVE — holding for ' + LIVE_MINUTES + ' minutes while IVS records');
  for (let i = 0; i < LIVE_MINUTES * 2; i++) {
    await sleep(30000);
    const vc = await page.evaluate(() => document.querySelectorAll('#stage-video-container video').length);
    log('still live, self-view videos=' + vc);
  }

  log('ending session');
  await page.evaluate(async ({ api, id }) => {
    const res = await fetch(api + '/events/' + id + '/stop', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + Auth.getIdToken() },
    });
    if (!res.ok) throw new Error('stop failed: ' + res.status + ' ' + (await res.text()));
  }, { api: API, id: eventId });
  await browser.close();

  log('polling event page for the recording (up to 8 min)');
  for (let i = 0; i < 32; i++) {
    const res = await fetch(API + '/events/' + eventId);
    const evt = await res.json();
    if (evt.recordingUrl) {
      log('recordingUrl: ' + evt.recordingUrl);
      const m3u8 = await fetch(evt.recordingUrl);
      const text = await m3u8.text();
      const ok = m3u8.status === 200 && text.includes('#EXTM3U');
      log('manifest fetch: HTTP ' + m3u8.status + (ok ? ' — VALID HLS' : ' — INVALID'));
      console.log(ok ? 'RESULT: RECORDING PIPELINE VERIFIED END-TO-END' : 'RESULT: MANIFEST INVALID');
      process.exit(ok ? 0 : 1);
    }
    log('status=' + (evt.recordingStatus || 'no recording yet') + ' — waiting');
    await sleep(15000);
  }
  console.log('RESULT: TIMED OUT waiting for recording');
  process.exit(1);
})().catch((err) => { console.log('RESULT: FAILED — ' + err.message); process.exit(1); });
