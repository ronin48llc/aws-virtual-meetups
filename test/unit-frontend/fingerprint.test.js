'use strict';

const { loadModule } = require('./setup/loadModule');

// fingerprint.js is a bare top-level `const Fingerprint = (()=>...)()` with no
// export, so we evaluate it into the jsdom realm and capture the binding.
// In jsdom, canvas/WebGL/font signals are unavailable (getContext is a no-op),
// leaving userAgent + screen + timezone — exactly the 3 signals needed to take
// the hashing path rather than the random sessionStorage fallback.
let Fingerprint;
beforeAll(() => {
  Fingerprint = loadModule('fingerprint.js', 'Fingerprint');
});

describe('Fingerprint', () => {
  test('collectSignals returns the six expected signal keys', () => {
    const signals = Fingerprint.collectSignals();
    expect(Object.keys(signals).sort()).toEqual(
      ['canvas', 'fonts', 'screen', 'timezone', 'userAgent', 'webgl']
    );
  });

  test('generate() produces a 16-char lowercase hex fingerprint', async () => {
    const fp = await Fingerprint.generate();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  test('generate() is deterministic for a stable environment', async () => {
    const a = await Fingerprint.generate();
    const b = await Fingerprint.generate();
    expect(a).toBe(b);
  });
});
