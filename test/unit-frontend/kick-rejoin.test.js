'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * Kick-flow fan-out and dashboard rejoin race.
 *
 * The signaling Lambda sends USER_KICKED twice: once directly to the kicked
 * user and once as a broadcast to every remaining participant. The client must
 * self-disconnect ONLY when the message is about itself — otherwise every
 * participant would drop when anyone is kicked.
 *
 * Separately, ATTENDEE_LEFT now carries the connectionId of the socket that
 * left. A user who rejoins gets a FRESH dashboard row with the same userId, so
 * the OLD socket's late $disconnect must be matched by connectionId — matching
 * by userId alone would wipe the fresh row.
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

// The rendered rows and their inner controls carry the identity attributes we
// assert on: the row div holds data-user-id, the kick button holds both ids.
function attendeeUserIds() {
  return Array.from(document.querySelectorAll('.registered-attendee-entry'))
    .map((el) => el.getAttribute('data-user-id'));
}
function attendeeConnectionIds() {
  return Array.from(document.querySelectorAll('[data-action="kick-user"]'))
    .map((el) => el.getAttribute('data-connection-id'));
}
function displayNames() {
  return document.getElementById('dashboard-panel-attendees').textContent;
}

describe('kick fan-out and dashboard rejoin race', () => {
  let LiveSession;

  // Load ONCE per file: the module installs document-level [data-action]
  // delegation at load time, and a second load would stack a second set of
  // listeners on the shared jsdom document. Per-test state is re-established
  // through init() instead.
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

  // dashboardAttendees is module-level singleton state that init() does not
  // reset, so every dashboard test seeds through ATTENDEE_LIST first — that
  // handler REPLACES the array, clearing any residue from a prior test.
  function seedList(ws, attendees) {
    ws._message({
      type: 'ATTENDEE_LIST',
      data: {
        attendees: attendees.map((a) => ({
          userId: a.userId,
          displayName: a.displayName,
          email: a.displayName + '@x',
          role: 'attendee',
          connectionId: a.connectionId,
        })),
      },
    });
  }

  function join(ws, { userId, displayName, connectionId }) {
    ws._message({
      type: 'ATTENDEE_JOINED',
      data: { userId, displayName, email: displayName + '@x', role: 'attendee', connectionId },
    });
  }

  describe('USER_KICKED fan-out', () => {
    test('self-disconnects when the kicked userId is us', async () => {
      const ws = await initAs('attendee');
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);

      ws._message({ type: 'USER_KICKED', data: { userId: 'u-self', reason: 'Disruptive' } });

      // disconnect() closes the socket.
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    });

    test('does NOT self-disconnect when another user is kicked', async () => {
      const ws = await initAs('attendee');

      ws._message({ type: 'USER_KICKED', data: { userId: 'someone-else', reason: 'Disruptive' } });

      // The broadcast is about a different user — we stay connected.
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    });

    test('presenter drops the kicked user from the dashboard but stays connected', async () => {
      const ws = await initAs('presenter');
      seedList(ws, [
        { userId: 'u1', displayName: 'Alice', connectionId: 'conn-1' },
        { userId: 'u2', displayName: 'Bob', connectionId: 'conn-2' },
      ]);
      expect(attendeeUserIds()).toEqual(['u1', 'u2']);

      ws._message({ type: 'USER_KICKED', data: { userId: 'u1', reason: 'Disruptive' } });

      expect(attendeeUserIds()).toEqual(['u2']);
      expect(displayNames()).not.toContain('Alice');
      expect(displayNames()).toContain('Bob');
      // The presenter is not the target, so their own socket stays open.
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    });
  });

  describe('ATTENDEE_LEFT rejoin race', () => {
    test('with connectionId removes only the matching row, preserving a same-userId fresh row', async () => {
      const ws = await initAs('presenter');
      // Same user, two sockets: the old one, then a fresh rejoin (ATTENDEE_JOINED).
      seedList(ws, [{ userId: 'u1', displayName: 'Alice-old', connectionId: 'conn-old' }]);
      join(ws, { userId: 'u1', displayName: 'Alice-new', connectionId: 'conn-new' });
      expect(attendeeConnectionIds()).toEqual(['conn-old', 'conn-new']);

      // The OLD socket's late $disconnect fires — it must NOT wipe the fresh row.
      ws._message({ type: 'ATTENDEE_LEFT', data: { userId: 'u1', connectionId: 'conn-old' } });

      expect(attendeeConnectionIds()).toEqual(['conn-new']);
      expect(displayNames()).toContain('Alice-new');
      expect(displayNames()).not.toContain('Alice-old');
    });

    test('without connectionId still removes by userId (older payloads)', async () => {
      const ws = await initAs('presenter');
      seedList(ws, [{ userId: 'u1', displayName: 'Alice', connectionId: 'conn-1' }]);
      expect(attendeeUserIds()).toEqual(['u1']);

      ws._message({ type: 'ATTENDEE_LEFT', data: { userId: 'u1' } });

      expect(attendeeUserIds()).toEqual([]);
    });
  });
});
