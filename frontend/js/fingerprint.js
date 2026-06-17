/**
 * Fingerprint Module — Browser Signal Collection and Hashing
 *
 * Generates a deterministic browser fingerprint by combining multiple
 * browser-internal signals. Used to distinguish anonymous viewers
 * without exposing personal information.
 */

const Fingerprint = (() => {
  const SESSION_STORAGE_KEY = 'vm_anon_fp';

  /**
   * Collect individual browser signals for fingerprinting.
   * Each signal returns a string value or null if unavailable.
   * @returns {Object} { canvas, webgl, userAgent, screen, timezone, fonts }
   */
  function collectSignals() {
    const signals = {};

    // Canvas fingerprint
    signals.canvas = _getCanvasFingerprint();

    // WebGL renderer
    signals.webgl = _getWebGLRenderer();

    // User agent (always available)
    signals.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null;

    // Screen resolution
    signals.screen = _getScreenResolution();

    // Timezone
    signals.timezone = _getTimezone();

    // Installed fonts
    signals.fonts = _detectFonts();

    return signals;
  }

  /**
   * Generate a browser fingerprint from available signals.
   * Combines at least 3 signals and hashes them into a hex string.
   * Falls back to random ID stored in sessionStorage if < 3 signals available.
   * @returns {Promise<string>} Hex string, minimum 8 characters, truncated to 16
   */
  async function generate() {
    const signals = collectSignals();

    // Count available (non-null) signals
    const availableSignals = Object.values(signals).filter((v) => v !== null);

    if (availableSignals.length < 3) {
      return _getFallbackFingerprint();
    }

    // Combine all available signals into a single string
    const combined = availableSignals.join('|');

    // Hash the combined string
    const fingerprint = await hash(combined);

    // Truncate to 16 hex characters
    return fingerprint.substring(0, 16);
  }

  /**
   * Hash an input string into a hex fingerprint.
   * Uses SubtleCrypto SHA-256 with fallback to simple hash.
   * @param {string} input - Concatenated signal string
   * @returns {Promise<string>} Hex hash string (64 chars from SHA-256, or 16 from fallback)
   */
  async function hash(input) {
    // Try SubtleCrypto SHA-256
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(input);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        // Fall through to simple hash
      }
    }

    // Fallback: simple hash for environments without SubtleCrypto
    return _simpleHash(input);
  }

  // --- Private helpers ---

  /**
   * Generate a canvas fingerprint by rendering text and shapes.
   * @returns {string|null} Data URL string or null if unavailable
   */
  function _getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 50;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Draw text with specific styling
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('VirtualMeetup', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('anonymous', 4, 35);

      return canvas.toDataURL();
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the WebGL renderer string from the debug info extension.
   * @returns {string|null} Renderer string or null if unavailable
   */
  function _getWebGLRenderer() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return null;

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (!debugInfo) return null;

      const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      return renderer || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get screen resolution including color depth.
   * @returns {string|null} Resolution string or null if unavailable
   */
  function _getScreenResolution() {
    try {
      if (typeof screen === 'undefined') return null;
      return `${screen.width}x${screen.height}x${screen.colorDepth}`;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get the browser timezone.
   * @returns {string|null} Timezone string or null if unavailable
   */
  function _getTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Detect installed fonts by measuring text width differences.
   * @returns {string|null} Comma-separated list of detected fonts or null
   */
  function _detectFonts() {
    try {
      const testFonts = [
        'Arial', 'Verdana', 'Times New Roman', 'Courier New',
        'Georgia', 'Palatino', 'Garamond', 'Comic Sans MS',
        'Impact', 'Lucida Console',
      ];

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const testString = 'mmmmmmmmmmlli';
      const baseFont = 'monospace';
      ctx.font = `72px ${baseFont}`;
      const baseWidth = ctx.measureText(testString).width;

      const detected = [];
      for (const font of testFonts) {
        ctx.font = `72px '${font}', ${baseFont}`;
        const width = ctx.measureText(testString).width;
        if (width !== baseWidth) {
          detected.push(font);
        }
      }

      return detected.length > 0 ? detected.join(',') : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get or generate a fallback fingerprint stored in sessionStorage.
   * Used when fewer than 3 signals are available.
   * @returns {string} Random UUID hex string (16 chars)
   */
  function _getFallbackFingerprint() {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored && stored.length >= 8) {
        return stored;
      }
    } catch (e) {
      // sessionStorage may not be available
    }

    // Generate a random UUID-like hex string
    const fp = _generateRandomHex(16);

    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, fp);
    } catch (e) {
      // Ignore storage errors
    }

    return fp;
  }

  /**
   * Generate a random hex string of the specified length.
   * @param {number} length - Number of hex characters
   * @returns {string} Random hex string
   */
  function _generateRandomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      // Fallback for environments without crypto.getRandomValues
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .substring(0, length);
  }

  /**
   * Simple hash function fallback for environments without SubtleCrypto.
   * Produces a 16-character hex string.
   * @param {string} input - String to hash
   * @returns {string} 16-character hex hash
   */
  function _simpleHash(input) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;

    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
    const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');

    return hex1 + hex2;
  }

  // Public API
  return { generate, collectSignals };
})();
