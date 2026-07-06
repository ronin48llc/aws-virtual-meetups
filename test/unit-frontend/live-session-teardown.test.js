'use strict';

const { loadModule } = require('./setup/loadModule');

/**
 * The device picker overlay is appended to document.body (outside #app), so the
 * router's innerHTML swap on hash navigation does not clear it. Without explicit
 * teardown it lingered as a full-screen, high-z-index overlay and intercepted
 * pointer events on the next page (End Session → Manage Events left "Sign-ups"
 * unclickable). disconnect() — which the router calls when leaving /live — must
 * remove it.
 */
describe('LiveSession body-overlay teardown', () => {
  let LiveSession;

  beforeEach(() => {
    document.body.innerHTML = '';
    LiveSession = loadModule('live-session.js', 'LiveSession');
  });

  function addDevicePickerOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'device-picker-overlay';
    overlay.style.cssText = 'position: fixed; inset: 0; z-index: 2000;';
    document.body.appendChild(overlay);
    return overlay;
  }

  test('disconnect() removes a lingering #device-picker-overlay', () => {
    addDevicePickerOverlay();
    expect(document.getElementById('device-picker-overlay')).not.toBeNull();

    LiveSession.disconnect();

    expect(document.getElementById('device-picker-overlay')).toBeNull();
  });

  test('disconnect() is a no-op when no overlay is present', () => {
    expect(() => LiveSession.disconnect()).not.toThrow();
    expect(document.getElementById('device-picker-overlay')).toBeNull();
  });
});
