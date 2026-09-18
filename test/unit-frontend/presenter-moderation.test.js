'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * Presenter-dashboard moderation controls (video mute, question restriction,
 * global mutes, message-all-attendees) must send the exact wire shapes the
 * signaling Lambda handlers expect — and the receiving side must react to the
 * broadcasts those handlers produce (VIDEO_DISABLED, QUESTIONS_RESTRICTED,
 * GLOBAL_AUDIO_MUTE / GLOBAL_VIDEO_MUTE, GROUP_MESSAGE).
 *
 * The dashboard uses document-level [data-action] delegation, so buttons are
 * driven with dispatchEvent (bubbling MouseEvent) rather than direct handler
 * calls.
 */

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  // --- test drivers ---
  _open() { this.readyState = FakeWebSocket.OPEN; if (this.onopen) this.onopen({}); }
  _message(payload) {
    if (this.onmessage) {
      this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const lastSent = (ws) => JSON.parse(ws.sent[ws.sent.length - 1]);

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function notifications() {
  return Array.from(document.querySelectorAll('[role="alert"]')).map((n) => n.textContent);
}

describe('presenter dashboard moderation controls', () => {
  let LiveSession;

  // Load ONCE per file: the module installs document-level [data-action]
  // delegation at load time, and a second load would stack a second set of
  // listeners on the shared jsdom document (the stale instance would consume
  // the broadcast input before the fresh one reads it). Per-test state is
  // re-established through init() instead.
  beforeAll(() => {
    LiveSession = loadModule('live-session.js', 'LiveSession');
  });

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function initAs(role) {
    document.body.innerHTML = LiveSession.renderPage({ id: 'evt-1' });
    await LiveSession.init({
      eventId: 'evt-1',
      role: role,
      userId: 'u-self',
      email: 'self@example.com',
      wsUrl: 'wss://ws.example/s',
      eventStatus: 'live',
    });
    const ws = lastSocket();
    ws._open();
    return ws;
  }

  function seedAttendee(ws) {
    ws._message({
      type: 'ATTENDEE_LIST',
      data: {
        attendees: [{
          userId: 'u1',
          displayName: 'Alice',
          email: 'alice@example.com',
          role: 'attendee',
          connectionId: 'conn-1',
        }],
      },
    });
  }

  test('per-attendee 📷 Video Off sends the muteVideo wire shape', async () => {
    const ws = await initAs('presenter');
    seedAttendee(ws);

    const btn = document.querySelector('[data-action="mute-user-video"]');
    expect(btn).not.toBeNull();
    click(btn);

    expect(lastSent(ws)).toEqual({
      action: 'muteVideo',
      eventId: 'evt-1',
      data: { targetConnectionId: 'conn-1', userId: 'u1' },
    });
  });

  test('per-attendee ❓ Q Off sends the restrictQuestions wire shape, beside 💬 Chat Off', async () => {
    const ws = await initAs('presenter');
    seedAttendee(ws);

    // Both restriction controls render together in the moderation row.
    expect(document.querySelector('[data-action="restrict-user-chat"]')).not.toBeNull();
    const btn = document.querySelector('[data-action="restrict-user-questions"]');
    expect(btn).not.toBeNull();
    click(btn);

    expect(lastSent(ws)).toEqual({
      action: 'restrictQuestions',
      eventId: 'evt-1',
      data: { targetConnectionId: 'conn-1', userId: 'u1' },
    });
  });

  test('global mute buttons send globalMuteAudio/globalMuteVideo and reconcile from the broadcast', async () => {
    const ws = await initAs('presenter');

    const audioBtn = document.getElementById('btn-global-mute-audio');
    const videoBtn = document.getElementById('btn-global-mute-video');
    expect(audioBtn).not.toBeNull();
    expect(videoBtn).not.toBeNull();

    click(audioBtn);
    expect(lastSent(ws)).toEqual({
      action: 'globalMuteAudio',
      eventId: 'evt-1',
      data: { enabled: true },
    });

    // Server confirms — button flips to the active/unmute state.
    ws._message({ type: 'GLOBAL_AUDIO_MUTE', data: { globalAudioMute: true } });
    expect(audioBtn.textContent).toBe('🔇 Unmute All Audio');

    // Second click toggles back off.
    click(audioBtn);
    expect(lastSent(ws)).toEqual({
      action: 'globalMuteAudio',
      eventId: 'evt-1',
      data: { enabled: false },
    });
    ws._message({ type: 'GLOBAL_AUDIO_MUTE', data: { globalAudioMute: false } });
    expect(audioBtn.textContent).toBe('🔇 Mute All Audio');

    click(videoBtn);
    expect(lastSent(ws)).toEqual({
      action: 'globalMuteVideo',
      eventId: 'evt-1',
      data: { enabled: true },
    });
    ws._message({ type: 'GLOBAL_VIDEO_MUTE', data: { globalVideoMute: true } });
    expect(videoBtn.textContent).toBe('📷 Enable All Video');
  });

  test('message-all-attendees form sends sendGroupMessage and the GROUP_MESSAGE broadcast renders in chat', async () => {
    const ws = await initAs('presenter');

    const input = document.getElementById('dashboard-broadcast-input');
    const form = document.getElementById('dashboard-broadcast-form');
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();

    input.value = '  Hello everyone  ';
    submit(form);

    expect(lastSent(ws)).toEqual({
      action: 'sendGroupMessage',
      eventId: 'evt-1',
      data: { message: 'Hello everyone' },
    });
    expect(input.value).toBe('');

    // No local echo — the broadcast (which includes the sender) renders it.
    ws._message({
      type: 'GROUP_MESSAGE',
      data: { userId: 'u-self', displayName: 'Presenter', senderRole: 'presenter', message: 'Hello everyone', timestamp: 't' },
    });
    const chat = document.getElementById('chat-messages');
    expect(chat.textContent).toContain('Presenter (Announcement)');
    expect(chat.textContent).toContain('Hello everyone');

    // Announcement framing is presenter/co-presenter ONLY: senderRole is
    // server-derived, so an attendee sending the raw sendGroupMessage action
    // renders with a plain name.
    ws._message({
      type: 'GROUP_MESSAGE',
      data: { userId: 'u-att', displayName: 'Alex', senderRole: 'attendee', message: 'hi from the floor', timestamp: 't2' },
    });
    expect(chat.textContent).toContain('hi from the floor');
    expect(chat.textContent).not.toContain('Alex (Announcement)');
  });

  test('empty broadcast input sends nothing', async () => {
    const ws = await initAs('presenter');
    const before = ws.sent.length;

    document.getElementById('dashboard-broadcast-input').value = '   ';
    submit(document.getElementById('dashboard-broadcast-form'));

    expect(ws.sent.length).toBe(before);
  });

  test('attendee side reacts to VIDEO_DISABLED, QUESTIONS_RESTRICTED and global mutes', async () => {
    const ws = await initAs('attendee');

    ws._message({ type: 'VIDEO_DISABLED', data: { userId: 'u-self', message: 'x' } });
    expect(notifications()).toContain('Your video has been disabled by the presenter.');

    ws._message({
      type: 'QUESTIONS_RESTRICTED',
      data: { message: 'Your question submission has been restricted by the presenter' },
    });
    expect(notifications()).toContain('Your question submission has been restricted by the presenter');

    ws._message({ type: 'GLOBAL_AUDIO_MUTE', data: { globalAudioMute: true } });
    expect(notifications()).toContain('The presenter has muted audio for all attendees.');

    ws._message({ type: 'GLOBAL_VIDEO_MUTE', data: { globalVideoMute: true } });
    expect(notifications()).toContain('The presenter has disabled video for all attendees.');

    // Lifting the mutes notifies too.
    ws._message({ type: 'GLOBAL_AUDIO_MUTE', data: { globalAudioMute: false } });
    expect(notifications()).toContain('The presenter has lifted the global audio mute.');
  });

  test('attendee dashboard controls stay hidden (presenter-only gating)', async () => {
    await initAs('attendee');
    expect(document.getElementById('presenter-dashboard').style.display).toBe('none');
  });
});
