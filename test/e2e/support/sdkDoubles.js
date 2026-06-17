'use strict';

/**
 * Injects permissive doubles for the CDN-loaded SDKs the media-heavy pages
 * expect on `window`, before any page script runs. They exist only to let the
 * live-session / playback code paths execute without real IVS/HLS services;
 * specs assert on the rendered scaffold and on mocked WebSocket signaling, not
 * on real streaming.
 *
 * @param {import('@playwright/test').Page} page
 */
async function installSdkDoubles(page) {
  await page.addInitScript(() => {
    const noop = () => {};
    const enumProxy = new Proxy({}, { get: (_t, prop) => prop });

    // Amazon IVS Web Broadcast SDK.
    function FakeStage() {}
    FakeStage.prototype.join = async () => {};
    FakeStage.prototype.leave = noop;
    FakeStage.prototype.on = noop;
    FakeStage.prototype.addStrategy = noop;
    FakeStage.prototype.refreshStrategy = noop;
    window.IVSBroadcastClient = {
      Stage: FakeStage,
      LocalStageStream: function () {},
      SubscribeType: { AUDIO_VIDEO: 'AUDIO_VIDEO', NONE: 'NONE' },
      StageEvents: enumProxy,
      StageConnectionState: enumProxy,
      StreamType: enumProxy,
      create: () => ({}),
    };

    // HLS.js — report unsupported so playback falls back to native <video src>.
    function FakeHls() {}
    FakeHls.isSupported = () => false;
    FakeHls.Events = enumProxy;
    window.Hls = FakeHls;

    // IVS Chat messaging SDK.
    window.IVSChat = {
      ChatRoom: function () {
        return { connect: noop, addListener: noop, disconnect: noop };
      },
    };
  });
}

module.exports = { installSdkDoubles };
