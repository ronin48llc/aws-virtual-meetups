'use strict';

// i18n.js ships a CommonJS export (with _resetForTests / _STORAGE_KEY hooks),
// so it can be require()'d directly — no realm loader needed.
const I18n = require('../../frontend/js/i18n.js');

describe('I18n', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch (_) { /* ignore */ }
    I18n._resetForTests();
  });

  test('listLocales reports the shipped dictionaries', () => {
    expect(I18n.listLocales().sort()).toEqual(['en', 'es']);
  });

  test('defaults to English in a fresh environment', () => {
    expect(I18n.getLocale()).toBe('en');
    expect(I18n.t('buttons.signIn')).toBe('Sign In');
  });

  test('t() resolves a dot-notation key', () => {
    expect(I18n.t('errors.unknown')).toBe('Unknown error');
  });

  test('t() interpolates {var} placeholders', () => {
    expect(I18n.t('errors.event.loadFailed', { detail: 'boom' }))
      .toBe('Failed to load events: boom');
  });

  test('t() leaves placeholders intact when the var is absent', () => {
    expect(I18n.t('errors.event.loadFailed', {})).toBe('Failed to load events: {detail}');
  });

  test('an unknown key falls back to the key itself', () => {
    expect(I18n.t('nope.not.here')).toBe('nope.not.here');
  });

  test('setLocale switches the active locale, translations, and persists it', () => {
    expect(I18n.setLocale('es')).toBe(true);
    expect(I18n.getLocale()).toBe('es');
    expect(I18n.t('buttons.signIn')).toBe('Iniciar sesión');
    expect(localStorage.getItem(I18n._STORAGE_KEY)).toBe('es');
  });

  test('setLocale rejects an unrecognized locale and stays put', () => {
    expect(I18n.setLocale('zz')).toBe(false);
    expect(I18n.getLocale()).toBe('en');
  });
});
