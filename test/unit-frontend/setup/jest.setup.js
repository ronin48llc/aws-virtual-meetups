'use strict';

/**
 * jsdom ships no canvas/WebGL implementation. fingerprint.js deliberately
 * probes `getContext` and tolerates its absence (falling back to other
 * signals), so the resulting "Not implemented: getContext" notices are
 * expected, not failures. Silence just those so genuine errors stay visible.
 */
const originalError = console.error;
console.error = (...args) => {
  const first = args[0];
  const message = first && first.message ? first.message : String(first);
  if (
    typeof message === 'string' &&
    message.includes('Not implemented: HTMLCanvasElement.prototype.getContext')
  ) {
    return;
  }
  originalError(...args);
};
