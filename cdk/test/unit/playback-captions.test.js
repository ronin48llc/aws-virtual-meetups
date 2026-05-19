/**
 * Unit tests for Playback module — Captions and Transcript Panel
 * Tests WebVTT parsing, language selector, and transcript panel functionality.
 *
 * Validates: Requirements 7.8, 7.9, 7.10
 */
'use strict';

// Minimal DOM mock for testing the playback module
function createMockDOM() {
  const elements = {};
  const eventListeners = {};

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
        // Simple selector support for testing
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

    // textContent getter/setter that supports _escapeHtml pattern
    Object.defineProperty(el, 'textContent', {
      get() { return el._textContent; },
      set(val) {
        el._textContent = val;
        // Simulate browser behavior: setting textContent updates innerHTML with escaped HTML
        el.innerHTML = String(val || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
    });

    // Make properties settable
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

  // Parse simple HTML into mock elements (for innerHTML assignment)
  function parseHTML(html, parent) {
    // For testing, we use a simpler approach: store innerHTML and provide querySelectorAll
    parent._innerHTML = html;
    parent.children = [];
    parent.childNodes = [];

    // Parse data attributes and classes from the HTML for querySelectorAll
    const divRegex = /<div[^>]*class="([^"]*)"[^>]*data-start="([^"]*)"[^>]*data-end="([^"]*)"[^>]*onclick="([^"]*)"[^>]*>/g;
    let match;
    while ((match = divRegex.exec(html)) !== null) {
      const child = createElement('div');
      child.attributes.class = match[1];
      child.attributes['data-start'] = match[2];
      child.attributes['data-end'] = match[3];
      child.attributes.onclick = match[4];
      parent.children.push(child);
      parent.childNodes.push(child);
      child.parentNode = parent;
    }

    // Parse span elements for timestamp text
    const spanRegex = /<span[^>]*class="transcript-timestamp"[^>]*>([^<]*)<\/span>/g;
    let spanMatch;
    let spanIndex = 0;
    while ((spanMatch = spanRegex.exec(html)) !== null) {
      if (parent.children[spanIndex]) {
        parent.children[spanIndex]._timestampText = spanMatch[1];
      }
      spanIndex++;
    }
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

  // Register elements by ID
  function registerElement(id, el) {
    elements[id] = el;
  }

  return { document: mockDocument, createElement, registerElement, parseHTML };
}

// Set up a full page mock with all required elements
function setupPageMock() {
  const mock = createMockDOM();

  // Create all the elements that renderPage would create
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

  // New elements for captions/transcript
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

describe('Playback Module - Captions and Transcript', () => {
  let Playback;
  let mockDOM;

  beforeEach(() => {
    mockDOM = setupPageMock();

    // Set up global environment
    global.window = { location: { search: '' } };
    global.document = mockDOM.document;
    global.fetch = jest.fn();
    global.URLSearchParams = URLSearchParams;

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
    jest.restoreAllMocks();
  });

  describe('parseWebVTT', () => {
    test('parses valid WebVTT content with HH:MM:SS.mmm format', () => {
      const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Hello, welcome to the session.

2
00:00:04.500 --> 00:00:08.000
Today we will discuss AWS Lambda.`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(2);
      expect(cues[0]).toEqual({
        startTime: 1,
        endTime: 4,
        text: 'Hello, welcome to the session.'
      });
      expect(cues[1]).toEqual({
        startTime: 4.5,
        endTime: 8,
        text: 'Today we will discuss AWS Lambda.'
      });
    });

    test('parses WebVTT with MM:SS.mmm format', () => {
      const vtt = `WEBVTT

01:30.000 --> 02:00.000
This is a shorter timestamp format.`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].startTime).toBe(90);
      expect(cues[0].endTime).toBe(120);
      expect(cues[0].text).toBe('This is a shorter timestamp format.');
    });

    test('handles multi-line cue text', () => {
      const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
First line of text
Second line of text`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('First line of text Second line of text');
    });

    test('strips HTML tags from cue text', () => {
      const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
<b>Bold text</b> and <i>italic</i>`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('Bold text and italic');
    });

    test('handles WebVTT with position metadata after timestamps', () => {
      const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000 position:10% align:start
Text with position metadata.`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].endTime).toBe(5);
      expect(cues[0].text).toBe('Text with position metadata.');
    });

    test('returns empty array for null/undefined input', () => {
      expect(Playback.parseWebVTT(null)).toEqual([]);
      expect(Playback.parseWebVTT(undefined)).toEqual([]);
      expect(Playback.parseWebVTT('')).toEqual([]);
    });

    test('returns empty array for non-string input', () => {
      expect(Playback.parseWebVTT(123)).toEqual([]);
      expect(Playback.parseWebVTT({})).toEqual([]);
    });

    test('handles WebVTT with CRLF line endings', () => {
      const vtt = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:04.000\r\nHello world.\r\n';

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('Hello world.');
    });

    test('parses hours correctly in timestamps', () => {
      const vtt = `WEBVTT

01:30:00.000 --> 01:30:30.000
One hour thirty minutes in.`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].startTime).toBe(5400); // 1*3600 + 30*60
      expect(cues[0].endTime).toBe(5430);
    });

    test('skips cues with empty text', () => {
      const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000


00:00:05.000 --> 00:00:08.000
Valid cue text.`;

      const cues = Playback.parseWebVTT(vtt);

      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('Valid cue text.');
    });
  });

  describe('renderPage - transcript panel HTML', () => {
    test('includes transcript panel container in rendered HTML', () => {
      const html = Playback.renderPage({ id: 'test-event' });

      expect(html).toContain('id="playback-transcript-panel"');
      expect(html).toContain('id="playback-transcript-content"');
      expect(html).toContain('Transcript');
    });

    test('includes language selector in rendered HTML', () => {
      const html = Playback.renderPage({ id: 'test-event' });

      expect(html).toContain('id="playback-language-selector"');
      expect(html).toContain('id="playback-language-select"');
      expect(html).toContain('aria-label="Select caption and transcript language"');
    });

    test('transcript panel has accessible role and label', () => {
      const html = Playback.renderPage({ id: 'test-event' });

      expect(html).toContain('role="list"');
      expect(html).toContain('aria-label="Video transcript with clickable timestamps"');
    });

    test('language selector has label element', () => {
      const html = Playback.renderPage({ id: 'test-event' });

      expect(html).toContain('for="playback-language-select"');
      expect(html).toContain('Language:');
    });
  });

  describe('init - language selector setup', () => {
    function setupHlsMock() {
      const mockHls = { on: jest.fn(), loadSource: jest.fn(), attachMedia: jest.fn(), destroy: jest.fn() };
      const HlsConstructor = jest.fn(() => mockHls);
      HlsConstructor.isSupported = () => true;
      HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
      HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      global.Hls = HlsConstructor;
      return mockHls;
    }

    test('renders language selector when availableLanguages provided', () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello')
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        availableLanguages: [
          { code: 'en', label: 'English', url: '/captions/en.vtt' },
          { code: 'es', label: 'Spanish', url: '/captions/es.vtt' },
          { code: 'fr', label: 'French', url: '/captions/fr.vtt' }
        ]
      });

      const selector = mockDOM.document.getElementById('playback-language-selector');
      expect(selector.style.display).toBe('block');

      const select = mockDOM.document.getElementById('playback-language-select');
      expect(select.innerHTML).toContain('English');
      expect(select.innerHTML).toContain('Spanish');
      expect(select.innerHTML).toContain('French');
    });

    test('fetches caption URL for first language by default', () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello')
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        availableLanguages: [
          { code: 'en', label: 'English', url: '/captions/en.vtt' },
          { code: 'es', label: 'Spanish', url: '/captions/es.vtt' }
        ]
      });

      // Verify fetch was called with the first language URL
      expect(global.fetch).toHaveBeenCalledWith('/captions/en.vtt');
    });

    test('loads transcript from captionUrl when no availableLanguages', () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello')
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/default.vtt'
      });

      // Should fetch the transcript from captionUrl
      expect(global.fetch).toHaveBeenCalledWith('/captions/default.vtt');
    });

    test('shows transcript panel when transcript URL is available', () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello')
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/en.vtt'
      });

      const panel = mockDOM.document.getElementById('playback-transcript-panel');
      expect(panel.style.display).toBe('block');
    });

    test('renders transcript content after fetch resolves', async () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(`WEBVTT

00:00:01.000 --> 00:00:04.000
Hello, welcome.

00:00:05.000 --> 00:00:08.000
Let us begin.`)
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/en.vtt'
      });

      // Wait for fetch promise to resolve
      await new Promise(resolve => setTimeout(resolve, 50));

      const content = mockDOM.document.getElementById('playback-transcript-content');
      expect(content.innerHTML).toContain('transcript-cue');
      expect(content.innerHTML).toContain('Hello, welcome.');
      expect(content.innerHTML).toContain('Let us begin.');
    });

    test('transcript cues include onclick with seekToTranscriptTime', async () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(`WEBVTT

00:00:05.000 --> 00:00:10.000
Test cue text.`)
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/en.vtt'
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const content = mockDOM.document.getElementById('playback-transcript-content');
      expect(content.innerHTML).toContain('Playback.seekToTranscriptTime(5)');
      expect(content.innerHTML).toContain('data-start="5"');
      expect(content.innerHTML).toContain('data-end="10"');
    });

    test('transcript displays formatted timestamps for hour+ durations', async () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(`WEBVTT

01:05:30.000 --> 01:06:00.000
Hour mark cue.`)
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/en.vtt'
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const content = mockDOM.document.getElementById('playback-transcript-content');
      // 1:05:30 format for hour+ timestamps
      expect(content.innerHTML).toContain('1:05:30');
    });

    test('handles transcript fetch failure gracefully', async () => {
      setupHlsMock();
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/missing.vtt'
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const content = mockDOM.document.getElementById('playback-transcript-content');
      expect(content.innerHTML).toContain('Transcript not available');
    });
  });

  describe('seekToTranscriptTime', () => {
    test('seeks video to specified time', () => {
      const mockHls = { on: jest.fn(), loadSource: jest.fn(), attachMedia: jest.fn(), destroy: jest.fn() };
      const HlsConstructor = jest.fn(() => mockHls);
      HlsConstructor.isSupported = () => true;
      HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
      HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      global.Hls = HlsConstructor;

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8'
      });

      const video = mockDOM.document.getElementById('playback-video');
      video.play = jest.fn().mockResolvedValue(undefined);

      Playback.seekToTranscriptTime(45);

      expect(video.currentTime).toBe(45);
    });

    test('does not seek for negative time', () => {
      const mockHls = { on: jest.fn(), loadSource: jest.fn(), attachMedia: jest.fn(), destroy: jest.fn() };
      const HlsConstructor = jest.fn(() => mockHls);
      HlsConstructor.isSupported = () => true;
      HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
      HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      global.Hls = HlsConstructor;

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8'
      });

      const video = mockDOM.document.getElementById('playback-video');
      video.currentTime = 10;
      video.play = jest.fn().mockResolvedValue(undefined);

      Playback.seekToTranscriptTime(-5);

      expect(video.currentTime).toBe(10); // unchanged
    });

    test('does not throw when no video element', () => {
      // Don't init, so no video element is set
      expect(() => Playback.seekToTranscriptTime(30)).not.toThrow();
    });
  });

  describe('caption track loading (Req 7.8)', () => {
    test('adds track element to video when captions loaded', () => {
      const mockHls = { on: jest.fn(), loadSource: jest.fn(), attachMedia: jest.fn(), destroy: jest.fn() };
      const HlsConstructor = jest.fn(() => mockHls);
      HlsConstructor.isSupported = () => true;
      HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
      HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      global.Hls = HlsConstructor;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello')
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        captionUrl: '/captions/en.vtt'
      });

      const video = mockDOM.document.getElementById('playback-video');
      const tracks = video.querySelectorAll('track');

      expect(tracks.length).toBe(1);
      expect(tracks[0].kind).toBe('captions');
      expect(tracks[0].srclang).toBe('en');
      expect(tracks[0].default).toBe(true);
    });

    test('sets correct label and srclang for language-specific captions', () => {
      const mockHls = { on: jest.fn(), loadSource: jest.fn(), attachMedia: jest.fn(), destroy: jest.fn() };
      const HlsConstructor = jest.fn(() => mockHls);
      HlsConstructor.isSupported = () => true;
      HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
      HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      global.Hls = HlsConstructor;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHola')
      });

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8',
        availableLanguages: [
          { code: 'es', label: 'Spanish', url: '/captions/es.vtt' }
        ]
      });

      const video = mockDOM.document.getElementById('playback-video');
      const tracks = video.querySelectorAll('track');

      expect(tracks.length).toBe(1);
      expect(tracks[0].srclang).toBe('es');
      expect(tracks[0].label).toBe('Spanish');
    });
  });

  describe('destroy cleanup', () => {
    test('removes timeupdate listener on destroy', () => {
      const mockHls = { on: jest.fn(), loadSource: jest.fn(), attachMedia: jest.fn(), destroy: jest.fn() };
      const HlsConstructor = jest.fn(() => mockHls);
      HlsConstructor.isSupported = () => true;
      HlsConstructor.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
      HlsConstructor.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      global.Hls = HlsConstructor;

      Playback.init({
        hlsPlaybackUrl: 'https://example.com/video.m3u8'
      });

      const video = mockDOM.document.getElementById('playback-video');
      const originalRemove = video.removeEventListener.bind(video);
      const removeSpy = jest.fn(originalRemove);
      video.removeEventListener = removeSpy;

      Playback.destroy();

      expect(removeSpy).toHaveBeenCalledWith('timeupdate', expect.any(Function));
    });
  });
});
