/**
 * Minimal i18n module for the Virtual Meetup frontend.
 *
 * Issue #8 demonstration scope:
 *   - In-memory locale dictionaries for English (en) and Spanish (es).
 *   - `t(key, vars)` with dot-notation key lookup, optional `{name}`
 *     interpolation, and a sensible fallback chain
 *     (current locale → English → the key itself).
 *   - Locale detection from localStorage → navigator.language → 'en'.
 *   - Tiny enough to load as a single <script>; no build step required.
 *
 * Follow-up work tracked in the PR description:
 *   - Migrate the rest of frontend/js/ off hardcoded English.
 *   - Load locale files lazily so we don't ship every locale to every
 *     user (move dicts to /locales/<code>.json behind fetch()).
 *   - Tie locale to a Cognito custom:locale attribute so the user's
 *     preference follows them across devices.
 */

(function (root) {
  'use strict';

  const LOCALES = {
    en: {
      errors: {
        event: {
          loadFailed: 'Failed to load events: {detail}',
          createFailed: 'Failed to create event.',
          updateFailed: 'Failed to update event.',
          deleteFailed: 'Failed to delete event: {detail}',
          startFailed: 'Failed to start event: {detail}',
          stopFailed: 'Failed to stop event: {detail}',
          signupsLoadFailed: 'Failed to load sign-ups: {detail}',
        },
        unknown: 'Unknown error',
      },
      buttons: {
        signIn: 'Sign In',
        signUp: 'Sign Up',
      },
    },
    es: {
      errors: {
        event: {
          loadFailed: 'Error al cargar eventos: {detail}',
          createFailed: 'Error al crear el evento.',
          updateFailed: 'Error al actualizar el evento.',
          deleteFailed: 'Error al eliminar el evento: {detail}',
          startFailed: 'Error al iniciar el evento: {detail}',
          stopFailed: 'Error al detener el evento: {detail}',
          signupsLoadFailed: 'Error al cargar las inscripciones: {detail}',
        },
        unknown: 'Error desconocido',
      },
      buttons: {
        signIn: 'Iniciar sesión',
        signUp: 'Registrarse',
      },
    },
  };

  const DEFAULT_LOCALE = 'en';
  const STORAGE_KEY = 'vmup_locale';

  /**
   * Walk a dot-notation key (e.g., 'errors.event.loadFailed') through
   * a nested object. Returns undefined if any segment is missing.
   *
   * @param {object} dict
   * @param {string} key
   * @returns {*}
   */
  function lookup(dict, key) {
    if (!dict || !key) return undefined;
    return key.split('.').reduce(function (acc, seg) {
      return acc == null ? undefined : acc[seg];
    }, dict);
  }

  /**
   * Substitute `{name}` placeholders in a template.
   *
   * @param {string} template
   * @param {object} [vars]
   * @returns {string}
   */
  function interpolate(template, vars) {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, function (_, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '{' + name + '}';
    });
  }

  /**
   * Determine the active locale: stored choice → navigator.language root
   * → DEFAULT_LOCALE. Only locales we have a dictionary for are honored.
   *
   * @returns {string}
   */
  function detectLocale() {
    let stored = null;
    try {
      stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    } catch (_) { /* localStorage may be blocked; ignore */ }
    if (stored && LOCALES[stored]) return stored;

    const nav = typeof navigator !== 'undefined' ? navigator.language : '';
    const root = nav ? nav.split('-')[0].toLowerCase() : '';
    if (LOCALES[root]) return root;

    return DEFAULT_LOCALE;
  }

  let currentLocale = detectLocale();

  /**
   * Translate a key under the current locale.
   * Fallback chain: current locale → English → key itself.
   *
   * @param {string} key
   * @param {object} [vars]
   * @returns {string}
   */
  function t(key, vars) {
    const value = lookup(LOCALES[currentLocale], key) ||
                  lookup(LOCALES[DEFAULT_LOCALE], key) ||
                  key;
    return interpolate(value, vars);
  }

  /**
   * Change the active locale. No-op if the locale isn't recognized.
   *
   * @param {string} locale
   * @returns {boolean} whether the change took effect
   */
  function setLocale(locale) {
    if (!LOCALES[locale]) return false;
    currentLocale = locale;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, locale);
    } catch (_) { /* ignore */ }
    return true;
  }

  /**
   * @returns {string} the active locale code (e.g., 'en', 'es')
   */
  function getLocale() {
    return currentLocale;
  }

  /**
   * @returns {string[]} the list of locale codes with a dictionary
   */
  function listLocales() {
    return Object.keys(LOCALES);
  }

  const api = { t, setLocale, getLocale, listLocales };

  if (typeof module !== 'undefined' && module.exports) {
    // Node / Jest
    module.exports = Object.assign({}, api, {
      _LOCALES: LOCALES,
      _STORAGE_KEY: STORAGE_KEY,
      _resetForTests: function () { currentLocale = detectLocale(); },
    });
  }
  // Browser: expose on window
  if (typeof window !== 'undefined') {
    root.I18n = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
