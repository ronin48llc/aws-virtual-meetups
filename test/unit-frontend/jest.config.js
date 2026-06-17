'use strict';

/**
 * Layer 1 — fast jsdom unit tests for the vanilla-JS frontend modules.
 *
 * The frontend ships as plain <script> files (no build step), so there is no
 * import graph to resolve here. Modules that expose a CommonJS export
 * (e.g. i18n.js) are require()'d directly; modules that are bare top-level
 * IIFEs (fingerprint.js, websocket.js) are evaluated into this jsdom realm by
 * setup/loadModule.js — without editing anything under frontend/.
 */
module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/setup/jest.setup.js'],
  clearMocks: true,
  // Keep jsdom's "Not implemented: getContext" notices from cluttering output;
  // fingerprint.js intentionally tolerates missing canvas/WebGL.
  testEnvironmentOptions: {
    pretendToBeVisual: true,
  },
};
