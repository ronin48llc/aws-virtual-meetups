'use strict';

/**
 * Tests for the frontend i18n module (issue #8).
 *
 * Loads the module under Node (jsdom not strictly required — the module
 * is feature-detecting on `window`/`navigator`/`localStorage`).
 */

/**
 * Reload the module fresh so locale state from a previous test doesn't
 * leak in.
 *
 * @returns {ReturnType<typeof require>}
 */
function loadI18nFresh() {
  jest.resetModules();
  // Module is at /home/akclark/.../frontend/js/i18n.js — outside cdk/
  return require('../../../frontend/js/i18n.js');
}

describe('frontend i18n module (issue #8)', () => {
  describe('t() — lookup and interpolation', () => {
    let I18n;
    beforeEach(() => { I18n = loadI18nFresh(); });

    test('returns the English string for a known key by default', () => {
      I18n.setLocale('en');
      expect(I18n.t('errors.event.createFailed')).toBe('Failed to create event.');
    });

    test('returns the Spanish string when the locale is es', () => {
      I18n.setLocale('es');
      expect(I18n.t('errors.event.createFailed')).toBe('Error al crear el evento.');
    });

    test('interpolates {name} placeholders', () => {
      I18n.setLocale('en');
      expect(I18n.t('errors.event.loadFailed', { detail: 'Network down' }))
        .toBe('Failed to load events: Network down');
    });

    test('leaves unknown placeholders as literal {name} text', () => {
      I18n.setLocale('en');
      expect(I18n.t('errors.event.loadFailed', { other: 'x' }))
        .toBe('Failed to load events: {detail}');
    });

    test('falls back to English when the key is missing in the current locale', () => {
      // Pollute the English dict with a key that only exists there
      I18n._LOCALES.en.tempOnlyEn = 'English-only string';
      I18n.setLocale('es');
      expect(I18n.t('tempOnlyEn')).toBe('English-only string');
      delete I18n._LOCALES.en.tempOnlyEn;
    });

    test('returns the key itself when the key is missing everywhere', () => {
      I18n.setLocale('en');
      expect(I18n.t('does.not.exist')).toBe('does.not.exist');
    });

    test('handles deep dot-notation keys correctly', () => {
      I18n.setLocale('en');
      expect(I18n.t('buttons.signIn')).toBe('Sign In');
      expect(I18n.t('buttons.signUp')).toBe('Sign Up');
    });

    test('does not throw on null/undefined key', () => {
      I18n.setLocale('en');
      expect(I18n.t(null)).toBe(null);
      expect(I18n.t(undefined)).toBe(undefined);
    });
  });

  describe('setLocale() and getLocale()', () => {
    let I18n;
    beforeEach(() => { I18n = loadI18nFresh(); });

    test('setLocale returns true for a known locale and getLocale reflects it', () => {
      expect(I18n.setLocale('es')).toBe(true);
      expect(I18n.getLocale()).toBe('es');
    });

    test('setLocale returns false for an unknown locale and does not change state', () => {
      I18n.setLocale('en');
      expect(I18n.setLocale('klingon')).toBe(false);
      expect(I18n.getLocale()).toBe('en');
    });

    test('setLocale persists to localStorage when available', () => {
      // Provide a fake localStorage on global if jsdom isn't loaded
      const store = {};
      global.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      };
      const Fresh = loadI18nFresh();
      Fresh.setLocale('es');
      expect(store[Fresh._STORAGE_KEY]).toBe('es');
      delete global.localStorage;
    });
  });

  describe('listLocales()', () => {
    test('lists the locales for which a dictionary exists', () => {
      const I18n = loadI18nFresh();
      const locales = I18n.listLocales();
      expect(locales).toContain('en');
      expect(locales).toContain('es');
    });
  });
});
