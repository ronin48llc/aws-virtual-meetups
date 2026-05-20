/**
 * Playback Module — Recording Playback with hls.js
 *
 * Provides HLS video playback for recorded event sessions:
 * - hls.js integration for HLS stream playback
 * - Caption/subtitle track loading from WebVTT files
 * - Multi-language caption support with language selector
 * - Full transcript panel with clickable timestamps
 * - Event metadata display (title, description, date)
 * - Download button for recording file
 * - Screenshot button (canvas capture of current frame)
 * - Deep-link timestamp support (?t=120 seeks to 2:00)
 * - Conditional rendering based on hlsPlaybackUrl presence
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10
 */

const Playback = (() => {
  'use strict';

  // --- State ---
  let hlsInstance = null;
  let videoElement = null;
  let currentEventData = null;
  let currentLanguage = null;
  let availableLanguages = [];
  let transcriptCues = [];
  let timeUpdateHandler = null;

  // --- Timestamp Parsing ---

  /**
   * Parse the ?t= URL parameter for deep-link timestamp support.
   * Returns the number of seconds to seek to, or 0 if invalid/missing.
   * Req 7.6: Support deep linking to a specific timestamp via URL parameter.
   * @param {string} [search] - URL search string (defaults to window.location.search)
   * @returns {number} Seconds to seek to (non-negative integer, defaults to 0)
   */
  function parseTimestamp(search) {
    var searchStr = (typeof search === 'string') ? search : (typeof window !== 'undefined' ? window.location.search : '');
    var params;
    try {
      params = new URLSearchParams(searchStr);
    } catch (e) {
      return 0;
    }
    var tValue = params.get('t');
    if (tValue === null || tValue === '') {
      return 0;
    }
    var parsed = parseInt(tValue, 10);
    if (isNaN(parsed) || parsed < 0) {
      return 0;
    }
    return Math.floor(parsed);
  }

  // --- Page Rendering ---

  /**
   * Render the playback page for a recorded event.
   * Req 7.2: Only show video player section when hlsPlaybackUrl is present.
   * Req 7.4: Display event title, description, and scheduled start time alongside the video player.
   * @param {object} params - { id } event ID from route
   * @returns {string} HTML string
   */
  function renderPage(params) {
    var eventId = params.id || '';

    return '<div class="page-content">' +
      '<div class="container" style="max-width: 960px; margin: 0 auto;">' +
        // Metadata section
        '<div id="playback-metadata" style="margin-bottom: 24px;">' +
          '<h1 id="playback-title" style="margin-bottom: 8px;">Loading recording...</h1>' +
          '<p id="playback-date" class="text-muted" style="margin-bottom: 8px;"></p>' +
          '<p id="playback-description" style="color: #4a5568; line-height: 1.6;"></p>' +
        '</div>' +

        // Video player section (conditionally shown)
        '<div id="playback-player-section">' +
          '<div id="playback-player-container" style="position: relative; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9;">' +
            '<video id="playback-video" ' +
              'controls ' +
              'playsinline ' +
              'crossorigin="anonymous" ' +
              'style="width: 100%; height: 100%; display: block;" ' +
              'aria-label="Event recording playback">' +
              '<p>Your browser does not support HTML5 video.</p>' +
            '</video>' +
            '<div id="playback-loading" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; font-size: 14px;">Loading player...</div>' +
          '</div>' +

          // Action buttons (download + screenshot)
          '<div id="playback-actions" style="display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap;">' +
          '</div>' +

          // Language selector (Req 7.9)
          '<div id="playback-language-selector" style="display: none; margin-top: 12px;">' +
            '<label for="playback-language-select" style="font-size: 14px; font-weight: 500; margin-right: 8px; color: #4a5568;">Language:</label>' +
            '<select id="playback-language-select" ' +
              'style="padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; background: #fff; color: #1a202c;" ' +
              'aria-label="Select caption and transcript language">' +
            '</select>' +
          '</div>' +

          // Transcript panel (Req 7.10)
          '<div id="playback-transcript-panel" style="display: none; margin-top: 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">' +
            '<div style="padding: 12px 16px; background: #f7fafc; border-bottom: 1px solid #e2e8f0;">' +
              '<h3 style="margin: 0; font-size: 16px; color: #2d3748;">Transcript</h3>' +
            '</div>' +
            '<div id="playback-transcript-content" ' +
              'style="max-height: 300px; overflow-y: auto; padding: 12px 16px;" ' +
              'role="list" ' +
              'aria-label="Video transcript with clickable timestamps">' +
              '<p style="color: #8b949e; font-size: 14px;">Loading transcript...</p>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // No recording message (shown when no playback URL)
        '<div id="playback-no-recording" style="display: none; margin-top: 24px; padding: 24px; background: #f8f9fa; border-radius: 8px; text-align: center;">' +
          '<p style="color: #5a6b7b; font-size: 16px;">Recording not yet available</p>' +
          '<p style="color: #8b949e; font-size: 14px; margin-top: 8px;">The recording will appear here once it has been processed.</p>' +
        '</div>' +

        // Player error
        '<div id="playback-error" style="display: none; margin-top: 12px; padding: 12px 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; color: #991b1b;"></div>' +

        // Event info below player
        '<div id="playback-info" style="margin-top: 24px; padding: 20px; background: #f8f9fa; border-radius: 8px; display: none;">' +
          '<h3 style="margin-bottom: 12px;">About this recording</h3>' +
          '<div id="playback-details"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /**
   * Initialize the playback page after DOM insertion.
   * Loads event metadata and sets up the HLS player.
   * @param {object} config - { eventId, hlsUrl, hlsPlaybackUrl, captionUrl, title, description, date, scheduledStart, scheduledStartTime }
   */
  function init(config) {
    if (!config) {
      _showError('No playback configuration provided.');
      return;
    }

    currentEventData = config;
    videoElement = document.getElementById('playback-video');

    if (!videoElement) {
      console.error('Playback: video element not found');
      return;
    }

    // Display metadata
    _renderMetadata(config);

    // Determine the playback URL
    var playbackUrl = config.hlsPlaybackUrl || config.hlsUrl || config.recordingUrl || null;

    if (playbackUrl) {
      // Req 7.1: Show video player when playback URL is present
      _showPlayerSection();
      _initHls(playbackUrl);
      _renderActionButtons(playbackUrl);
    } else if (config.eventId) {
      // Load metadata from API then init player
      _loadEventData(config.eventId);
    } else {
      // Req 7.2: Hide player when no playback URL
      _hidePlayerSection();
    }

    // Load captions if available
    if (config.captionUrl) {
      _loadCaptions(config.captionUrl);
    }

    // Set up language selector and transcript panel (Req 7.9, 7.10)
    if (config.availableLanguages && config.availableLanguages.length > 0) {
      availableLanguages = config.availableLanguages;
      currentLanguage = availableLanguages[0].code || availableLanguages[0];
      _renderLanguageSelector();
      _loadCaptionsForLanguage(currentLanguage);
    } else if (config.captionUrl) {
      // Single language — load transcript from the caption URL
      _loadTranscript(config.captionUrl);
    }

    // Set up timeupdate listener for transcript highlighting
    _setupTimeUpdateListener();
  }

  /**
   * Destroy the player and clean up resources.
   */
  function destroy() {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    if (videoElement) {
      if (timeUpdateHandler) {
        videoElement.removeEventListener('timeupdate', timeUpdateHandler);
        timeUpdateHandler = null;
      }
      videoElement.pause();
      videoElement.removeAttribute('src');
      videoElement.load();
      videoElement = null;
    }
    currentEventData = null;
    currentLanguage = null;
    availableLanguages = [];
    transcriptCues = [];
  }

  /**
   * Load captions/subtitles from a WebVTT URL.
   * @param {string} captionUrl - URL to the WebVTT file
   * @param {string} [label] - Track label (default: 'English')
   * @param {string} [srclang] - Language code (default: 'en')
   */
  function loadCaptions(captionUrl, label, srclang) {
    _loadCaptions(captionUrl, label, srclang);
  }

  // --- Private Methods ---

  /**
   * Build and validate URLs to prevent SSRF attacks.
   * @param {string} baseUrl - Base URL to validate and use
   * @param {string} [pathSegment] - Optional path segment to append
   * @returns {string} Validated URL
   */
  function buildValidatedUrl(baseUrl, pathSegment) {
    try {
      // Minimal path validation
      if (baseUrl.includes('/../') || /\/%2e%2e\//i.test(baseUrl)) {
        throw new Error('Invalid path');
      }
      
      const url = new URL(baseUrl);
      
      // Protocol + host checks
      const allowedDomains = ['localhost', '127.0.0.1'];
      if (!allowedDomains.includes(url.hostname)) {
        throw new Error('Invalid host');
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid protocol');
      }
      
      // Validate path parameter if provided
      if (pathSegment) {
        if (!/^[A-Za-z0-9_-]+$/.test(pathSegment)) {
          throw new Error('Invalid parameter');
        }
        url.pathname = url.pathname + '/events/' + pathSegment;
      }
      
      return url.href;
    } catch {
      throw new Error('Invalid URL');
    }
  }

  /**
   * Show the video player section and hide the "no recording" message.
   */
  function _showPlayerSection() {
    var playerSection = document.getElementById('playback-player-section');
    var noRecording = document.getElementById('playback-no-recording');
    if (playerSection) playerSection.style.display = 'block';
    if (noRecording) noRecording.style.display = 'none';
  }

  /**
   * Hide the video player section and show the "no recording" message.
   * Req 7.2: Do not display the video player section when no playback URL.
   */
  function _hidePlayerSection() {
    var playerSection = document.getElementById('playback-player-section');
    var noRecording = document.getElementById('playback-no-recording');
    if (playerSection) playerSection.style.display = 'none';
    if (noRecording) noRecording.style.display = 'block';
  }

  /**
   * Render download and screenshot action buttons.
   * Req 7.5: Provide a download button for the recording file.
   * Req 7.7: Provide a screenshot button that captures current frame as PNG.
   * @param {string} playbackUrl - The recording URL for download
   */
  function _renderActionButtons(playbackUrl) {
    var actionsContainer = document.getElementById('playback-actions');
    if (!actionsContainer) return;

    var html = '';

    // Download button
    html += '<a id="playback-download-btn" ' +
      'href="' + _escapeHtml(playbackUrl) + '" ' +
      'download ' +
      'class="btn btn--secondary" ' +
      'style="text-decoration: none; display: inline-flex; align-items: center; gap: 6px;" ' +
      'aria-label="Download recording">' +
      '<span aria-hidden="true">⬇</span> Download Recording' +
    '</a>';

    // Screenshot button
    html += '<button id="playback-screenshot-btn" ' +
      'class="btn btn--outline" ' +
      'style="display: inline-flex; align-items: center; gap: 6px;" ' +
      'onclick="Playback.captureScreenshot()" ' +
      'aria-label="Capture screenshot of current frame">' +
      '<span aria-hidden="true">📷</span> Screenshot' +
    '</button>';

    actionsContainer.innerHTML = html;
  }

  /**
   * Capture the current video frame as a PNG and trigger download.
   * Req 7.7: Capture current video frame and download as PNG image.
   */
  function captureScreenshot() {
    if (!videoElement) {
      console.warn('Playback: No video element for screenshot');
      return;
    }

    if (videoElement.readyState < 2) {
      console.warn('Playback: Video not ready for screenshot');
      return;
    }

    var canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth || videoElement.clientWidth;
    canvas.height = videoElement.videoHeight || videoElement.clientHeight;

    var ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    var timestamp = Math.floor(videoElement.currentTime || 0);
    var filename = 'screenshot-' + timestamp + '.png';

    // Convert to blob and download
    try {
      canvas.toBlob(function(blob) {
        if (!blob) {
          console.warn('Playback: Failed to create screenshot blob');
          return;
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');
    } catch (e) {
      console.error('Playback: Screenshot failed', e);
    }
  }

  /**
   * Seek the video to the timestamp specified in the URL ?t= parameter.
   * Req 7.6: Support deep linking to a specific timestamp.
   */
  function _seekToTimestamp() {
    var seconds = parseTimestamp();
    if (seconds > 0 && videoElement) {
      videoElement.currentTime = seconds;
    }
  }

  /**
   * Initialize hls.js for HLS playback.
   * Req 7.3: Display recording using HLS-compatible player (hls.js).
   * @param {string} hlsUrl - The HLS manifest URL (.m3u8)
   */
  function _initHls(hlsUrl) {
    _hideLoading();

    // Check for native HLS support (Safari, iOS)
    if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = hlsUrl;
      videoElement.addEventListener('loadedmetadata', function() {
        console.log('Playback: Native HLS loaded');
        _seekToTimestamp();
      });
      videoElement.addEventListener('error', function() {
        _showError('Failed to load the recording. The video may not be available yet.');
      });
      return;
    }

    // Use hls.js for browsers without native HLS support
    if (typeof Hls === 'undefined') {
      _showError('HLS player library not loaded. Please reload the page.');
      console.error('Playback: hls.js not available');
      return;
    }

    if (!Hls.isSupported()) {
      _showError('Your browser does not support HLS playback. Please use a modern browser.');
      return;
    }

    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 60
    });

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
      console.log('Playback: HLS manifest parsed, levels:', data.levels.length);
      _hideLoading();
      _seekToTimestamp();
    });

    hlsInstance.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.error('Playback: Network error', data);
            _showError('Network error loading the recording. Please check your connection and try again.');
            hlsInstance.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.error('Playback: Media error', data);
            hlsInstance.recoverMediaError();
            break;
          default:
            console.error('Playback: Fatal error', data);
            _showError('Failed to play the recording. Please try again later.');
            hlsInstance.destroy();
            hlsInstance = null;
            break;
        }
      }
    });

    hlsInstance.loadSource(hlsUrl);
    hlsInstance.attachMedia(videoElement);
  }

  /**
   * Load event data from the API.
   * @param {string} eventId - Event ID to load
   */
  async function _loadEventData(eventId) {
    var apiBase = window.API_BASE_URL || '/api';

    try {
      var validatedUrl = buildValidatedUrl(apiBase, eventId);
      var response = await fetch(validatedUrl);
      if (!response.ok) {
        throw new Error('Event not found');
      }

      var data = await response.json();
      currentEventData = data;
      _renderMetadata(data);

      // Determine playback URL
      var playbackUrl = data.hlsPlaybackUrl || data.recordingUrl || data.hlsUrl || null;

      if (playbackUrl) {
        _showPlayerSection();
        _initHls(playbackUrl);
        _renderActionButtons(playbackUrl);
      } else {
        // Req 7.2: Hide player when no playback URL
        _hidePlayerSection();
      }

      if (data.captionUrl || data.webvttUrl) {
        _loadCaptions(data.captionUrl || data.webvttUrl);
      }
    } catch (err) {
      _showError('Failed to load event data: ' + (err.message || 'Unknown error'));
    }
  }

  /**
   * Load WebVTT captions onto the video element.
   * @param {string} url - WebVTT file URL
   * @param {string} [label] - Track label
   * @param {string} [srclang] - Language code
   */
  function _loadCaptions(url, label, srclang) {
    if (!videoElement || !url) return;

    // Remove existing caption tracks
    var existingTracks = videoElement.querySelectorAll('track');
    for (var i = 0; i < existingTracks.length; i++) {
      existingTracks[i].remove();
    }

    var track = document.createElement('track');
    track.kind = 'captions';
    track.label = label || 'English';
    track.srclang = srclang || 'en';
    track.src = url;
    track.default = true;

    videoElement.appendChild(track);

    // Enable the track once loaded
    track.addEventListener('load', function() {
      console.log('Playback: Captions loaded');
      if (videoElement.textTracks && videoElement.textTracks.length > 0) {
        videoElement.textTracks[0].mode = 'showing';
      }
    });

    track.addEventListener('error', function() {
      console.warn('Playback: Failed to load captions from', url);
    });
  }

  // --- Language Selector and Transcript (Req 7.8, 7.9, 7.10) ---

  /**
   * Render the language selector dropdown populated from availableLanguages.
   * Req 7.9: Provide a language selector for captions and transcripts.
   */
  function _renderLanguageSelector() {
    var selectorContainer = document.getElementById('playback-language-selector');
    var selectEl = document.getElementById('playback-language-select');
    if (!selectorContainer || !selectEl) return;

    if (availableLanguages.length === 0) {
      selectorContainer.style.display = 'none';
      return;
    }

    var html = '';
    for (var i = 0; i < availableLanguages.length; i++) {
      var lang = availableLanguages[i];
      var code = lang.code || lang;
      var label = lang.label || lang.name || code;
      var selected = (code === currentLanguage) ? ' selected' : '';
      html += '<option value="' + _escapeHtml(code) + '"' + selected + '>' + _escapeHtml(label) + '</option>';
    }
    selectEl.innerHTML = html;
    selectorContainer.style.display = 'block';

    // Attach change handler
    selectEl.onchange = function() {
      var selectedCode = selectEl.value;
      if (selectedCode !== currentLanguage) {
        currentLanguage = selectedCode;
        _loadCaptionsForLanguage(selectedCode);
      }
    };
  }

  /**
   * Load captions and transcript for a specific language.
   * Builds the caption URL from the language code using the captionUrlTemplate or availableLanguages url.
   * @param {string} langCode - Language code (e.g., 'en', 'es', 'fr')
   */
  function _loadCaptionsForLanguage(langCode) {
    var captionUrl = _getCaptionUrlForLanguage(langCode);
    if (!captionUrl) {
      console.warn('Playback: No caption URL for language', langCode);
      return;
    }

    // Find the label for this language
    var label = langCode;
    for (var i = 0; i < availableLanguages.length; i++) {
      var lang = availableLanguages[i];
      if ((lang.code || lang) === langCode) {
        label = lang.label || lang.name || langCode;
        break;
      }
    }

    // Load the caption track on the video element (Req 7.8)
    _loadCaptions(captionUrl, label, langCode);

    // Load the transcript panel content (Req 7.10)
    _loadTranscript(captionUrl);
  }

  /**
   * Get the caption URL for a given language code.
   * Checks availableLanguages array for a url property, or uses captionUrlTemplate.
   * @param {string} langCode - Language code
   * @returns {string|null} Caption URL or null
   */
  function _getCaptionUrlForLanguage(langCode) {
    // Check if the language entry has a direct URL
    for (var i = 0; i < availableLanguages.length; i++) {
      var lang = availableLanguages[i];
      if ((lang.code || lang) === langCode && lang.url) {
        return lang.url;
      }
    }

    // Use captionUrlTemplate if available (e.g., '/captions/{lang}.vtt')
    if (currentEventData && currentEventData.captionUrlTemplate) {
      return currentEventData.captionUrlTemplate.replace('{lang}', langCode);
    }

    // Fallback: use captionUrl with language suffix
    if (currentEventData && currentEventData.captionUrl) {
      var baseUrl = currentEventData.captionUrl;
      // Replace the filename to include language code
      var lastDot = baseUrl.lastIndexOf('.');
      if (lastDot > 0) {
        return baseUrl.substring(0, lastDot) + '.' + langCode + baseUrl.substring(lastDot);
      }
    }

    return null;
  }

  /**
   * Load and parse a WebVTT file to populate the transcript panel.
   * Req 7.10: Display a full transcript panel with clickable timestamps.
   * @param {string} url - WebVTT file URL
   */
  function _loadTranscript(url) {
    if (!url) return;

    var transcriptPanel = document.getElementById('playback-transcript-panel');
    if (transcriptPanel) {
      transcriptPanel.style.display = 'block';
    }

    // Fetch and parse the WebVTT file
    var validatedUrl = buildValidatedUrl(url);
    fetch(validatedUrl)
      .then(function(response) {
        if (!response.ok) {
          throw new Error('Failed to fetch transcript');
        }
        return response.text();
      })
      .then(function(vttContent) {
        transcriptCues = _parseWebVTT(vttContent);
        _renderTranscript(transcriptCues);
      })
      .catch(function(err) {
        console.warn('Playback: Failed to load transcript from', url, err);
        var contentEl = document.getElementById('playback-transcript-content');
        if (contentEl) {
          contentEl.innerHTML = '<p style="color: #8b949e; font-size: 14px;">Transcript not available.</p>';
        }
      });
  }

  /**
   * Parse WebVTT content into an array of cue objects.
   * @param {string} vttContent - Raw WebVTT file content
   * @returns {Array<{startTime: number, endTime: number, text: string}>} Parsed cues
   */
  function parseWebVTT(vttContent) {
    return _parseWebVTT(vttContent);
  }

  /**
   * Internal WebVTT parser.
   * @param {string} vttContent - Raw WebVTT file content
   * @returns {Array<{startTime: number, endTime: number, text: string}>} Parsed cues
   */
  function _parseWebVTT(vttContent) {
    if (!vttContent || typeof vttContent !== 'string') return [];

    var cues = [];
    var lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var i = 0;

    // Skip the WEBVTT header and any metadata
    while (i < lines.length && lines[i].indexOf('-->') === -1) {
      i++;
    }

    while (i < lines.length) {
      var line = lines[i].trim();

      // Look for timestamp lines (e.g., "00:00:01.000 --> 00:00:04.000")
      if (line.indexOf('-->') !== -1) {
        var times = line.split('-->');
        if (times.length === 2) {
          var startTime = _parseVTTTimestamp(times[0].trim());
          var endTime = _parseVTTTimestamp(times[1].trim().split(' ')[0]); // Remove position metadata

          // Collect text lines until empty line or end
          var textLines = [];
          i++;
          while (i < lines.length && lines[i].trim() !== '') {
            textLines.push(lines[i].trim());
            i++;
          }

          var text = textLines.join(' ').replace(/<[^>]+>/g, ''); // Strip HTML tags
          if (text && startTime >= 0 && endTime >= 0) {
            cues.push({
              startTime: startTime,
              endTime: endTime,
              text: text
            });
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return cues;
  }

  /**
   * Parse a VTT timestamp string to seconds.
   * Supports formats: "HH:MM:SS.mmm", "MM:SS.mmm", "HH:MM:SS"
   * @param {string} timestamp - VTT timestamp string
   * @returns {number} Time in seconds
   */
  function _parseVTTTimestamp(timestamp) {
    if (!timestamp) return -1;

    var parts = timestamp.split(':');
    var seconds = 0;

    try {
      if (parts.length === 3) {
        // HH:MM:SS.mmm
        seconds = parseInt(parts[0], 10) * 3600 +
                  parseInt(parts[1], 10) * 60 +
                  parseFloat(parts[2]);
      } else if (parts.length === 2) {
        // MM:SS.mmm
        seconds = parseInt(parts[0], 10) * 60 +
                  parseFloat(parts[1]);
      } else {
        return -1;
      }
    } catch (e) {
      return -1;
    }

    return isNaN(seconds) ? -1 : seconds;
  }

  /**
   * Render the transcript panel with clickable timestamps.
   * Req 7.10: Clickable timestamps that seek video to corresponding position.
   * @param {Array} cues - Parsed cue objects
   */
  function _renderTranscript(cues) {
    var contentEl = document.getElementById('playback-transcript-content');
    if (!contentEl) return;

    if (!cues || cues.length === 0) {
      contentEl.innerHTML = '<p style="color: #8b949e; font-size: 14px;">No transcript content available.</p>';
      return;
    }

    var html = '';
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var timeStr = _formatTimestampDisplay(cue.startTime);
      html += '<div class="transcript-cue" ' +
        'role="listitem" ' +
        'data-start="' + cue.startTime + '" ' +
        'data-end="' + cue.endTime + '" ' +
        'style="display: flex; gap: 12px; padding: 8px 4px; border-radius: 4px; cursor: pointer; transition: background 0.15s;" ' +
        'onclick="Playback.seekToTranscriptTime(' + cue.startTime + ')">' +
        '<span class="transcript-timestamp" ' +
          'style="flex-shrink: 0; font-family: monospace; font-size: 13px; color: #3182ce; font-weight: 500; min-width: 60px;" ' +
          'aria-label="Seek to ' + timeStr + '">' +
          timeStr +
        '</span>' +
        '<span class="transcript-text" style="font-size: 14px; color: #2d3748; line-height: 1.5;">' +
          _escapeHtml(cue.text) +
        '</span>' +
      '</div>';
    }

    contentEl.innerHTML = html;
  }

  /**
   * Seek the video to a specific time from a transcript timestamp click.
   * Req 7.10: Clickable timestamps that seek video to corresponding position.
   * @param {number} seconds - Time in seconds to seek to
   */
  function seekToTranscriptTime(seconds) {
    if (videoElement && typeof seconds === 'number' && seconds >= 0) {
      videoElement.currentTime = seconds;
      videoElement.play().catch(function() {
        // Autoplay may be blocked; that's fine
      });
    }
  }

  /**
   * Set up the timeupdate listener to highlight the active transcript cue.
   * Req 7.10: Highlight the currently active segment during playback.
   */
  function _setupTimeUpdateListener() {
    if (!videoElement) return;

    timeUpdateHandler = function() {
      _highlightActiveCue(videoElement.currentTime);
    };

    videoElement.addEventListener('timeupdate', timeUpdateHandler);
  }

  /**
   * Highlight the currently active transcript cue based on video currentTime.
   * @param {number} currentTime - Current video playback time in seconds
   */
  function _highlightActiveCue(currentTime) {
    var contentEl = document.getElementById('playback-transcript-content');
    if (!contentEl || transcriptCues.length === 0) return;

    var cueElements = contentEl.querySelectorAll('.transcript-cue');
    for (var i = 0; i < cueElements.length; i++) {
      var el = cueElements[i];
      var start = parseFloat(el.getAttribute('data-start'));
      var end = parseFloat(el.getAttribute('data-end'));

      if (currentTime >= start && currentTime < end) {
        el.style.background = '#ebf8ff';
        el.setAttribute('aria-current', 'true');
        // Scroll into view if not visible
        _scrollIntoViewIfNeeded(el, contentEl);
      } else {
        el.style.background = 'transparent';
        el.removeAttribute('aria-current');
      }
    }
  }

  /**
   * Scroll an element into view within its scrollable container if needed.
   * @param {HTMLElement} el - Element to scroll into view
   * @param {HTMLElement} container - Scrollable container
   */
  function _scrollIntoViewIfNeeded(el, container) {
    var elTop = el.offsetTop - container.offsetTop;
    var elBottom = elTop + el.offsetHeight;
    var containerTop = container.scrollTop;
    var containerBottom = containerTop + container.clientHeight;

    if (elTop < containerTop) {
      container.scrollTop = elTop;
    } else if (elBottom > containerBottom) {
      container.scrollTop = elBottom - container.clientHeight;
    }
  }

  /**
   * Format seconds into a display timestamp (MM:SS or HH:MM:SS).
   * @param {number} seconds - Time in seconds
   * @returns {string} Formatted timestamp
   */
  function _formatTimestampDisplay(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);

    if (h > 0) {
      return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /**
   * Render event metadata in the page.
   * Req 7.4: Display event title, description, and scheduled start time alongside the video player.
   * @param {object} data - Event data
   */
  function _renderMetadata(data) {
    if (!data) return;

    var titleEl = document.getElementById('playback-title');
    var dateEl = document.getElementById('playback-date');
    var descEl = document.getElementById('playback-description');
    var infoPanel = document.getElementById('playback-info');
    var detailsEl = document.getElementById('playback-details');

    if (titleEl && data.title) {
      titleEl.textContent = data.title;
    }

    if (dateEl) {
      var dateStr = '';
      if (data.scheduledStart) {
        dateStr = _formatPlaybackDate(data.scheduledStart);
      } else if (data.scheduledStartTime) {
        dateStr = _formatPlaybackDate(data.scheduledStartTime);
      } else if (data.date) {
        dateStr = _formatPlaybackDate(data.date);
      }
      if (dateStr) {
        dateEl.textContent = dateStr;
      }
    }

    if (descEl && data.description) {
      descEl.textContent = data.description;
    }

    // Show additional info panel if we have extra metadata
    if (infoPanel && detailsEl && (data.duration || data.presenter || data.attendeeCount)) {
      var details = '';
      if (data.presenter) {
        details += '<p><strong>Presenter:</strong> ' + _escapeHtml(data.presenter) + '</p>';
      }
      if (data.duration) {
        details += '<p><strong>Duration:</strong> ' + _formatDuration(data.duration) + '</p>';
      }
      if (data.attendeeCount) {
        details += '<p><strong>Attendees:</strong> ' + data.attendeeCount + '</p>';
      }
      detailsEl.innerHTML = details;
      infoPanel.style.display = 'block';
    }
  }

  /**
   * Format a date for display on the playback page.
   * @param {string} isoDate - ISO 8601 date string
   * @returns {string} Human-readable date string
   */
  function _formatPlaybackDate(isoDate) {
    if (!isoDate) return '';
    try {
      var d = new Date(isoDate);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      });
    } catch (e) {
      return '';
    }
  }

  /**
   * Show an error message to the user.
   * @param {string} message - Error message
   */
  function _showError(message) {
    _hideLoading();
    var errorEl = document.getElementById('playback-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }

  /**
   * Hide the loading indicator.
   */
  function _hideLoading() {
    var loadingEl = document.getElementById('playback-loading');
    if (loadingEl) {
      loadingEl.style.display = 'none';
    }
  }

  /**
   * Format a duration in seconds to a human-readable string.
   * @param {number} seconds - Duration in seconds
   * @returns {string} Formatted duration
   */
  function _formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0:00';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);

    if (h > 0) {
      return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /**
   * Escape HTML entities.
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  function _escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // --- Public API ---
  return {
    renderPage: renderPage,
    init: init,
    destroy: destroy,
    loadCaptions: loadCaptions,
    captureScreenshot: captureScreenshot,
    parseTimestamp: parseTimestamp,
    seekToTranscriptTime: seekToTranscriptTime,
    parseWebVTT: parseWebVTT
  };
})();

// Export for testing (Node.js / CommonJS environments)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Playback: Playback };
}
