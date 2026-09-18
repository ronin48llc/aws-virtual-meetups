'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * Caption lanes: a viewer's language selection must reach the signaling
 * server (setCaptionLanguage WS action) so handleBroadcastCaption can
 * translate captions into that lane — and must be re-sent after a WS
 * reconnect, because the server stores captionLang on the connection row
 * and a reconnect creates a brand-new row. Presenters never send it: they
 * broadcast in the language they speak.
 */
describe('caption language WS sync', () => {
  let LiveSession;

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

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    document.body.innerHTML = '';
    LiveSession = loadModule('live-session.js', 'LiveSession');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete global.WebSocket;
  });

  function sentActions(ws, action) {
    return ws.sent.filter((m) => m.action === action);
  }

  async function initAs(role) {
    await LiveSession.init({ eventId: 'evt-1', role: role, wsUrl: 'ws://test' });
    return FakeWebSocket.instances[0];
  }

  test('attendee selection sends setCaptionLanguage with the chosen code', async () => {
    const ws = await initAs('attendee');
    LiveSession.setCaptionLanguage('es');
    expect(sentActions(ws, 'setCaptionLanguage')).toEqual([
      { action: 'setCaptionLanguage', eventId: 'evt-1', data: { language: 'es' } },
    ]);
  });

  test('presenter selection sends nothing over the WebSocket', async () => {
    const ws = await initAs('presenter');
    LiveSession.setCaptionLanguage('fr');
    expect(sentActions(ws, 'setCaptionLanguage')).toEqual([]);
  });

  test('initial onopen with no selection made sends nothing (lane defaults server-side)', async () => {
    const ws = await initAs('attendee');
    ws.onopen();
    expect(sentActions(ws, 'setCaptionLanguage')).toEqual([]);
  });

  test('reconnect re-sends the current selection on the new socket', async () => {
    const ws1 = await initAs('attendee');
    LiveSession.setCaptionLanguage('ja');

    // Drop the connection; the 3s retry opens a fresh socket.
    ws1.onclose();
    jest.advanceTimersByTime(3000);
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeDefined();

    ws2.onopen();
    expect(sentActions(ws2, 'setCaptionLanguage')).toEqual([
      { action: 'setCaptionLanguage', eventId: 'evt-1', data: { language: 'ja' } },
    ]);
  });

  test('broadcastCaptionToAttendees is exported and sends broadcastCaption', async () => {
    const ws = await initAs('presenter');
    expect(typeof LiveSession.broadcastCaptionToAttendees).toBe('function');
    LiveSession.broadcastCaptionToAttendees('hello world', 'en');
    expect(sentActions(ws, 'broadcastCaption')).toEqual([
      { action: 'broadcastCaption', eventId: 'evt-1', data: { text: 'hello world', language: 'en', isFinal: true } },
    ]);
  });
});
