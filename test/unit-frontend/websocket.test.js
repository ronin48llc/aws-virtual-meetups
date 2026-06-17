'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * Minimal fake WebSocket. Records constructed instances and lets a test drive
 * the lifecycle (open / message / close) the way API Gateway would, so we can
 * exercise WebSocketClient's real dispatch + send paths without a network.
 */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = null;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    this.closed = { code, reason };
  }
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

let WS;
beforeEach(() => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  // Reload to get a fresh module instance (websocket.js holds singleton state).
  WS = loadModule('websocket.js', 'WebSocketClient');
});

describe('WebSocketClient', () => {
  test('exposes all 11 incoming MESSAGE_TYPES', () => {
    expect(WS.MESSAGE_TYPES).toEqual(expect.arrayContaining([
      'HAND_RAISED', 'HAND_LOWERED', 'HANDS_CLEARED', 'QUESTION_SUBMITTED',
      'QUESTION_ANSWERED', 'QUESTION_DISMISSED', 'ROLE_CHANGED',
      'SPEAK_PERMISSION_CHANGED', 'CHAT_STATE_CHANGED', 'EVENT_STARTED', 'EVENT_ENDED',
    ]));
    expect(WS.MESSAGE_TYPES).toHaveLength(11);
  });

  test('connect() appends the auth token to the URL (encoded)', () => {
    WS.connect({ url: 'wss://ws.example/socket', eventId: 'e1', token: 'tok 1' });
    expect(lastSocket().url).toBe('wss://ws.example/socket?token=tok%201');
  });

  test('onopen marks connected and fires the connected listener', () => {
    const onConnected = jest.fn();
    WS.on('connected', onConnected);
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    expect(WS.isConnected()).toBe(false);
    lastSocket()._open();
    expect(WS.isConnected()).toBe(true);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  test('a typed message dispatches to its listener with the data payload', () => {
    const onQ = jest.fn();
    WS.on('QUESTION_SUBMITTED', onQ);
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    lastSocket()._open();
    lastSocket()._message({ type: 'QUESTION_SUBMITTED', data: { id: 'q1', text: 'hi' } });
    expect(onQ).toHaveBeenCalledWith(
      { id: 'q1', text: 'hi' },
      expect.objectContaining({ type: 'QUESTION_SUBMITTED' })
    );
  });

  test('a generic "message" listener receives every message', () => {
    const onMsg = jest.fn();
    WS.on('message', onMsg);
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    lastSocket()._open();
    lastSocket()._message({ type: 'EVENT_ENDED', data: {} });
    expect(onMsg).toHaveBeenCalledTimes(1);
    // The 'message' fan-out delivers the full envelope as the first argument.
    expect(onMsg.mock.calls[0][0]).toEqual(expect.objectContaining({ type: 'EVENT_ENDED' }));
  });

  test('invalid JSON is ignored without throwing or dispatching', () => {
    const onMsg = jest.fn();
    WS.on('message', onMsg);
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    lastSocket()._open();
    expect(() => lastSocket()._message('{ not json')).not.toThrow();
    expect(onMsg).not.toHaveBeenCalled();
  });

  test('send actions are dropped until the socket is OPEN', () => {
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    WS.raiseHand(); // still CONNECTING
    expect(lastSocket().sent).toHaveLength(0);
    lastSocket()._open();
    WS.raiseHand();
    expect(JSON.parse(lastSocket().sent[0]))
      .toEqual({ action: 'raiseHand', eventId: 'e1', data: {} });
  });

  test('submitQuestion trims text and ignores empty input', () => {
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    lastSocket()._open();
    WS.submitQuestion('   ');
    expect(lastSocket().sent).toHaveLength(0);
    WS.submitQuestion('  hello  ');
    expect(JSON.parse(lastSocket().sent[0]))
      .toEqual({ action: 'submitQuestion', eventId: 'e1', data: { text: 'hello' } });
  });

  test('disconnect() closes intentionally and fires disconnected', () => {
    const onDisc = jest.fn();
    WS.on('disconnected', onDisc);
    WS.connect({ url: 'wss://ws.example/s', eventId: 'e1', token: '' });
    lastSocket()._open();
    WS.disconnect();
    expect(onDisc).toHaveBeenCalledTimes(1);
    expect(onDisc.mock.calls[0][0]).toEqual({ intentional: true });
    expect(WS.isConnected()).toBe(false);
  });
});
