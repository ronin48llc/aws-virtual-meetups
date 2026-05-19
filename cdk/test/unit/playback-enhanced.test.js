/**
 * Unit tests for Playback module — Enhanced Playback Features
 * Tests video player visibility, hls.js initialization, download/screenshot buttons,
 * timestamp parsing, and event metadata display.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */
'use strict';

// Minimal DOM mock for testing the playback module (same pattern as playback-captions.test.js)
function createMockDOM() {
  const elements = {};

  function createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      childNodes: [],
      attributes: {},
      style: {},
      innerHTML: '',
      _textContent: '',
      parentNode: null,
      _eventListeners: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name] || null; },
      removeAttribute(name) { delete this.attributes[name]; },
      appendChild(child) {
        this.children.push(child);
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter(c => c !== child);
        this.childNodes = this.childNodes.filter(c => c !== child);
        child.parentNode = null;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      },
      querySelectorAll(selector) {
        if (selector === 'track') {
          return this.children.filter(c => c.tagName === 'TRACK');
        }
        if (selector.startsWith('.')) {
          const className = selector.slice(1);
          return findByClass(this, className);
        }
        return [];
      },
      querySelector(selector) {
        const results = this.querySelectorAll(selector);
        return results[0] || null;
      },
      addEventListener(event, handler) {
        if (!this._eventListeners[event]) this._eventListeners[event] = [];
        this._eventListeners[event].push(handler);
      },
      removeEventListener(event, handler) {
        if (this._eventListeners[event]) {
          this._eventListeners[event] = this._eventListeners[event].filter(h => h !== handler);
        }
      },
      dispatchEvent(event) {
        const handlers = this._eventListeners[event.type] || [];
        handlers.forEach(h => h(event));
      },
      canPlayType() { return ''; },
      pause() {},
      load() {},
      play() { return Promise.resolve(); },
      get offsetTop() { return 0; },
      get offsetHeight() { return 30; },
      get clientHeight() { return 300; },
      scrollTop: 0
    };

    Object.defineProperty(el, 'textContent', {
      get() { return el._textContent; },
      set(val) {
        el._textContent = val;
        el.innerHTML = String(val || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
    });

    Object.defineProperty(el, 'kind', { writable: true, value: '' });
    Object.defineProperty(el, 'label', { writable: true, value: '' });
    Object.defineProperty(el, 'srclang', { writable: true, value: '' });
    Object.defineProperty(el, 'src', { writable: true, value: '' });
    Object.defineProperty(el, 'default', { writable: true, value: false });
    Object.defineProperty(el, 'value', { writable: true, value: '' });
    Object.defineProperty(el, 'selected', { writable: true, value: false });
    Object.defineProperty(el, 'currentTime', { writable: true, value: 0 });
    Object.defineProperty(el, 'readyState', { writable: true, value: 0 });
    Object.defineProperty(el, 'onchange', { writable: true, value: null });

    return el;
  }

  function findByClass(el, className) {
    let results = [];
    if (el.attributes && el.attributes.class && el.attributes.class.includes(className)) {
      results.push(el);
    }
    if (el.children) {
      el.children.forEach(child => {
        results = results.concat(findByClass(child, className));
      });
    }
    return results;
  }

  const mockDocument = {
    getElementById(id) {
      return elements[id] || null;
    },
    createElement(tag) {
      return createElement(tag);
    },
    body: createElement('body')
  };

  function registerElement(id, el) {
    elements[id] = el;
  }

  return { document: mockDocument, createElement, registerElement };
}

// Set up a full page mock with all required elements
function setupPageMock() {
  const mock = createMockDOM();

  const videoEl = mock.createElement('video');
  videoEl.textTracks = [];
  mock.registerElement('playback-video', videoEl);

  const playerSection = mock.createElement('div');
  mock.registerElement('playback-player-section', playerSection);

  const noRecording = mock.createElement('div');
  mock.registerElement('playback-no-recording', noRecording);

  const actionsContainer = mock.createElement('div');
  mock.registerElement('playback-actions', actionsContainer);

  const loadingEl = mock.createElement('div');
  mock.registerElement('playback-loading', loadingEl);

  const errorEl = mock.createElement('div');
  mock.registerElement('playback-error', errorEl);

  const titleEl = mock.createElement('h1');
  mock.registerElement('playback-title', titleEl);

  const dateEl = mock.createElement('p');
  mock.registerElement('playback-date', dateEl);

  const descEl = mock.createElement('p');
  mock.registerElement('playback-description', descEl);

  const infoPanel = mock.createElement('div');
  mock.registerElement('playback-info', infoPanel);

  const detailsEl = mock.createElement('div');
  mock.registerElement('playback-details', detailsEl);

  const languageSelector = mock.createElement('div');
  languageSelector.style.display = 'none';
  mock.registerElement('playback-language-selector', languageSelector);

  const languageSelect = mock.createElement('select');
  mock.registerElement('playback-language-select', languageSelect);

  const transcriptPanel = mock.createElement('div');
  transcriptPanel.style.display = 'none';
  mock.registerElement('playback-transcript-panel', transcriptPanel);

  const transcriptContent = mock.createElement('div');
  mock.registerElement('playback-transcript-content', transcriptContent);

  return mock;
}

function setupHlsMock() {
  const mockHls = {
    on: jest.fn(),
    loadSource: jest.fn(),
    attachMedia: jest.fn(),
    destroy: jest.fn()
  };
  const HlsConstructor = jest.fn(() => mockHls);
  HlsConstructor.isSupported = () => true;
  HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
  HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  global.Hls = HlsConstructor;
  return mockHls;
}

describe('Playback Module - Enhanced Playback Features', () => {
  let Playback;
  let mockDOM;

  beforeEach(() => {
    mockDOM = setupPageMock();

    global.window = { location: { search: '' } };
    global.document = mockDOM.document;
    global.fetch = jest.fn();
    global.URLSearchParams = URLSearchParams;
    global.URL = { createObjectURL: jest.fn(() => 'blob:mock'), revokeObjectURL: jest.fn() };

    // Clear module cache and reload
    const modulePath = require.resolve('../../../frontend/js/playback.js');
    delete require.cache[modulePath];

    const mod = require('../../../frontend/js/playback.js');
    Playback = mod.Playback;
  });

  afterEach(() => {
    if (Playback) {
      try { Playback.destroy(); } catch (e) { /* ignore */ }
    }
    delete global.window;
    delete global.document;
    delete global.fetch;
    delete global.Hls;
    delete global.URL;
    jest.restoreAllMocks();
  });

  describe('Video player hidden when no playback URL (Req 7.2)', () => {
    test('hides player section and shows no-recording message when no hlsPlaybackUrl', () => {
      Playback.init({
        title: 'Test Event',
        description: 'A test event'
        // No hlsPlaybackUrl, no hlsUrl, no recordingUrl, no eventId
      });

      const playerSection = mockDOM.document.getElementById('playback-player-section');
      const noRecording = mockDOM.document.getElementById('playback-no-recording');

      expect(playerSection.style.display).toBe('none');
      expect(noRecording.style.display).toBe('block');
    });

    test('hides player section when config has empty hlsPlaybackUrl', () => {
      Playback.init({
        hlsPlaybackUrl: '',
        title: 'Test Event'
      });

      const playerSection = mockDOM.document.getElementById('playback-player-section');
      const noRecording = mockDOM.document.getElementById('playback-no-recording');

      expect(playerSection.style.display).toBe('none');
      expect(noRecording.style.display).toBe('block');
    });
  });

  describe('Video player shown when playback URL present (Req 7.1)', () => {
    test('shows player section when hlsPlaybackUrl is provided', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/recordings/evt123/master.m3u8'
      });

      const playerSection = mockDOM.document.getElementById('playback-player-section');
      const noRecording = mockDOM.document.getElementById('playback-no-recording');

      expect(playerSection.style.display).toBe('block');
      expect(noRecording.style.display).toBe('none');
    });

    test('shows player section when hlsUrl is provided as fallback', () => {
      setupHlsMock();

      Playback.init({
        hlsUrl: 'https://cdn.example.com/recordings/evt456/master.m3u8'
      });

      const playerSection = mockDOM.document.getElementById('playback-player-section');
      expect(playerSection.style.display).toBe('block');
    });

    test('shows player section when recordingUrl is provided as fallback', () => {
      setupHlsMock();

      Playback.init({
        recordingUrl: 'https://cdn.example.com/recordings/evt789/master.m3u8'
      });

      const playerSection = mockDOM.document.getElementById('playback-player-section');
      expect(playerSection.style.display).toBe('block');
    });
  });

  describe('hls.js initialization with correct manifest URL (Req 7.3)', () => {
    test('calls Hls.loadSource with the provided hlsPlaybackUrl', () => {
      const mockHls = setupHlsMock();
      const manifestUrl = 'https://cdn.example.com/recordings/evt123/master.m3u8';

      Playback.init({
        hlsPlaybackUrl: manifestUrl
      });

      expect(mockHls.loadSource).toHaveBeenCalledWith(manifestUrl);
    });

    test('calls Hls.attachMedia with the video element', () => {
      const mockHls = setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8'
      });

      const videoEl = mockDOM.document.getElementById('playback-video');
      expect(mockHls.attachMedia).toHaveBeenCalledWith(videoEl);
    });

    test('registers event handlers for MANIFEST_PARSED and ERROR', () => {
      const mockHls = setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8'
      });

      expect(mockHls.on).toHaveBeenCalledWith('hlsManifestParsed', expect.any(Function));
      expect(mockHls.on).toHaveBeenCalledWith('hlsError', expect.any(Function));
    });

    test('uses native HLS when canPlayType returns truthy', () => {
      // Don't set up Hls mock — simulate native support (Safari/iOS)
      const videoEl = mockDOM.document.getElementById('playback-video');
      videoEl.canPlayType = (type) => type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';

      const manifestUrl = 'https://cdn.example.com/native.m3u8';

      Playback.init({
        hlsPlaybackUrl: manifestUrl
      });

      expect(videoEl.src).toBe(manifestUrl);
    });
  });

  describe('Download button rendered and functional (Req 7.5)', () => {
    test('renders download button with correct href and download attribute', () => {
      setupHlsMock();
      const playbackUrl = 'https://cdn.example.com/recordings/evt123/master.m3u8';

      Playback.init({
        hlsPlaybackUrl: playbackUrl
      });

      const actionsContainer = mockDOM.document.getElementById('playback-actions');
      expect(actionsContainer.innerHTML).toContain('id="playback-download-btn"');
      expect(actionsContainer.innerHTML).toContain('href="' + playbackUrl + '"');
      expect(actionsContainer.innerHTML).toContain('download');
      expect(actionsContainer.innerHTML).toContain('Download Recording');
    });

    test('download button has accessible aria-label', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8'
      });

      const actionsContainer = mockDOM.document.getElementById('playback-actions');
      expect(actionsContainer.innerHTML).toContain('aria-label="Download recording"');
    });

    test('no download button when no playback URL', () => {
      Playback.init({
        title: 'No Recording Event'
      });

      const actionsContainer = mockDOM.document.getElementById('playback-actions');
      expect(actionsContainer.innerHTML).not.toContain('playback-download-btn');
    });
  });

  describe('Screenshot button rendered (Req 7.7)', () => {
    test('renders screenshot button in actions container', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8'
      });

      const actionsContainer = mockDOM.document.getElementById('playback-actions');
      expect(actionsContainer.innerHTML).toContain('id="playback-screenshot-btn"');
      expect(actionsContainer.innerHTML).toContain('Screenshot');
    });

    test('screenshot button has accessible aria-label', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8'
      });

      const actionsContainer = mockDOM.document.getElementById('playback-actions');
      expect(actionsContainer.innerHTML).toContain('aria-label="Capture screenshot of current frame"');
    });

    test('screenshot button calls Playback.captureScreenshot on click', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8'
      });

      const actionsContainer = mockDOM.document.getElementById('playback-actions');
      expect(actionsContainer.innerHTML).toContain('onclick="Playback.captureScreenshot()"');
    });
  });

  describe('Timestamp parameter parsing (Req 7.6)', () => {
    test('parses valid integer timestamp from ?t=120', () => {
      const result = Playback.parseTimestamp('?t=120');
      expect(result).toBe(120);
    });

    test('parses ?t=0 as 0', () => {
      const result = Playback.parseTimestamp('?t=0');
      expect(result).toBe(0);
    });

    test('parses large timestamp values', () => {
      const result = Playback.parseTimestamp('?t=7200');
      expect(result).toBe(7200);
    });

    test('returns 0 for invalid non-numeric value ?t=abc', () => {
      const result = Playback.parseTimestamp('?t=abc');
      expect(result).toBe(0);
    });

    test('returns 0 for negative value ?t=-10', () => {
      const result = Playback.parseTimestamp('?t=-10');
      expect(result).toBe(0);
    });

    test('returns 0 for missing t parameter', () => {
      const result = Playback.parseTimestamp('?other=value');
      expect(result).toBe(0);
    });

    test('returns 0 for empty search string', () => {
      const result = Playback.parseTimestamp('');
      expect(result).toBe(0);
    });

    test('returns 0 for empty t value ?t=', () => {
      const result = Playback.parseTimestamp('?t=');
      expect(result).toBe(0);
    });

    test('floors decimal values ?t=45.7 to integer', () => {
      const result = Playback.parseTimestamp('?t=45.7');
      expect(result).toBe(45);
    });

    test('uses window.location.search when no argument provided', () => {
      global.window.location.search = '?t=300';
      const result = Playback.parseTimestamp();
      expect(result).toBe(300);
    });
  });

  describe('Event metadata displayed (Req 7.4)', () => {
    test('displays event title in the title element', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8',
        title: 'AWS Lambda Deep Dive'
      });

      const titleEl = mockDOM.document.getElementById('playback-title');
      expect(titleEl._textContent).toBe('AWS Lambda Deep Dive');
    });

    test('displays event description in the description element', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8',
        title: 'Test Event',
        description: 'Learn advanced patterns for serverless applications'
      });

      const descEl = mockDOM.document.getElementById('playback-description');
      expect(descEl._textContent).toBe('Learn advanced patterns for serverless applications');
    });

    test('displays formatted date from scheduledStart', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8',
        title: 'Test Event',
        scheduledStart: '2024-03-15T18:00:00Z'
      });

      const dateEl = mockDOM.document.getElementById('playback-date');
      // The date should be formatted and non-empty
      expect(dateEl._textContent).not.toBe('');
      expect(dateEl._textContent.length).toBeGreaterThan(0);
    });

    test('displays formatted date from scheduledStartTime as fallback', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8',
        title: 'Test Event',
        scheduledStartTime: '2024-06-20T14:00:00Z'
      });

      const dateEl = mockDOM.document.getElementById('playback-date');
      expect(dateEl._textContent).not.toBe('');
    });

    test('displays formatted date from date field as fallback', () => {
      setupHlsMock();

      Playback.init({
        hlsPlaybackUrl: 'https://cdn.example.com/video.m3u8',
        title: 'Test Event',
        date: '2024-01-10T09:00:00Z'
      });

      const dateEl = mockDOM.document.getElementById('playback-date');
      expect(dateEl._textContent).not.toBe('');
    });

    test('metadata displayed even when no playback URL (title still shown)', () => {
      Playback.init({
        title: 'Upcoming Event',
        description: 'This event has not been recorded yet',
        scheduledStart: '2024-12-01T10:00:00Z'
      });

      const titleEl = mockDOM.document.getElementById('playback-title');
      const descEl = mockDOM.document.getElementById('playback-description');

      expect(titleEl._textContent).toBe('Upcoming Event');
      expect(descEl._textContent).toBe('This event has not been recorded yet');
    });
  });

  describe('renderPage HTML structure', () => {
    test('includes video element with correct attributes', () => {
      const html = Playback.renderPage({ id: 'evt-123' });

      expect(html).toContain('id="playback-video"');
      expect(html).toContain('controls');
      expect(html).toContain('playsinline');
      expect(html).toContain('crossorigin="anonymous"');
      expect(html).toContain('aria-label="Event recording playback"');
    });

    test('includes no-recording message section', () => {
      const html = Playback.renderPage({ id: 'evt-123' });

      expect(html).toContain('id="playback-no-recording"');
      expect(html).toContain('Recording not yet available');
    });

    test('includes metadata section with title, date, description placeholders', () => {
      const html = Playback.renderPage({ id: 'evt-123' });

      expect(html).toContain('id="playback-title"');
      expect(html).toContain('id="playback-date"');
      expect(html).toContain('id="playback-description"');
    });

    test('includes actions container for download and screenshot buttons', () => {
      const html = Playback.renderPage({ id: 'evt-123' });

      expect(html).toContain('id="playback-actions"');
    });
  });
});
