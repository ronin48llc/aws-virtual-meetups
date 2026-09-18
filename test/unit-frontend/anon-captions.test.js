'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * Anonymous viewers get caption lanes too: the LIVE view renders a language
 * selector defaulting to "Original", the selection is synced to the signaling
 * server (setCaptionLanguage WS action — including "original", which REMOVEs
 * the connection's captionLang), and incoming CAPTION messages render only
 * when they match the viewer's lane. A viewer who never touches the selector
 * sees the presenter's original feed regardless of language — the same
 * fallback live-session.js applies while its captionLangSelected latch is
 * unset.
 */

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close() {}
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.instances = [];

function sentActions(ws, action) {
  return ws.sent.filter((m) => m.action === action);
}

function deliverCaption(ws, data) {
  ws.onmessage({ data: JSON.stringify({ type: 'CAPTION', eventId: 'evt-1', data: data }) });
}

describe('anonymous viewer captions', () => {
  let AnonymousViewer;

  const PLACEHOLDER = 'Captions will appear here when the presenter enables them.';

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    global.Fingerprint = { generate: jest.fn().mockResolvedValue('fp-1') };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessionId: 'sess-1' }),
    });
    sessionStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    AnonymousViewer = loadModule('anonymous-viewer.js', 'AnonymousViewer');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete global.WebSocket;
    delete global.Fingerprint;
    delete global.fetch;
  });

  async function initAnon() {
    await AnonymousViewer.initLive({ eventId: 'evt-1', wsUrl: 'ws://test' });
    return FakeWebSocket.instances[0];
  }

  function captionText() {
    return document.getElementById('anon-caption-text').textContent;
  }

  test('renders the caption area under the stage with Original preselected', async () => {
    await initAnon();
    const stage = document.getElementById('anon-stage-video-container');
    expect(stage.nextElementSibling.id).toBe('anon-caption-area');

    const select = document.getElementById('anon-caption-language-select');
    expect(select).not.toBeNull();
    expect(select.value).toBe('original');
    // "Original" + the 8 supported language codes
    expect(select.options).toHaveLength(9);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(
      ['original', 'en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'zh']
    );
    expect(captionText()).toBe(PLACEHOLDER);
  });

  test('default lane: original captions render in any language, others are dropped', async () => {
    const ws = await initAnon();
    // Translated lane traffic isn't for this connection — dropped.
    deliverCaption(ws, { text: 'hola a todos', language: 'es', original: false, isFinal: true });
    expect(captionText()).toBe(PLACEHOLDER);
    // The presenter's own feed renders whatever language they speak.
    deliverCaption(ws, { text: 'bonjour à tous', language: 'fr', original: true, isFinal: true });
    expect(captionText()).toBe('bonjour à tous');
  });

  test('after selecting a language only that exact lane renders', async () => {
    const ws = await initAnon();
    AnonymousViewer.setCaptionLanguage('es');
    // The original feed no longer renders once a translated lane is picked.
    deliverCaption(ws, { text: 'bonjour', language: 'fr', original: true, isFinal: true });
    // Nor does a non-matching translated lane.
    deliverCaption(ws, { text: 'guten Tag', language: 'de', original: false, isFinal: true });
    expect(captionText()).toBe(PLACEHOLDER);
    deliverCaption(ws, { text: 'hola de nuevo', language: 'es', original: false, isFinal: true });
    expect(captionText()).toBe('hola de nuevo');
  });

  test('changing the selector sends setCaptionLanguage with the chosen code', async () => {
    const ws = await initAnon();
    const select = document.getElementById('anon-caption-language-select');
    select.value = 'ja';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sentActions(ws, 'setCaptionLanguage')).toEqual([
      { action: 'setCaptionLanguage', eventId: 'evt-1', data: { language: 'ja' } },
    ]);
  });

  test('selecting "original" is synced too and restores the original feed', async () => {
    const ws = await initAnon();
    AnonymousViewer.setCaptionLanguage('es');
    AnonymousViewer.setCaptionLanguage('original');
    expect(sentActions(ws, 'setCaptionLanguage')).toEqual([
      { action: 'setCaptionLanguage', eventId: 'evt-1', data: { language: 'es' } },
      { action: 'setCaptionLanguage', eventId: 'evt-1', data: { language: 'original' } },
    ]);
    deliverCaption(ws, { text: 'de retour', language: 'fr', original: true, isFinal: true });
    expect(captionText()).toBe('de retour');
  });

  test('initial onopen with no selection made sends nothing (lane defaults server-side)', async () => {
    const ws = await initAnon();
    ws.onopen();
    expect(sentActions(ws, 'setCaptionLanguage')).toEqual([]);
  });

  test('reconnect re-sends the current selection on the new socket', async () => {
    const ws1 = await initAnon();
    AnonymousViewer.setCaptionLanguage('ko');

    // Drop the connection; the first backoff retry (1s) opens a fresh socket.
    ws1.onclose();
    jest.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeDefined();

    ws2.onopen();
    expect(sentActions(ws2, 'setCaptionLanguage')).toEqual([
      { action: 'setCaptionLanguage', eventId: 'evt-1', data: { language: 'ko' } },
    ]);
  });
});

describe('live-session CAPTION receive filter (original-feed fallback)', () => {
  let LiveSession;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    // The page template isn't rendered in this bare jsdom — provide just the
    // caption line displayCaption writes into.
    document.body.innerHTML = '<div id="caption-text"></div>';
    LiveSession = loadModule('live-session.js', 'LiveSession');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete global.WebSocket;
  });

  async function initAttendee() {
    await LiveSession.init({ eventId: 'evt-1', role: 'attendee', wsUrl: 'ws://test' });
    return FakeWebSocket.instances[0];
  }

  function captionText() {
    return document.getElementById('caption-text').textContent;
  }

  test('a viewer who never picked a lane sees the original feed in any language', async () => {
    const ws = await initAttendee();
    const waiting = captionText(); // renderUI's "waiting" placeholder
    // Not original and not the 'en' default lane — still dropped.
    deliverCaption(ws, { text: 'hola', language: 'es', original: false, isFinal: true });
    expect(captionText()).toBe(waiting);
    // The presenter's original feed renders even though it isn't 'en'.
    deliverCaption(ws, { text: 'こんにちは', language: 'ja', original: true, isFinal: true });
    expect(captionText()).toBe('こんにちは');
  });

  test('an explicit selection latches back to exact-lane matching', async () => {
    const ws = await initAttendee();
    LiveSession.setCaptionLanguage('es');
    deliverCaption(ws, { text: 'おはよう', language: 'ja', original: true, isFinal: true });
    expect(captionText()).not.toBe('おはよう');
    deliverCaption(ws, { text: 'buenos días', language: 'es', original: false, isFinal: true });
    expect(captionText()).toBe('buenos días');
  });
});
