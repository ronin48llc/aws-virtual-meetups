/**
 * Anonymous Viewer Module — View-Only Live & Playback Access
 *
 * Manages the anonymous (unauthenticated) viewing experience:
 * - Live session: join via fingerprint, subscribe-only IVS stage, WebSocket
 * - Playback: access recording via fingerprint, HLS player
 * - All interaction controls hidden (mic, chat, questions, hand-raise, DM)
 * - Persistent "Register to participate" indicator
 * - Error handling: invalid link (404), meeting ended (400), rate limited (429)
 *
 * Validates: Requirements 1.1, 1.4, 1.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.8,
 *            8.1, 8.4, 8.5
 */

const AnonymousViewer = (() => {
  'use strict';

  // --- State ---
  let stage = null;
  let websocket = null;
  let hlsInstance = null;
  let videoElement = null;
  let currentEventId = null;
  let currentSessionId = null;
  let currentFingerprint = null;
  let chatRoom = null;
  let wsReconnectAttempts = 0;
  let wsReconnectTimer = null;

  // --- SessionStorage Keys ---
  const PROMPT_DISMISSED_KEY = 'vm_anon_reg_prompt_dismissed';

  // --- Constants ---
  const SQUID_INK = '#232F3E';
  const DARK_BG = '#161E2D';
  const AWS_ORANGE = '#FF9900';
  const MAX_WS_RECONNECT_DELAY = 30000;

  // --- Initialization (Live) ---

  /**
   * Initialize anonymous live viewing session.
   * Generates fingerprint, calls join-anonymous API, connects to IVS stage and WebSocket.
   * @param {Object} config - { eventId, wsUrl }
   */
  async function initLive(config) {
    if (!config || !config.eventId) {
      _showError('No event specified.');
      return;
    }

    currentEventId = config.eventId;
    var apiBase = window.API_BASE_URL || '/api';

    // Generate browser fingerprint
    var fingerprint;
    try {
      fingerprint = await Fingerprint.generate();
    } catch (e) {
      _showError('Failed to initialize viewer session. Please reload the page.');
      return;
    }

    // Store fingerprint for potential session upgrade
    currentFingerprint = fingerprint;

    // Call join-anonymous API
    try {
      var res = await fetch(apiBase + '/events/' + encodeURIComponent(config.eventId) + '/join-anonymous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: fingerprint }),
      });

      if (!res.ok) {
        await _handleApiError(res);
        return;
      }

      var data = await res.json();
      currentSessionId = data.sessionId;

      // Render the anonymous live UI
      _renderLiveUI(config.eventId);

      // Connect to IVS stage with subscribe-only token
      if (data.stageToken) {
        await _connectStage(data.stageToken);
      }

      // Connect to WebSocket for real-time updates
      if (config.wsUrl) {
        var wsUrl = config.wsUrl + '?eventId=' + encodeURIComponent(config.eventId) +
          '&sessionId=' + encodeURIComponent(currentSessionId) +
          '&anonymous=true';
        _connectWebSocket(wsUrl);
      }

      // Hide all interaction controls
      _hideInteractionControls();

      // Show persistent registration indicator
      _showRegisterIndicator();

      // Show dismissible registration prompt (if not previously dismissed)
      showRegistrationPrompt();

    } catch (err) {
      _showError('Failed to join the meeting. Please check your connection and try again.');
    }
  }

  // --- Initialization (Playback) ---

  /**
   * Initialize anonymous playback session.
   * Generates fingerprint, calls playback-anonymous API, initializes HLS player.
   * @param {Object} config - { eventId }
   */
  async function initPlayback(config) {
    if (!config || !config.eventId) {
      _showError('No event specified.');
      return;
    }

    currentEventId = config.eventId;
    var apiBase = window.API_BASE_URL || '/api';

    // Generate browser fingerprint
    var fingerprint;
    try {
      fingerprint = await Fingerprint.generate();
    } catch (e) {
      _showError('Failed to initialize viewer session. Please reload the page.');
      return;
    }

    // Store fingerprint for potential session upgrade
    currentFingerprint = fingerprint;

    // Call playback-anonymous API
    try {
      var res = await fetch(apiBase + '/events/' + encodeURIComponent(config.eventId) + '/playback-anonymous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: fingerprint }),
      });

      if (!res.ok) {
        await _handleApiError(res);
        return;
      }

      var data = await res.json();
      currentSessionId = data.sessionId;

      // Render the anonymous playback UI
      _renderPlaybackUI(config.eventId);

      // Initialize HLS player with returned URL
      if (data.hlsPlaybackUrl) {
        _initHlsPlayer(data.hlsPlaybackUrl);
      } else {
        _showError('Recording is not yet available.');
      }

      // Hide all interaction controls
      _hideInteractionControls();

      // Show persistent registration indicator
      _showRegisterIndicator();

      // Show dismissible registration prompt (if not previously dismissed)
      showRegistrationPrompt();

    } catch (err) {
      _showError('Failed to load the recording. Please check your connection and try again.');
    }
  }

  // --- UI Rendering ---

  /**
   * Render the anonymous live session UI (view-only).
   * @param {string} eventId
   */
  function _renderLiveUI(eventId) {
    var container = document.getElementById('live-session-container') ||
                    document.getElementById('app');
    if (!container) return;

    container.innerHTML =
      '<div id="anonymous-viewer-container" style="background-color: ' + DARK_BG + '; color: #fff; min-height: 100vh;">' +
        '<div class="anonymous-viewer__header" style="padding: 16px 24px; display: flex; align-items: center; gap: 12px; background: ' + SQUID_INK + ';">' +
          '<span class="badge badge--live" style="background: #e63946; color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600;">● LIVE</span>' +
          '<h2 style="margin: 0; font-size: 18px; color: #fff;">Event: ' + _escapeHtml(eventId) + '</h2>' +
          '<div style="margin-left: auto;">' +
            '<span id="anon-viewer-badge" style="font-size: 12px; color: #8b949e; background: #21262d; padding: 4px 10px; border-radius: 4px;">View Only</span>' +
          '</div>' +
        '</div>' +
        '<div style="max-width: 1100px; margin: 0 auto; padding: 16px 24px;">' +
          '<div id="anon-stage-video-container" style="background: #0d1117; border-radius: 8px; min-height: 480px; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center;">' +
            '<p id="anon-stage-placeholder" style="color: #6e7681;">Connecting to live stream...</p>' +
          '</div>' +
          '<div id="anon-register-indicator"></div>' +
          '<div id="anon-error-container"></div>' +
        '</div>' +
      '</div>';
  }

  /**
   * Render the anonymous playback UI (view-only).
   * @param {string} eventId
   */
  function _renderPlaybackUI(eventId) {
    var container = document.getElementById('live-session-container') ||
                    document.getElementById('app');
    if (!container) return;

    container.innerHTML =
      '<div id="anonymous-viewer-container" style="background-color: #fff; color: #1a202c; min-height: 100vh;">' +
        '<div class="anonymous-viewer__header" style="padding: 16px 24px; display: flex; align-items: center; gap: 12px; background: ' + SQUID_INK + ';">' +
          '<span style="background: #6b7280; color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600;">Recording</span>' +
          '<h2 style="margin: 0; font-size: 18px; color: #fff;">Event: ' + _escapeHtml(eventId) + '</h2>' +
          '<div style="margin-left: auto;">' +
            '<span id="anon-viewer-badge" style="font-size: 12px; color: #8b949e; background: #21262d; padding: 4px 10px; border-radius: 4px;">View Only</span>' +
          '</div>' +
        '</div>' +
        '<div style="max-width: 960px; margin: 0 auto; padding: 24px;">' +
          '<div id="anon-playback-container" style="position: relative; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16/9;">' +
            '<video id="anon-playback-video" controls playsinline style="width: 100%; height: 100%; display: block;" aria-label="Event recording playback">' +
              '<p>Your browser does not support HTML5 video.</p>' +
            '</video>' +
            '<div id="anon-playback-loading" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; font-size: 14px;">Loading player...</div>' +
          '</div>' +
          '<div id="anon-register-indicator"></div>' +
          '<div id="anon-error-container"></div>' +
        '</div>' +
      '</div>';
  }

  // --- IVS Stage Connection ---

  /**
   * Connect to the IVS Real-Time stage with a subscribe-only token.
   * @param {string} token - IVS stage participant token (subscribe-only)
   */
  async function _connectStage(token) {
    if (!window.IVSBroadcastClient) {
      _setPlaceholder('IVS SDK not available. Please reload the page.');
      return;
    }

    try {
      var IVS = window.IVSBroadcastClient;
      var strategy = {
        stageStreamsToPublish: function() { return []; },
        shouldPublishParticipant: function() { return false; },
        shouldSubscribeToParticipant: function() {
          return IVS.SubscribeType.AUDIO_VIDEO;
        },
      };

      stage = new IVS.Stage(token, strategy);

      stage.on(IVS.StageEvents.STAGE_CONNECTION_STATE_CHANGED, function(state) {
        if (state === 'connected') {
          _setPlaceholder('');
        } else if (state === 'disconnected') {
          _setPlaceholder('Disconnected from stream.');
        }
      });

      stage.on(IVS.StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, function(participant, streams) {
        _renderRemoteStreams(participant, streams);
      });

      stage.on(IVS.StageEvents.STAGE_PARTICIPANT_STREAMS_REMOVED, function(participant) {
        _removeParticipantMedia(participant.id);
      });

      stage.on(IVS.StageEvents.STAGE_PARTICIPANT_LEFT, function(participant) {
        _removeParticipantMedia(participant.id);
      });

      await stage.join();
    } catch (err) {
      console.error('AnonymousViewer: Failed to join stage', err);
      _setPlaceholder('Failed to connect to the live stream. Please try again.');
    }
  }

  /**
   * Render remote participant streams (video and audio).
   * @param {Object} participant
   * @param {Array} streams
   */
  function _renderRemoteStreams(participant, streams) {
    var container = document.getElementById('anon-stage-video-container');
    if (!container) return;

    streams.forEach(function(stream) {
      if (stream.mediaStreamTrack.kind === 'video') {
        var videoEl = document.getElementById('anon-video-' + participant.id);
        if (!videoEl) {
          videoEl = document.createElement('video');
          videoEl.id = 'anon-video-' + participant.id;
          videoEl.autoplay = true;
          videoEl.playsInline = true;
          videoEl.style.cssText = 'width: 100%; height: 100%; object-fit: contain; position: absolute; top: 0; left: 0;';
          container.appendChild(videoEl);
        }
        var mediaStream = new MediaStream([stream.mediaStreamTrack]);
        videoEl.srcObject = mediaStream;
      }
      if (stream.mediaStreamTrack.kind === 'audio') {
        var audioEl = document.getElementById('anon-audio-' + participant.id);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'anon-audio-' + participant.id;
          audioEl.autoplay = true;
          container.appendChild(audioEl);
        }
        var audioStream = new MediaStream([stream.mediaStreamTrack]);
        audioEl.srcObject = audioStream;
      }
    });
  }

  /**
   * Remove a participant's video/audio elements.
   * @param {string} participantId
   */
  function _removeParticipantMedia(participantId) {
    var videoEl = document.getElementById('anon-video-' + participantId);
    if (videoEl) videoEl.remove();
    var audioEl = document.getElementById('anon-audio-' + participantId);
    if (audioEl) audioEl.remove();
  }

  // --- WebSocket Connection ---

  /**
   * Connect to the signaling WebSocket for real-time updates.
   * Uses exponential backoff for reconnection (1s, 2s, 4s, ... max 30s).
   * @param {string} wsUrl - WebSocket URL with query parameters
   */
  function _connectWebSocket(wsUrl) {
    if (!wsUrl) return;

    try {
      websocket = new WebSocket(wsUrl);

      websocket.onopen = function() {
        console.log('AnonymousViewer: WebSocket connected');
        wsReconnectAttempts = 0;
      };

      websocket.onmessage = function(event) {
        _handleWebSocketMessage(event.data);
      };

      websocket.onclose = function() {
        console.log('AnonymousViewer: WebSocket disconnected');
        _scheduleReconnect(wsUrl);
      };

      websocket.onerror = function(err) {
        console.error('AnonymousViewer: WebSocket error', err);
      };
    } catch (err) {
      console.error('AnonymousViewer: Failed to connect WebSocket', err);
      _scheduleReconnect(wsUrl);
    }
  }

  /**
   * Schedule a WebSocket reconnection with exponential backoff.
   * @param {string} wsUrl
   */
  function _scheduleReconnect(wsUrl) {
    if (wsReconnectTimer) return;

    var delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), MAX_WS_RECONNECT_DELAY);
    wsReconnectAttempts++;

    wsReconnectTimer = setTimeout(function() {
      wsReconnectTimer = null;
      _connectWebSocket(wsUrl);
    }, delay);
  }

  /**
   * Handle incoming WebSocket messages.
   * Anonymous viewers only receive broadcast events (no interaction).
   * @param {string} rawData
   */
  function _handleWebSocketMessage(rawData) {
    try {
      var msg = JSON.parse(rawData);
      switch (msg.type) {
        case 'EVENT_ENDED':
          _showEventEnded();
          break;
        case 'STREAM_STARTED':
          _setPlaceholder('');
          break;
        default:
          // Anonymous viewers ignore interaction messages
          break;
      }
    } catch (e) {
      // Ignore malformed messages
    }
  }

  // --- HLS Player ---

  /**
   * Initialize the HLS player for recording playback.
   * @param {string} hlsUrl - HLS manifest URL (.m3u8)
   */
  function _initHlsPlayer(hlsUrl) {
    videoElement = document.getElementById('anon-playback-video');
    if (!videoElement) return;

    var loadingEl = document.getElementById('anon-playback-loading');

    // Check for native HLS support (Safari, iOS)
    if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = hlsUrl;
      videoElement.addEventListener('loadedmetadata', function() {
        if (loadingEl) loadingEl.style.display = 'none';
      });
      videoElement.addEventListener('error', function() {
        _showError('Failed to load the recording. The video may not be available yet.');
      });
      return;
    }

    // Use hls.js for browsers without native HLS support
    if (typeof Hls === 'undefined') {
      _showError('HLS player library not loaded. Please reload the page.');
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
      maxMaxBufferLength: 60,
    });

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
      if (loadingEl) loadingEl.style.display = 'none';
    });

    hlsInstance.on(Hls.Events.ERROR, function(event, data) {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            _showError('Network error loading the recording. Please check your connection.');
            hlsInstance.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hlsInstance.recoverMediaError();
            break;
          default:
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

  // --- Interaction Controls ---

  /**
   * Hide all interaction controls for anonymous users.
   * Req 5.1: Hide microphone control
   * Req 5.2: Hide chat message input
   * Req 5.3: Hide question submission
   * Req 5.4: Hide hand-raising control
   * Req 5.5: Hide direct messaging
   */
  function _hideInteractionControls() {
    var controlIds = [
      'presenter-controls',
      'attendee-controls',
      'chat-panel',
      'chat-form',
      'btn-hand-raise',
      'btn-show-question-form',
      'question-form-container',
      'btn-mic',
      'btn-webcam',
      'btn-screen-share',
      'btn-device-audio',
      'dm-recipient-selector',
    ];

    controlIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  /**
   * Display persistent "Register to participate" indicator.
   * Req 5.8: Display a persistent visual indicator informing the user
   * that registration is required to participate.
   */
  function _showRegisterIndicator() {
    var indicatorContainer = document.getElementById('anon-register-indicator');
    if (!indicatorContainer) return;

    indicatorContainer.innerHTML =
      '<div style="margin-top: 16px; padding: 12px 20px; background: ' + SQUID_INK + '; border: 1px solid ' + AWS_ORANGE + '; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">' +
        '<div style="display: flex; align-items: center; gap: 8px;">' +
          '<span style="font-size: 16px;" aria-hidden="true">🔒</span>' +
          '<span style="font-size: 14px; color: #e6edf3;">Register to participate — chat, ask questions, and interact with the presenter.</span>' +
        '</div>' +
        '<button onclick="AnonymousViewer.promptRegister()" style="padding: 8px 20px; border-radius: 4px; border: none; background: ' + AWS_ORANGE + '; color: #000; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap;">Register to Participate</button>' +
      '</div>';
  }

  // --- Error Handling ---

  /**
   * Handle API error responses with appropriate user-facing messages.
   * @param {Response} res - Fetch response object
   */
  async function _handleApiError(res) {
    var errorData = {};
    try {
      errorData = await res.json();
    } catch (e) {
      // Ignore parse errors
    }

    var message = errorData.message || '';

    switch (res.status) {
      case 404:
        _showError('This link is invalid. The meeting or recording could not be found.');
        break;
      case 400:
        if (message.toLowerCase().indexOf('not currently live') !== -1 ||
            message.toLowerCase().indexOf('ended') !== -1) {
          _showEventEnded();
        } else {
          _showError(message || 'Unable to join. The meeting may not be available.');
        }
        break;
      case 429:
        _showError('Too many requests. Please wait a moment and try again.');
        break;
      default:
        _showError(message || 'An unexpected error occurred. Please try again.');
        break;
    }
  }

  /**
   * Display an error message to the user.
   * @param {string} message
   */
  function _showError(message) {
    // Try to render in the error container if available
    var errorContainer = document.getElementById('anon-error-container');
    if (errorContainer) {
      errorContainer.innerHTML =
        '<div style="margin-top: 16px; padding: 16px 20px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; color: #991b1b; font-size: 14px;">' +
          '<p style="margin: 0;">' + _escapeHtml(message) + '</p>' +
        '</div>';
      return;
    }

    // Fallback: render in the main app container
    var container = document.getElementById('live-session-container') ||
                    document.getElementById('app');
    if (container) {
      container.innerHTML =
        '<div style="max-width: 600px; margin: 80px auto; padding: 32px; text-align: center;">' +
          '<div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>' +
          '<h2 style="margin-bottom: 12px; color: #1a202c;">Unable to Access</h2>' +
          '<p style="color: #4a5568; font-size: 16px; line-height: 1.6;">' + _escapeHtml(message) + '</p>' +
          '<a href="#/" class="btn btn--primary" style="margin-top: 24px; display: inline-block; text-decoration: none;">Back to Home</a>' +
        '</div>';
    }
  }

  /**
   * Display the "meeting has ended" state.
   */
  function _showEventEnded() {
    var container = document.getElementById('anonymous-viewer-container') ||
                    document.getElementById('live-session-container') ||
                    document.getElementById('app');
    if (!container) return;

    container.innerHTML =
      '<div style="max-width: 600px; margin: 80px auto; padding: 32px; text-align: center;">' +
        '<div style="font-size: 48px; margin-bottom: 16px;">📺</div>' +
        '<h2 style="margin-bottom: 12px; color: #1a202c;">Meeting Has Ended</h2>' +
        '<p style="color: #4a5568; font-size: 16px; line-height: 1.6;">This meeting has ended. If a recording is available, it will be accessible shortly.</p>' +
        '<a href="#/" class="btn btn--primary" style="margin-top: 24px; display: inline-block; text-decoration: none;">Back to Home</a>' +
      '</div>';
  }

  // --- Registration Prompt ---

  /**
   * Show a dismissible registration prompt on page load.
   * Stores dismissal in sessionStorage to prevent re-display during the same session.
   * Validates: Requirements 1.2, 8.2
   */
  function showRegistrationPrompt() {
    // Check if prompt was already dismissed this session
    if (sessionStorage.getItem(PROMPT_DISMISSED_KEY)) {
      return;
    }

    // Remove any existing prompt
    var existing = document.getElementById('anon-registration-prompt');
    if (existing) existing.remove();

    var prompt = document.createElement('div');
    prompt.id = 'anon-registration-prompt';
    prompt.setAttribute('role', 'alert');
    prompt.style.cssText = 'position: fixed; top: 24px; right: 24px; z-index: 1500; ' +
      'background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px 24px; ' +
      'box-shadow: 0 8px 24px rgba(0,0,0,0.15); max-width: 360px; animation: slideIn 0.3s ease;';

    prompt.innerHTML =
      '<div style="display: flex; align-items: flex-start; gap: 12px;">' +
        '<div style="flex: 1;">' +
          '<h4 style="margin: 0 0 6px 0; font-size: 15px; color: #1a202c;">Create an account to participate</h4>' +
          '<p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.4;">Register to chat, ask questions, and interact with the presenter.</p>' +
          '<div style="margin-top: 12px; display: flex; gap: 8px;">' +
            '<button id="anon-prompt-register-btn" style="padding: 6px 16px; border-radius: 4px; border: none; background: ' + AWS_ORANGE + '; color: #000; font-weight: 600; font-size: 13px; cursor: pointer;">Register</button>' +
            '<button id="anon-prompt-dismiss-btn" style="padding: 6px 16px; border-radius: 4px; border: 1px solid #d1d5db; background: transparent; color: #6b7280; font-size: 13px; cursor: pointer;">Not now</button>' +
          '</div>' +
        '</div>' +
        '<button id="anon-prompt-close-btn" style="background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 0; line-height: 1;" aria-label="Dismiss registration prompt">&times;</button>' +
      '</div>';

    document.body.appendChild(prompt);

    // Dismiss handler
    function dismissPrompt() {
      sessionStorage.setItem(PROMPT_DISMISSED_KEY, '1');
      var el = document.getElementById('anon-registration-prompt');
      if (el) el.remove();
    }

    // Register handler — open the registration overlay
    var registerBtn = document.getElementById('anon-prompt-register-btn');
    if (registerBtn) {
      registerBtn.addEventListener('click', function() {
        dismissPrompt();
        showRegistrationOverlay();
      });
    }

    // Dismiss buttons
    var dismissBtn = document.getElementById('anon-prompt-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', dismissPrompt);
    }

    var closeBtn = document.getElementById('anon-prompt-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', dismissPrompt);
    }
  }

  /**
   * Show an in-context registration form overlay without navigating away from the stream page.
   * Stream playback continues without pause underneath the overlay.
   * Validates: Requirements 1.3, 6.1, 6.2, 8.3
   */
  function showRegistrationOverlay() {
    // Remove any existing overlay
    var existing = document.getElementById('anon-registration-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'anon-registration-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Registration form');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; ' +
      'background: rgba(0,0,0,0.6); z-index: 2000; display: flex; align-items: center; justify-content: center;';

    var modal = document.createElement('div');
    modal.id = 'anon-registration-modal';
    modal.style.cssText = 'background: #fff; border-radius: 12px; padding: 32px; width: 100%; max-width: 420px; ' +
      'max-height: 90vh; overflow-y: auto; position: relative;';

    modal.innerHTML =
      '<button id="anon-reg-close-btn" style="position: absolute; top: 12px; right: 16px; background: none; border: none; font-size: 22px; color: #6b7280; cursor: pointer; line-height: 1;" aria-label="Close registration form">&times;</button>' +
      '<h2 style="margin: 0 0 8px 0; font-size: 20px; color: #1a202c;">Create Account</h2>' +
      '<p style="margin: 0 0 20px 0; font-size: 13px; color: #6b7280;">Register to participate in the session. Your stream will continue playing.</p>' +
      '<div id="anon-reg-error" style="display: none; margin-bottom: 12px; padding: 10px 14px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; color: #991b1b; font-size: 13px;"></div>' +
      '<form id="anon-reg-form">' +
        '<div style="margin-bottom: 14px;">' +
          '<label for="anon-reg-name" style="display: block; font-size: 13px; color: #374151; margin-bottom: 4px; font-weight: 500;">Display Name</label>' +
          '<input type="text" id="anon-reg-name" placeholder="Your name" required style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">' +
        '</div>' +
        '<div style="margin-bottom: 14px;">' +
          '<label for="anon-reg-email" style="display: block; font-size: 13px; color: #374151; margin-bottom: 4px; font-weight: 500;">Email</label>' +
          '<input type="email" id="anon-reg-email" placeholder="you@example.com" required style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">' +
        '</div>' +
        '<div style="margin-bottom: 14px;">' +
          '<label for="anon-reg-password" style="display: block; font-size: 13px; color: #374151; margin-bottom: 4px; font-weight: 500;">Password</label>' +
          '<input type="password" id="anon-reg-password" placeholder="Min 8 characters" required minlength="8" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">' +
        '</div>' +
        '<div style="margin-bottom: 20px;">' +
          '<label for="anon-reg-password-confirm" style="display: block; font-size: 13px; color: #374151; margin-bottom: 4px; font-weight: 500;">Confirm Password</label>' +
          '<input type="password" id="anon-reg-password-confirm" placeholder="Re-enter password" required minlength="8" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">' +
        '</div>' +
        '<button type="submit" id="anon-reg-submit-btn" style="width: 100%; padding: 12px; border-radius: 6px; border: none; background: ' + AWS_ORANGE + '; color: #000; font-weight: 600; font-size: 14px; cursor: pointer;">Create Account</button>' +
      '</form>' +
      '<div id="anon-reg-verify-section" style="display: none;">' +
        '<h3 style="margin: 0 0 8px 0; font-size: 16px; color: #1a202c;">Verify Your Email</h3>' +
        '<p id="anon-reg-verify-msg" style="margin: 0 0 16px 0; font-size: 13px; color: #6b7280;"></p>' +
        '<div style="margin-bottom: 14px;">' +
          '<label for="anon-reg-code" style="display: block; font-size: 13px; color: #374151; margin-bottom: 4px; font-weight: 500;">Verification Code</label>' +
          '<input type="text" id="anon-reg-code" placeholder="123456" required style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">' +
        '</div>' +
        '<button id="anon-reg-verify-btn" style="width: 100%; padding: 12px; border-radius: 6px; border: none; background: ' + AWS_ORANGE + '; color: #000; font-weight: 600; font-size: 14px; cursor: pointer;">Verify & Join</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close overlay on background click or close button
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        _closeRegistrationOverlay();
      }
    });

    var closeBtn = document.getElementById('anon-reg-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', _closeRegistrationOverlay);
    }

    // Handle form submission
    var form = document.getElementById('anon-reg-form');
    if (form) {
      form.addEventListener('submit', _handleRegistrationSubmit);
    }
  }

  /**
   * Close the registration overlay.
   */
  function _closeRegistrationOverlay() {
    var overlay = document.getElementById('anon-registration-overlay');
    if (overlay) overlay.remove();
  }

  /**
   * Handle registration form submission within the overlay.
   * @param {Event} e - Form submit event
   */
  async function _handleRegistrationSubmit(e) {
    e.preventDefault();

    var errorEl = document.getElementById('anon-reg-error');
    var submitBtn = document.getElementById('anon-reg-submit-btn');
    var name = document.getElementById('anon-reg-name').value.trim();
    var email = document.getElementById('anon-reg-email').value.trim();
    var password = document.getElementById('anon-reg-password').value;
    var passwordConfirm = document.getElementById('anon-reg-password-confirm').value;

    // Clear previous errors
    if (errorEl) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }

    // Validate passwords match
    if (password !== passwordConfirm) {
      _showRegistrationError('Passwords do not match.');
      return;
    }

    // Disable submit button during request
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating account...';
    }

    try {
      // Use the existing Auth module for Cognito sign-up
      await Auth.signUp(email, password, name);

      // Show verification code input
      var form = document.getElementById('anon-reg-form');
      var verifySection = document.getElementById('anon-reg-verify-section');
      var verifyMsg = document.getElementById('anon-reg-verify-msg');

      if (form) form.style.display = 'none';
      if (verifySection) verifySection.style.display = 'block';
      if (verifyMsg) verifyMsg.textContent = 'We sent a verification code to ' + email + '. Enter it below to complete registration.';

      // Handle verify button click
      var verifyBtn = document.getElementById('anon-reg-verify-btn');
      if (verifyBtn) {
        verifyBtn.addEventListener('click', function() {
          _handleVerificationSubmit(email, password);
        });
      }

      // Also handle Enter key in code input
      var codeInput = document.getElementById('anon-reg-code');
      if (codeInput) {
        codeInput.addEventListener('keydown', function(evt) {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            _handleVerificationSubmit(email, password);
          }
        });
      }
    } catch (err) {
      _showRegistrationError(err.message || 'Registration failed. Please try again.');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
      }
    }
  }

  /**
   * Handle verification code submission and complete the registration + session upgrade.
   * @param {string} email - User's email
   * @param {string} password - User's password (for auto sign-in after verification)
   */
  async function _handleVerificationSubmit(email, password) {
    var code = (document.getElementById('anon-reg-code').value || '').trim();
    var verifyBtn = document.getElementById('anon-reg-verify-btn');
    var errorEl = document.getElementById('anon-reg-error');

    if (!code) {
      _showRegistrationError('Please enter the verification code.');
      return;
    }

    if (errorEl) {
      errorEl.style.display = 'none';
    }

    if (verifyBtn) {
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying...';
    }

    try {
      // Confirm sign-up with verification code
      await Auth.confirmSignUp(email, code);

      // Auto sign-in after successful verification
      await Auth.signIn(email, password);

      // Get the Cognito tokens
      var user = Auth.getCurrentUser();
      if (!user || !user.idToken) {
        throw new Error('Failed to retrieve authentication tokens.');
      }

      // Close the overlay
      _closeRegistrationOverlay();

      // Upgrade the anonymous session to a registered session
      await upgradeSession({ idToken: user.idToken, accessToken: user.accessToken });

    } catch (err) {
      _showRegistrationError(err.message || 'Verification failed. Please try again.');
      if (verifyBtn) {
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify & Join';
      }
    }
  }

  /**
   * Display an inline error message within the registration overlay.
   * @param {string} message
   */
  function _showRegistrationError(message) {
    var errorEl = document.getElementById('anon-reg-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }

  /**
   * Upgrade the anonymous session to a registered user session.
   * Calls /events/{id}/upgrade-session with Cognito tokens and the anonymous session ID,
   * then reconnects to the IVS stage with the new full-capability token and connects to chat.
   * Stream playback continues without pause during the upgrade.
   * Validates: Requirements 6.3, 6.4, 6.5
   *
   * @param {Object} cognitoTokens - { idToken, accessToken }
   */
  async function upgradeSession(cognitoTokens) {
    if (!cognitoTokens || !cognitoTokens.idToken) {
      _showRegistrationError('Authentication tokens are missing. Please try again.');
      return;
    }

    if (!currentEventId || !currentSessionId) {
      _showRegistrationError('Session information is missing. Please reload the page.');
      return;
    }

    var apiBase = window.API_BASE_URL || '/api';

    try {
      var res = await fetch(apiBase + '/events/' + encodeURIComponent(currentEventId) + '/upgrade-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cognitoTokens.idToken,
        },
        body: JSON.stringify({
          anonSessionId: currentSessionId,
          fingerprint: currentFingerprint,
        }),
      });

      if (!res.ok) {
        var errData = {};
        try { errData = await res.json(); } catch (e) { /* ignore */ }
        throw new Error(errData.message || 'Session upgrade failed (' + res.status + ')');
      }

      var data = await res.json();

      // Handle event ended during upgrade (Req 6.6)
      if (data.registered && data.message === 'Event has ended') {
        _showEventEnded();
        return;
      }

      // Reconnect to IVS stage with new PUBLISH+SUBSCRIBE token
      // The existing stage connection continues playing — we leave and rejoin with new capabilities
      if (data.stageToken && data.stageToken.token) {
        await _reconnectStage(data.stageToken.token);
      }

      // Connect to IVS Chat with the new chat token
      if (data.chatToken && data.chatToken.token) {
        await _connectChat(data.chatToken);
      }

      // Update the UI to reflect registered state
      _onUpgradeSuccess();

    } catch (err) {
      // Retain anonymous session on failure, allow retry (Req 6.5)
      _showRegistrationError(err.message || 'Failed to upgrade session. Please try again.');
      // Re-show the overlay so user can retry
      showRegistrationOverlay();
    }
  }

  /**
   * Reconnect to the IVS stage with a new token (PUBLISH+SUBSCRIBE).
   * Leaves the current stage gracefully and rejoins with the upgraded token.
   * Stream playback continues without interruption because we only leave/rejoin
   * after the new token is ready.
   * @param {string} newToken - New IVS stage participant token
   */
  async function _reconnectStage(newToken) {
    if (!window.IVSBroadcastClient) {
      console.warn('AnonymousViewer: IVS SDK not available for stage reconnection');
      return;
    }

    try {
      var IVS = window.IVSBroadcastClient;

      // Leave the existing subscribe-only stage
      if (stage) {
        stage.leave();
        stage = null;
      }

      // Create a new stage with full capabilities (PUBLISH+SUBSCRIBE)
      var strategy = {
        stageStreamsToPublish: function() { return []; },
        shouldPublishParticipant: function() { return true; },
        shouldSubscribeToParticipant: function() {
          return IVS.SubscribeType.AUDIO_VIDEO;
        },
      };

      stage = new IVS.Stage(newToken, strategy);

      stage.on(IVS.StageEvents.STAGE_CONNECTION_STATE_CHANGED, function(state) {
        if (state === 'connected') {
          _setPlaceholder('');
        } else if (state === 'disconnected') {
          _setPlaceholder('Disconnected from stream.');
        }
      });

      stage.on(IVS.StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, function(participant, streams) {
        _renderRemoteStreams(participant, streams);
      });

      stage.on(IVS.StageEvents.STAGE_PARTICIPANT_STREAMS_REMOVED, function(participant) {
        _removeParticipantMedia(participant.id);
      });

      stage.on(IVS.StageEvents.STAGE_PARTICIPANT_LEFT, function(participant) {
        _removeParticipantMedia(participant.id);
      });

      await stage.join();
    } catch (err) {
      console.error('AnonymousViewer: Failed to reconnect stage after upgrade', err);
    }
  }

  /**
   * Connect to IVS Chat after session upgrade.
   * @param {Object} chatTokenData - { token, sessionExpirationTime, tokenExpirationTime }
   */
  async function _connectChat(chatTokenData) {
    if (!window.IVSChat) {
      console.warn('AnonymousViewer: IVS Chat SDK not available');
      return;
    }

    try {
      var ChatRoom = window.IVSChat.ChatRoom;

      chatRoom = new ChatRoom({
        regionOrUrl: 'us-east-1',
        tokenProvider: function() {
          return Promise.resolve({
            token: chatTokenData.token,
            sessionExpirationTime: new Date(chatTokenData.sessionExpirationTime || Date.now() + 60 * 60 * 1000),
            tokenExpirationTime: new Date(chatTokenData.tokenExpirationTime || Date.now() + 60 * 60 * 1000),
          });
        },
      });

      chatRoom.addListener('connect', function() {
        console.log('AnonymousViewer: Chat connected after upgrade');
      });

      chatRoom.addListener('disconnect', function() {
        console.log('AnonymousViewer: Chat disconnected');
      });

      await chatRoom.connect();
    } catch (err) {
      console.error('AnonymousViewer: Failed to connect to chat after upgrade', err);
    }
  }

  /**
   * Update the UI after a successful session upgrade.
   * Removes the anonymous indicators and shows interaction controls.
   */
  function _onUpgradeSuccess() {
    // Remove the registration indicator
    var indicator = document.getElementById('anon-register-indicator');
    if (indicator) indicator.innerHTML = '';

    // Remove the "View Only" badge
    var badge = document.getElementById('anon-viewer-badge');
    if (badge) {
      badge.textContent = 'Registered';
      badge.style.background = '#065f46';
      badge.style.color = '#d1fae5';
    }

    // Remove the registration prompt if still visible
    var prompt = document.getElementById('anon-registration-prompt');
    if (prompt) prompt.remove();

    // Show interaction controls that were previously hidden
    var controlIds = [
      'attendee-controls',
      'chat-panel',
      'chat-form',
      'btn-hand-raise',
      'btn-show-question-form',
    ];

    controlIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = '';
    });
  }

  /**
   * Prompt the user to register. Opens the registration overlay.
   */
  function promptRegister() {
    showRegistrationOverlay();
  }

  // --- Cleanup ---

  /**
   * Disconnect from stage, WebSocket, chat, and clean up resources.
   */
  function disconnect() {
    if (stage) {
      stage.leave();
      stage = null;
    }
    if (chatRoom) {
      chatRoom.disconnect();
      chatRoom = null;
    }
    if (websocket) {
      websocket.close();
      websocket = null;
    }
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    if (videoElement) {
      videoElement.pause();
      videoElement.removeAttribute('src');
      videoElement.load();
      videoElement = null;
    }
    currentEventId = null;
    currentSessionId = null;
    currentFingerprint = null;
    wsReconnectAttempts = 0;
  }

  // --- Utility ---

  /**
   * Set the stage placeholder text.
   * @param {string} text
   */
  function _setPlaceholder(text) {
    var el = document.getElementById('anon-stage-placeholder');
    if (el) {
      el.textContent = text;
      el.style.display = text ? 'block' : 'none';
    }
  }

  /**
   * Escape HTML entities to prevent XSS.
   * @param {string} str
   * @returns {string}
   */
  function _escapeHtml(str) {
    if (typeof escapeHtml === 'function') return escapeHtml(str);
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Public API ---
  return {
    initLive: initLive,
    initPlayback: initPlayback,
    disconnect: disconnect,
    promptRegister: promptRegister,
    showRegistrationPrompt: showRegistrationPrompt,
    showRegistrationOverlay: showRegistrationOverlay,
    upgradeSession: upgradeSession,
  };
})();
