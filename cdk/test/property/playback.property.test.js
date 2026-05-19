'use strict';

const fc = require('fast-check');

// --- DOM mocks required for playback module to load ---
global.window = { location: { search: '' } };
global.document = {
  getElementById: () => null,
  createElement: (tag) => ({
    tagName: tag,
    textContent: '',
    innerHTML: '',
    get innerText() { return this.textContent; },
    style: {},
    appendChild: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
  })
};
global.URLSearchParams = URLSearchParams;

const { Playback } = require('../../../frontend/js/playback');

/**
 * Feature: email-notifications, Property 10: Timestamp Deep-Link Parsing
 *
 * For any non-negative integer timestamp parameter value (in seconds),
 * the deep-link parser correctly converts it to a seek position in seconds.
 *
 * **Validates: Requirements 7.6**
 */
describe('Feature: email-notifications, Property 10: Timestamp Deep-Link Parsing', () => {

  it('for any non-negative integer N, parseTimestamp("?t=" + N) returns exactly N', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999999 }),
        (n) => {
          const result = Playback.parseTimestamp('?t=' + n);
          expect(result).toBe(n);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any negative integer, parseTimestamp returns 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999999, max: -1 }),
        (n) => {
          const result = Playback.parseTimestamp('?t=' + n);
          expect(result).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any non-numeric string value, parseTimestamp returns 0', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz!@#$%^&*'.split('')), { minLength: 1, maxLength: 20 }),
        (s) => {
          const result = Playback.parseTimestamp('?t=' + s);
          expect(result).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('when ?t= parameter is missing, parseTimestamp returns 0', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '?', '?foo=bar', '?x=1&y=2'),
        (search) => {
          const result = Playback.parseTimestamp(search);
          expect(result).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
