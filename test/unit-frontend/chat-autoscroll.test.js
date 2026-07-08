'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * Chat must autoscroll ONLY when the reader is already at/near the bottom.
 * Unconditional `scrollTop = scrollHeight` on every message yanked the pane
 * down while people were scrolled up reading history — the "distracting
 * scrolling" complaint from live testing during join/leave churn.
 */
describe('chat autoscroll respects reading position', () => {
  let LiveSession;
  let messagesEl;

  beforeEach(() => {
    global.requestAnimationFrame = global.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
    document.body.innerHTML = '<div id="chat-messages"></div>';
    messagesEl = document.getElementById('chat-messages');
    LiveSession = loadModule('live-session.js', 'LiveSession');
  });

  function setScrollState({ scrollTop, scrollHeight, clientHeight }) {
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, value: clientHeight });
    messagesEl.scrollTop = scrollTop;
  }

  const flushRaf = () => new Promise((r) => setTimeout(r, 20));

  test('scrolled to bottom → autoscrolls on new message', async () => {
    // 400px content in a 200px pane, scrolled to the bottom (400-200=200).
    setScrollState({ scrollTop: 200, scrollHeight: 400, clientHeight: 200 });
    LiveSession.appendChatMessage('You (DM)', 'hello', 'group');
    await flushRaf();
    expect(messagesEl.scrollTop).toBe(messagesEl.scrollHeight);
  });

  test('scrolled up reading history → does NOT yank to bottom', async () => {
    setScrollState({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 });
    LiveSession.appendChatMessage('You (DM)', 'hello again', 'group');
    await flushRaf();
    expect(messagesEl.scrollTop).toBe(0);
  });
});
