/**
 * Live Session Module — IVS Real-Time Stage + Chat Integration
 *
 * Manages the live session experience for both presenters and attendees:
 * - IVS Web Broadcast SDK stage participation (publish/subscribe)
 * - Presenter controls: screen share, webcam, mic, device audio
 * - Attendee view: video player, hand raise, question submission
 * - IVS Chat SDK: group messaging, direct messaging
 * - Real-time captions with language selector
 * - Dark theme (Squid Ink background)
 *
 * IVS SDKs are loaded via CDN script tags in the HTML.
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3,
 *            4.1, 4.2, 4.3, 11.1, 11.2, 11.3
 */

const LiveSession = (() => {
  // --- State ---
  let stage = null;
  let stageStrategy = null;
  let localStreams = { screen: null, camera: null, mic: null, deviceAudio: null };
  let chatRoom = null;
  let websocket = null;
  let eventId = null;
  let participantToken = null;
  let chatToken = null;
  let userRole = 'attendee'; // 'presenter' | 'attendee'
  let currentUserId = null;
  let currentUserEmail = null;
  let isHandRaised = false;
  let captionLanguage = 'en';
  let isMicEnabled = false;
  let isCameraEnabled = false;
  let isScreenSharing = false;
  let isDeviceAudioEnabled = false;
  let scheduledEnd = null;
  let countdownInterval = null;
  let eventStatus = null;

  // --- My Questions State (Fix #1) ---
  let mySubmittedQuestions = [];

  // --- Notification Sound State (Fix #2) ---
  let unreadMessageCount = 0;
  let chatPanelFocused = true;

  // --- Typing Indicator State (Fix #3) ---
  let typingTimeout = null;
  let lastTypingSent = 0;

  // --- Presenter Dashboard State ---
  let dashboardAttendees = [];
  let dashboardAnonymousAttendees = [];
  let dashboardQuestions = [];
  let dashboardAnsweredQuestions = [];
  let dashboardHands = [];
  let dashboardActiveTab = 'attendees';
  let pinnedQuestion = null;

  // --- Constants ---
  const SQUID_INK = '#232F3E';
  const DARK_BG = '#161E2D';
  const AWS_ORANGE = '#FF9900';
  const CAPTION_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'zh', label: 'Chinese' }
  ];


  // --- Notification Sound (Fix #2) ---
  function playNotificationSound() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      gain.gain.value = 0.1;
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch(e) {}
  }

  // --- Device Selection State ---
  let selectedVideoDeviceId = null;
  let selectedAudioDeviceId = null;
  let selectedAudioOutputId = null;


  // --- Initialization ---

  /**
   * Initialize the live session for a given event.
   * @param {object} config - { eventId, participantToken, chatToken, role, wsUrl, eventStatus }
   */
  async function init(config) {
    eventId = config.eventId;
    participantToken = config.participantToken;
    chatToken = config.chatToken;
    userRole = config.role || 'attendee';
    currentUserId = config.userId || '';
    currentUserEmail = config.email || '';
    eventStatus = config.eventStatus || 'live';

    applyDarkTheme();
    renderUI();
    connectWebSocket(config.wsUrl);

    // Belt-and-suspenders: if WS is already open (reconnect scenario),
    // onopen won't fire again — request dashboard state after a short wait.
    if (userRole === 'presenter') {
      setTimeout(function() {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          requestDashboardState();
        }
      }, 2000);
    }

    if (participantToken) {
      await joinStage();
      // Show device picker for presenters instead of auto-requesting
      if (userRole === 'presenter') {
        await showDevicePicker();
      }
    }
    if (chatToken) {
      await connectChat();
    }
  }

  /**
   * Show a device picker modal for selecting camera and microphone.
   * Enumerates available devices and presents dropdowns for selection.
   */
  async function showDevicePicker() {
    try {
      // Request temporary permission to enumerate devices with labels
      var tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      tempStream.getTracks().forEach(function(t) { t.stop(); });
    } catch (err) {
      // If permission denied, fall back to default devices
      await toggleMic();
      await toggleWebcam();
      return;
    }

    var devices = await navigator.mediaDevices.enumerateDevices();
    var videoDevices = devices.filter(function(d) { return d.kind === 'videoinput'; });
    var audioDevices = devices.filter(function(d) { return d.kind === 'audioinput'; });

    // Build the picker overlay
    var overlay = document.createElement('div');
    overlay.id = 'device-picker-overlay';
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 2000; display: flex; align-items: center; justify-content: center;';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Device selection');

    var modal = document.createElement('div');
    modal.style.cssText = 'background: ' + SQUID_INK + '; border-radius: 12px; padding: 24px 32px; min-width: 360px; max-width: 480px; color: #fff;';

    var title = document.createElement('h3');
    title.textContent = 'Select Devices';
    title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px;';
    modal.appendChild(title);

    // Video device dropdown
    var videoLabel = document.createElement('label');
    videoLabel.textContent = 'Camera';
    videoLabel.setAttribute('for', 'device-picker-video');
    videoLabel.style.cssText = 'display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px;';
    modal.appendChild(videoLabel);

    var videoSelect = document.createElement('select');
    videoSelect.id = 'device-picker-video';
    videoSelect.style.cssText = 'width: 100%; padding: 8px 12px; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 14px; margin-bottom: 16px;';
    videoDevices.forEach(function(d) {
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Camera ' + (videoSelect.options.length + 1));
      videoSelect.appendChild(opt);
    });
    modal.appendChild(videoSelect);

    // Audio device dropdown
    var audioLabel = document.createElement('label');
    audioLabel.textContent = 'Microphone';
    audioLabel.setAttribute('for', 'device-picker-audio');
    audioLabel.style.cssText = 'display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px;';
    modal.appendChild(audioLabel);

    var audioSelect = document.createElement('select');
    audioSelect.id = 'device-picker-audio';
    audioSelect.style.cssText = 'width: 100%; padding: 8px 12px; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 14px; margin-bottom: 16px;';
    audioDevices.forEach(function(d) {
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Microphone ' + (audioSelect.options.length + 1));
      audioSelect.appendChild(opt);
    });
    modal.appendChild(audioSelect);

    // Speaker (audio output) device dropdown
    var outputDevices = devices.filter(function(d) { return d.kind === 'audiooutput'; });
    if (outputDevices.length > 0) {
      var outputLabel = document.createElement('label');
      outputLabel.textContent = 'Speaker';
      outputLabel.setAttribute('for', 'device-picker-output');
      outputLabel.style.cssText = 'display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px;';
      modal.appendChild(outputLabel);

      var outputSelect = document.createElement('select');
      outputSelect.id = 'device-picker-output';
      outputSelect.style.cssText = 'width: 100%; padding: 8px 12px; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 14px; margin-bottom: 24px;';
      outputDevices.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('Speaker ' + (outputSelect.options.length + 1));
        outputSelect.appendChild(opt);
      });
      modal.appendChild(outputSelect);
    }

    // Start button
    var startBtn = document.createElement('button');
    startBtn.textContent = 'Start';
    startBtn.style.cssText = 'width: 100%; padding: 10px 16px; border-radius: 4px; border: none; background: ' + AWS_ORANGE + '; color: #000; font-weight: 600; font-size: 14px; cursor: pointer;';
    startBtn.onclick = async function() {
      selectedVideoDeviceId = videoSelect.value || null;
      selectedAudioDeviceId = audioSelect.value || null;
      selectedAudioOutputId = (typeof outputSelect !== 'undefined' && outputSelect) ? outputSelect.value || null : null;
      // Apply speaker selection to all audio elements
      if (selectedAudioOutputId) {
        try {
          var audioElements = document.querySelectorAll('audio');
          audioElements.forEach(function(el) {
            if (typeof el.setSinkId === 'function') {
              el.setSinkId(selectedAudioOutputId).catch(function() {});
            }
          });
        } catch (e) {
          // setSinkId not supported in all browsers
        }
      }
      overlay.remove();
      await toggleMic();
      await toggleWebcam();
    };
    modal.appendChild(startBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  /**
   * Apply dark theme (Squid Ink) to the live session container.
   */
  function applyDarkTheme() {
    const container = document.getElementById('live-session-container');
    if (container) {
      container.style.backgroundColor = DARK_BG;
      container.style.color = '#FFFFFF';
      container.style.minHeight = '100vh';
    }
  }

  // --- UI Rendering ---

  /**
   * Render the full live session UI based on user role.
   * @returns {string} HTML string for the live session page
   */
  function renderPage(params) {
    eventId = params.id;
    return `
      <div id="live-session-container" class="live-session" style="background-color: ${DARK_BG}; color: #fff; min-height: 100vh;">
        <div class="live-session__header" style="padding: 16px 24px; display: flex; align-items: center; gap: 12px; background: ${SQUID_INK};">
          <span class="badge badge--live" style="background: #e63946; color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600;">● LIVE</span>
          <h2 style="margin: 0; font-size: 18px; color: #fff;">Event: ${escapeHtml(params.id)}</h2>
          <div id="countdown-timer" style="display: none; margin-left: 12px; padding: 4px 12px; border-radius: 4px; font-size: 14px; font-weight: 600; background: #21262d; color: #e6edf3; border: 1px solid #30363d;" aria-live="polite" aria-label="Time remaining"></div>
          <div style="margin-left: auto;" id="live-session-attendee-count"></div>
        </div>

        <div class="live-session__body" style="display: grid; grid-template-columns: 1fr 360px; gap: 16px; padding: 16px 24px; max-width: 1400px; margin: 0 auto;">
          <!-- Main video area -->
          <div class="live-session__main">
            <div id="stage-video-container" style="background: #0d1117; border-radius: 8px; min-height: 480px; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center;">
              <p id="stage-placeholder" style="color: #6e7681;">Connecting to stage...</p>
            </div>

            <!-- Captions -->
            <div id="caption-area" style="margin-top: 12px; background: rgba(0,0,0,0.7); border-radius: 8px; padding: 12px 16px; min-height: 48px;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                <span style="font-size: 12px; color: #8b949e;">Captions</span>
                <select id="caption-language-select" onchange="LiveSession.setCaptionLanguage(this.value)" style="background: ${SQUID_INK}; color: #fff; border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; font-size: 12px;" aria-label="Caption language">
                  ${CAPTION_LANGUAGES.map(function(lang) { return '<option value="' + lang.code + '"' + (lang.code === 'en' ? ' selected' : '') + '>' + lang.label + '</option>'; }).join('')}
                </select>
              </div>
              <div id="caption-text" style="font-size: 14px; line-height: 1.5; color: #e6edf3;" aria-live="polite" aria-atomic="true"></div>
            </div>

            <!-- Presenter Controls (shown only for presenters) -->
            <div id="presenter-controls" style="display: none; margin-top: 12px; padding: 12px 16px; background: ${SQUID_INK}; border-radius: 8px;">
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button id="btn-screen-share" class="btn btn--control" onclick="LiveSession.toggleScreenShare()" aria-label="Toggle screen share" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; cursor: pointer;">
                  🖥️ Screen Share
                </button>
                <button id="btn-webcam" class="btn btn--control" onclick="LiveSession.toggleWebcam()" aria-label="Toggle webcam" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; cursor: pointer;">
                  📷 Webcam
                </button>
                <button id="btn-mic" class="btn btn--control" onclick="LiveSession.toggleMic()" aria-label="Toggle microphone" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; cursor: pointer;">
                  🎤 Mic
                </button>
                <button id="btn-device-audio" class="btn btn--control" onclick="LiveSession.toggleDeviceAudio()" aria-label="Toggle device audio" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; cursor: pointer;">
                  🔊 Device Audio
                </button>
              </div>
            </div>

            <!-- Presenter Dashboard Panel (visible only for presenters) -->
            <div id="presenter-dashboard" style="display: none; margin-top: 12px; background: ${SQUID_INK}; border-radius: 8px; overflow: hidden;">
              <div style="display: flex; border-bottom: 1px solid #30363d;">
                <button id="dashboard-tab-attendees" onclick="LiveSession.switchDashboardTab('attendees')" style="flex: 1; padding: 10px 16px; border: none; background: ${AWS_ORANGE}; color: #000; font-weight: 600; font-size: 13px; cursor: pointer;">
                  Attendees <span id="dashboard-count-attendees" style="margin-left: 4px; padding: 2px 6px; border-radius: 10px; background: rgba(0,0,0,0.2); font-size: 11px;">0</span>
                </button>
                <button id="dashboard-tab-questions" onclick="LiveSession.switchDashboardTab('questions')" style="flex: 1; padding: 10px 16px; border: none; background: #21262d; color: #8b949e; font-size: 13px; cursor: pointer;">
                  Questions <span id="dashboard-count-questions" style="margin-left: 4px; padding: 2px 6px; border-radius: 10px; background: rgba(255,255,255,0.1); font-size: 11px;">0</span>
                </button>
                <button id="dashboard-tab-hands" onclick="LiveSession.switchDashboardTab('hands')" style="flex: 1; padding: 10px 16px; border: none; background: #21262d; color: #8b949e; font-size: 13px; cursor: pointer;">
                  Hands <span id="dashboard-count-hands" style="margin-left: 4px; padding: 2px 6px; border-radius: 10px; background: rgba(255,255,255,0.1); font-size: 11px;">0</span>
                </button>
              </div>
              <div id="dashboard-content" style="padding: 12px 16px; max-height: 300px; overflow-y: auto;">
                <div id="dashboard-panel-attendees"></div>
                <div id="dashboard-panel-questions" style="display: none;"></div>
                <div id="dashboard-panel-hands" style="display: none;"></div>
              </div>
            </div>

            <!-- Attendee Controls -->
            <div id="attendee-controls" style="display: none; margin-top: 12px; padding: 12px 16px; background: ${SQUID_INK}; border-radius: 8px;">
              <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <button id="btn-hand-raise" class="btn btn--control" onclick="LiveSession.toggleHandRaise()" aria-label="Raise or lower hand" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; cursor: pointer;">
                  ✋ Raise Hand
                </button>
                <button id="btn-show-question-form" onclick="LiveSession.toggleQuestionForm()" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; cursor: pointer;">
                  ❓ Ask Question
                </button>
              </div>
              <!-- Question submission form -->
              <div id="question-form-container" style="display: none; margin-top: 12px;">
                <form id="question-form" onsubmit="LiveSession.submitQuestion(event)">
                  <div style="display: flex; gap: 8px;">
                    <input type="text" id="question-input" placeholder="Type your question..." required style="flex: 1; padding: 8px 12px; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 14px;" aria-label="Question text">
                    <button type="submit" style="padding: 8px 16px; border-radius: 4px; border: none; background: ${AWS_ORANGE}; color: #000; font-weight: 600; cursor: pointer;">Send</button>
                  </div>
                </form>
                <p id="question-confirmation" style="display: none; margin-top: 8px; font-size: 12px; color: #7AA116;">✓ Question submitted</p>
              </div>
            </div>
          </div>

          <!-- Sidebar: Chat + Participants -->
          <div class="live-session__sidebar" style="display: flex; flex-direction: column; gap: 12px;">
            <!-- Chat Panel -->
            <div id="chat-panel" style="flex: 1; background: ${SQUID_INK}; border-radius: 8px; display: flex; flex-direction: column; min-height: 400px;">
              <div style="padding: 12px 16px; border-bottom: 1px solid #30363d; display: flex; gap: 8px;">
                <button id="btn-chat-group" onclick="LiveSession.switchChatTab('group')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid ${AWS_ORANGE}; background: ${AWS_ORANGE}; color: #000; font-size: 12px; font-weight: 600; cursor: pointer;">Group</button>
                <button id="btn-chat-direct" onclick="LiveSession.switchChatTab('direct')" style="padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: transparent; color: #8b949e; font-size: 12px; cursor: pointer;">Direct</button>
              </div>
              <div id="dm-recipient-selector" style="display: none; padding: 8px 16px; border-bottom: 1px solid #30363d;">
                <select id="dm-recipient" style="width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 12px;" aria-label="Direct message recipient">
                  <option value="">Select recipient...</option>
                </select>
              </div>
              <div id="chat-messages" style="flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; font-size: 13px; line-height: 1.6;" role="log" aria-live="polite" aria-label="Chat messages"></div>
              <form id="chat-form" onsubmit="LiveSession.sendChatMessage(event)" style="padding: 12px 16px; border-top: 1px solid #30363d;">
                <div style="display: flex; gap: 8px;">
                  <input type="text" id="chat-input" placeholder="Type a message..." required style="flex: 1; padding: 8px 12px; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 13px;" aria-label="Chat message">
                  <button type="submit" style="padding: 8px 12px; border-radius: 4px; border: none; background: ${AWS_ORANGE}; color: #000; font-weight: 600; cursor: pointer;" aria-label="Send message">→</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render UI elements after page is in the DOM.
   */
  function renderUI() {
    if (userRole === 'presenter') {
      showElement('presenter-controls');
      showElement('presenter-dashboard');
      hideElement('attendee-controls');
      // Dashboard state is requested in connectWebSocket onopen — don't call here
      // as WS isn't connected yet when renderUI runs.

      // Show Green Room banner and Go Live button when in staging
      if (eventStatus === 'staging') {
        showGreenRoomBanner();
      }
    } else {
      hideElement('presenter-controls');
      hideElement('presenter-dashboard');
      showElement('attendee-controls');
    }

    // Attach typing indicator listener to chat input (Fix #3)
    var chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.addEventListener('input', handleTypingInput);
    }

    // Initialize captions
    var captionEl = document.getElementById('caption-text');
    if (captionEl) {
      if (userRole === 'presenter') {
        captionEl.textContent = 'Click "Start Captions" to enable live transcription';
        captionEl.style.fontStyle = 'italic';
        captionEl.style.color = '#8b949e';
        // Add Start Captions button for presenter
        addCaptionControlButton();
      } else {
        captionEl.textContent = 'Waiting for presenter to enable captions...';
        captionEl.style.fontStyle = 'italic';
        captionEl.style.color = '#8b949e';
      }
    }
  }

  /**
   * Show the Green Room banner with Go Live button for presenters in staging mode.
   */
  function showGreenRoomBanner() {
    var controlsEl = document.getElementById('presenter-controls');
    if (!controlsEl) return;

    var banner = document.createElement('div');
    banner.id = 'green-room-banner';
    banner.style.cssText = 'margin-bottom: 12px; padding: 16px 20px; background: #21262d; border: 2px solid ' + AWS_ORANGE + '; border-radius: 8px; text-align: center;';
    banner.innerHTML = '<p style="margin: 0 0 12px 0; font-size: 14px; color: #e6edf3;">You\'re in the Green Room. Set up your devices, then click Go Live when ready.</p>' +
      '<button id="btn-go-live" onclick="LiveSession.goLive()" style="padding: 12px 32px; border-radius: 6px; border: none; background: #e63946; color: #fff; font-weight: 700; font-size: 16px; cursor: pointer;">🔴 Go Live</button>';

    controlsEl.parentNode.insertBefore(banner, controlsEl);
  }

  /**
   * Transition the event from staging to live.
   */
  async function goLive() {
    if (!eventId) return;

    var btn = document.getElementById('btn-go-live');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Going live...';
    }

    try {
      var apiBase = window.API_BASE_URL || '/api';
      var token = Auth.getIdToken();

      var res = await fetch(apiBase + '/events/' + encodeURIComponent(eventId) + '/go-live', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
      });

      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || 'Failed to go live (' + res.status + ')');
      }

      // Success — remove the green room banner
      eventStatus = 'live';
      var banner = document.getElementById('green-room-banner');
      if (banner) banner.remove();
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔴 Go Live';
      }
      showNotification('Failed to go live: ' + (err.message || 'Unknown error'));
    }
  }


  // --- IVS Stage (Web Broadcast SDK) ---

  /**
   * Join the IVS Real-Time stage using the participant token.
   * Uses the IVSBroadcastClient global loaded via CDN.
   */
  async function joinStage() {
    if (!window.IVSBroadcastClient) {
      console.error('LiveSession: IVS Web Broadcast SDK not loaded');
      setPlaceholder('IVS SDK not available. Please reload the page.');
      return;
    }

    try {
      const { Stage, LocalStageStream, SubscribeType, StageEvents, Strategy } = window.IVSBroadcastClient;

      stageStrategy = {
        stageStreamsToPublish: function() {
          const streams = [];
          if (localStreams.screen) streams.push(new LocalStageStream(localStreams.screen));
          if (localStreams.camera) streams.push(new LocalStageStream(localStreams.camera));
          if (localStreams.mic) streams.push(new LocalStageStream(localStreams.mic));
          if (localStreams.deviceAudio) streams.push(new LocalStageStream(localStreams.deviceAudio));
          return streams;
        },
        shouldPublishParticipant: function() {
          return userRole === 'presenter';
        },
        shouldSubscribeToParticipant: function() {
          return SubscribeType.AUDIO_VIDEO;
        }
      };

      stage = new Stage(participantToken, stageStrategy);

      stage.on(StageEvents.STAGE_CONNECTION_STATE_CHANGED, function(state) {
        if (state === 'connected') {
          setPlaceholder('');
        } else if (state === 'disconnected') {
          setPlaceholder('Disconnected from stage.');
        }
      });

      stage.on(StageEvents.STAGE_PARTICIPANT_JOINED, function(participant) {
        console.log('Participant joined:', participant.id);
      });

      stage.on(StageEvents.STAGE_PARTICIPANT_LEFT, function(participant) {
        removeParticipantVideo(participant.id);
      });

      stage.on(StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, function(participant, streams) {
        renderParticipantStreams(participant, streams);
      });

      stage.on(StageEvents.STAGE_PARTICIPANT_STREAMS_REMOVED, function(participant, streams) {
        removeParticipantVideo(participant.id);
      });

      await stage.join();
    } catch (err) {
      console.error('LiveSession: Failed to join stage', err);
      setPlaceholder('Failed to connect to the live stage. Please try again.');
    }
  }

  /**
   * Render participant streams into the video container.
   * Handles both local (presenter self-view) and remote participants.
   */
  function renderParticipantStreams(participant, streams) {
    const container = document.getElementById('stage-video-container');
    if (!container) return;

    streams.forEach(function(stream) {
      if (stream.mediaStreamTrack.kind === 'video') {
        let videoEl = document.getElementById('video-' + participant.id);
        if (!videoEl) {
          videoEl = document.createElement('video');
          videoEl.id = 'video-' + participant.id;
          videoEl.autoplay = true;
          videoEl.playsInline = true;
          // Mute local video to prevent echo
          if (participant.isLocal) {
            videoEl.muted = true;
            videoEl.style.cssText = 'width: 100%; height: 100%; object-fit: contain; position: absolute; top: 0; left: 0; transform: scaleX(-1);';
          } else {
            videoEl.style.cssText = 'width: 100%; height: 100%; object-fit: contain; position: absolute; top: 0; left: 0;';
          }
          container.appendChild(videoEl);
        }
        const mediaStream = new MediaStream([stream.mediaStreamTrack]);
        videoEl.srcObject = mediaStream;
      }
      if (stream.mediaStreamTrack.kind === 'audio' && !participant.isLocal) {
        // Only render audio for remote participants (avoid echo)
        let audioEl = document.getElementById('audio-' + participant.id);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'audio-' + participant.id;
          audioEl.autoplay = true;
          container.appendChild(audioEl);
          // Apply selected speaker output if available
          if (selectedAudioOutputId && typeof audioEl.setSinkId === 'function') {
            try { audioEl.setSinkId(selectedAudioOutputId); } catch (e) {}
          }
        }
        const mediaStream = new MediaStream([stream.mediaStreamTrack]);
        audioEl.srcObject = mediaStream;
      }
    });
  }

  /**
   * Remove a participant's video/audio elements.
   */
  function removeParticipantVideo(participantId) {
    var videoEl = document.getElementById('video-' + participantId);
    if (videoEl) videoEl.remove();
    var audioEl = document.getElementById('audio-' + participantId);
    if (audioEl) audioEl.remove();
  }

  // --- Presenter Controls ---

  /**
   * Toggle screen sharing.
   * Req 1.1: Capture selected screen/window and transmit to IVS channel.
   * Req 1.2: Stop transmitting within 2 seconds.
   * Req 1.3: Display error if permission denied.
   */
  async function toggleScreenShare() {
    if (isScreenSharing) {
      stopScreenShare();
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      localStreams.screen = stream.getVideoTracks()[0];
      // If display media includes audio, capture it
      var audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && !localStreams.deviceAudio) {
        localStreams.deviceAudio = audioTrack;
      }
      isScreenSharing = true;
      updateControlButton('btn-screen-share', '🖥️ Stop Share', true);
      refreshStagePublish();
      // Render screen share preview
      renderScreenSharePreview();

      // Handle user stopping share via browser UI
      localStreams.screen.onended = function() {
        stopScreenShare();
      };
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        // User cancelled the picker — don't show an error
      } else {
        showNotification('Screen sharing failed: ' + err.name + ' — ' + err.message);
      }
    }
  }

  function stopScreenShare() {
    if (localStreams.screen) {
      localStreams.screen.stop();
      localStreams.screen = null;
    }
    isScreenSharing = false;
    updateControlButton('btn-screen-share', '🖥️ Screen Share', false);
    refreshStagePublish();
    removeScreenSharePreview();
  }

  /**
   * Toggle webcam.
   * Req 2.1: Capture webcam feed and composite with screen share.
   * Req 2.2: Stop transmitting within 2 seconds.
   * Req 2.3: Display message if no camera available.
   */
  async function toggleWebcam() {
    if (isCameraEnabled) {
      stopWebcam();
      return;
    }
    try {
      var constraints = { video: selectedVideoDeviceId ? { deviceId: { exact: selectedVideoDeviceId } } : true };
      var stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreams.camera = stream.getVideoTracks()[0];
      isCameraEnabled = true;
      updateControlButton('btn-webcam', '📷 Stop Cam', true);
      refreshStagePublish();
      // Render local preview immediately
      renderLocalPreview();
    } catch (err) {
      if (err.name === 'NotFoundError') {
        showNotification('No camera detected. The session will continue without video.');
      } else if (err.name === 'NotAllowedError') {
        showNotification('Camera permission denied. Please allow access in browser settings.');
      } else {
        showNotification('Failed to access webcam: ' + err.message);
      }
    }
  }

  function stopWebcam() {
    if (localStreams.camera) {
      localStreams.camera.stop();
      localStreams.camera = null;
    }
    isCameraEnabled = false;
    updateControlButton('btn-webcam', '📷 Webcam', false);
    refreshStagePublish();
    removeLocalPreview();
  }

  /**
   * Toggle microphone.
   * Req 4.1: Capture presenter mic audio and transmit.
   * Req 4.3: Display error if mic unavailable.
   */
  async function toggleMic() {
    if (isMicEnabled) {
      stopMic();
      return;
    }
    try {
      var constraints = { audio: selectedAudioDeviceId ? { deviceId: { exact: selectedAudioDeviceId } } : true };
      var stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreams.mic = stream.getAudioTracks()[0];
      isMicEnabled = true;
      updateControlButton('btn-mic', '🎤 Mute', true);
      refreshStagePublish();
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') {
        showNotification('Microphone is unavailable or permission denied. Cannot start session without a microphone.');
      } else {
        showNotification('Failed to access microphone: ' + err.message);
      }
    }
  }

  function stopMic() {
    if (localStreams.mic) {
      localStreams.mic.stop();
      localStreams.mic = null;
    }
    isMicEnabled = false;
    updateControlButton('btn-mic', '🎤 Mic', false);
    refreshStagePublish();
  }

  /**
   * Toggle device audio (system audio capture).
   * Req 3.1: Capture system audio and mix into stream.
   * Req 3.2: Stop transmitting within 2 seconds.
   * Req 3.3: Notify if browser doesn't support system audio.
   */
  async function toggleDeviceAudio() {
    if (isDeviceAudioEnabled) {
      stopDeviceAudio();
      return;
    }
    try {
      // getDisplayMedia with audio: true captures system audio
      var stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      var audioTrack = stream.getAudioTracks()[0];
      // Stop the video track since we only need audio
      stream.getVideoTracks().forEach(function(t) { t.stop(); });

      if (!audioTrack) {
        showNotification('Device audio sharing is unavailable in this browser. Try Chrome or Edge on desktop.');
        return;
      }
      localStreams.deviceAudio = audioTrack;
      isDeviceAudioEnabled = true;
      updateControlButton('btn-device-audio', '🔊 Stop Audio', true);
      refreshStagePublish();

      audioTrack.onended = function() {
        stopDeviceAudio();
      };
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        // User cancelled — no error shown
      } else {
        showNotification('Device audio failed: ' + err.name + ' — ' + err.message);
      }
    }
  }

  function stopDeviceAudio() {
    if (localStreams.deviceAudio) {
      localStreams.deviceAudio.stop();
      localStreams.deviceAudio = null;
    }
    isDeviceAudioEnabled = false;
    updateControlButton('btn-device-audio', '🔊 Device Audio', false);
    refreshStagePublish();
  }

  /**
   * Render local camera preview for the presenter.
   */
  function renderLocalPreview() {
    var container = document.getElementById('stage-video-container');
    if (!container) return;

    var videoEl = document.getElementById('video-local-preview');
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.id = 'video-local-preview';
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = true;
      videoEl.style.cssText = 'width: 100%; height: 100%; object-fit: contain; position: absolute; top: 0; left: 0; transform: scaleX(-1);';
      container.appendChild(videoEl);
    }

    if (localStreams.camera) {
      var mediaStream = new MediaStream([localStreams.camera]);
      videoEl.srcObject = mediaStream;
    }
  }

  /**
   * Remove local camera preview.
   */
  function removeLocalPreview() {
    var videoEl = document.getElementById('video-local-preview');
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.remove();
    }
  }

  /**
   * Render screen share preview for the presenter.
   */
  function renderScreenSharePreview() {
    var container = document.getElementById('stage-video-container');
    if (!container) return;

    var videoEl = document.getElementById('video-screen-preview');
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.id = 'video-screen-preview';
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = true;
      videoEl.style.cssText = 'width: 100%; height: 100%; object-fit: contain; position: absolute; top: 0; left: 0;';
      container.appendChild(videoEl);
    }

    if (localStreams.screen) {
      var mediaStream = new MediaStream([localStreams.screen]);
      videoEl.srcObject = mediaStream;
    }
  }

  /**
   * Remove screen share preview.
   */
  function removeScreenSharePreview() {
    var videoEl = document.getElementById('video-screen-preview');
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.remove();
    }
  }

  /**
   * Refresh the stage publish state after local streams change.
   */
  function refreshStagePublish() {
    if (stage && stage.refreshStrategy) {
      stage.refreshStrategy();
    }
  }


  // --- Attendee Controls ---

  /**
   * Toggle hand raise/lower.
   * Req 12.1: Display raised-hand indicator visible to presenter.
   * Req 12.2: Remove indicator when lowered.
   */
  function toggleHandRaise() {
    isHandRaised = !isHandRaised;
    var action = isHandRaised ? 'raiseHand' : 'lowerHand';
    sendWebSocketMessage(action, { userId: currentUserId, displayName: currentUserEmail });
    updateHandRaiseButton();
  }

  function updateHandRaiseButton() {
    var btn = document.getElementById('btn-hand-raise');
    if (!btn) return;
    if (isHandRaised) {
      btn.textContent = '✋ Lower Hand';
      btn.style.background = AWS_ORANGE;
      btn.style.color = '#000';
      btn.style.borderColor = AWS_ORANGE;
    } else {
      btn.textContent = '✋ Raise Hand';
      btn.style.background = '#21262d';
      btn.style.color = '#fff';
      btn.style.borderColor = '#30363d';
    }
  }

  /**
   * Toggle question form visibility.
   */
  function toggleQuestionForm() {
    var container = document.getElementById('question-form-container');
    if (!container) return;
    container.style.display = container.style.display === 'none' ? 'block' : 'none';
  }

  /**
   * Submit a question to the queue.
   * Req 13.1: Add question to queue in submission order.
   * Req 13.2: Confirm to attendee that question was queued.
   */
  function submitQuestion(event) {
    event.preventDefault();
    var input = document.getElementById('question-input');
    if (!input || !input.value.trim()) return;

    var questionText = input.value.trim();
    sendWebSocketMessage('submitQuestion', { text: questionText, userId: currentUserId, displayName: currentUserEmail });

    // Track in mySubmittedQuestions (Fix #1)
    mySubmittedQuestions.push({ text: questionText, status: 'queued', timestamp: new Date().toISOString() });
    renderMyQuestions();

    input.value = '';
    var confirmation = document.getElementById('question-confirmation');
    if (confirmation) {
      confirmation.style.display = 'block';
      setTimeout(function() {
        confirmation.style.display = 'none';
      }, 3000);
    }
  }

  /**
   * Render the "My Questions" section below the question form (Fix #1).
   */
  function renderMyQuestions() {
    var container = document.getElementById('my-questions-section');
    if (!container) {
      // Create the section if it doesn't exist
      var formContainer = document.getElementById('question-form-container');
      if (!formContainer) return;
      container = document.createElement('div');
      container.id = 'my-questions-section';
      container.style.cssText = 'margin-top: 12px; padding: 8px 12px; background: #0d1117; border-radius: 6px; border: 1px solid #30363d;';
      formContainer.parentNode.insertBefore(container, formContainer.nextSibling);
    }

    if (mySubmittedQuestions.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    var html = '<div style="font-size: 12px; font-weight: 600; color: #8b949e; margin-bottom: 6px;">My Questions</div>';
    mySubmittedQuestions.forEach(function(q) {
      var statusColor = q.status === 'answered' ? '#7AA116' : (q.status === 'dismissed' ? '#6e7681' : '#FF9900');
      var statusLabel = q.status.charAt(0).toUpperCase() + q.status.slice(1);
      html += '<div style="padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 12px;">'
        + '<span style="color: #e6edf3;">' + escapeHtml(q.text) + '</span>'
        + ' <span style="color: ' + statusColor + '; font-weight: 500;">(' + statusLabel + ')</span>';
      if (q.answer) {
        html += '<div style="color: #7AA116; margin-top: 2px; font-size: 11px;">A: ' + escapeHtml(q.answer) + '</div>';
      }
      html += '</div>';
    });
    container.innerHTML = html;
  }

  // --- IVS Chat Integration ---

  /**
   * Connect to IVS Chat room.
   * Uses the ChatRoom class from the IVS Chat Messaging SDK.
   */
  async function connectChat() {
    if (!window.IVSChat) {
      console.error('LiveSession: IVS Chat SDK not loaded');
      return;
    }

    try {
      var ChatRoom = window.IVSChat.ChatRoom;
      var SendMessageRequest = window.IVSChat.SendMessageRequest;

      chatRoom = new ChatRoom({
        regionOrUrl: 'us-east-1',
        tokenProvider: function() {
          return Promise.resolve({
            token: chatToken,
            sessionExpirationTime: new Date(Date.now() + 60 * 60 * 1000),
            tokenExpirationTime: new Date(Date.now() + 60 * 60 * 1000)
          });
        }
      });

      // Store request class for use in sendChatMessage
      chatRoom._SendMessageRequest = SendMessageRequest;

      chatRoom.addListener('message', function(message) {
        var senderName = (message.sender && message.sender.attributes && message.sender.attributes.displayName) 
          ? message.sender.attributes.displayName 
          : (message.sender ? message.sender.userId : 'Unknown');
        appendChatMessage(senderName, message.content, 'group');
      });

      chatRoom.addListener('event', function(event) {
        if (event.eventName === 'DIRECT_MESSAGE') {
          var data = JSON.parse(event.attributes.data || '{}');
          appendChatMessage(data.senderId, data.text, 'direct');
        }
      });

      chatRoom.addListener('connect', function() {
        appendSystemMessage('Connected to chat');
      });

      chatRoom.addListener('disconnect', function() {
        appendSystemMessage('Disconnected from chat');
      });

      await chatRoom.connect();
    } catch (err) {
      console.error('LiveSession: Failed to connect to chat', err);
    }
  }

  /**
   * Send a chat message (group or direct).
   */
  function sendChatMessage(event) {
    event.preventDefault();
    var input = document.getElementById('chat-input');
    if (!input || !input.value.trim() || !chatRoom) return;

    var message = input.value.trim();
    var currentTab = getCurrentChatTab();

    if (currentTab === 'group') {
      var request = new chatRoom._SendMessageRequest(message);
      chatRoom.sendMessage(request);
    } else {
      // Direct message — presenter selects recipient from dropdown
      if (userRole === 'presenter') {
        var recipientSelect = document.getElementById('dm-recipient');
        var targetConnectionId = recipientSelect ? recipientSelect.value : '';
        if (!targetConnectionId) {
          showNotification('Please select a recipient for the direct message.');
          return;
        }
        // Send via WebSocket signaling (not IVS Chat) to target specific user
        sendWebSocketMessage('sendDirectMessage', { message: message, targetConnectionId: targetConnectionId });
        appendChatMessage('You (DM)', message, 'direct');
      } else {
        // Attendees send DMs to presenter via WebSocket
        sendWebSocketMessage('sendDirectMessage', { message: message });
        appendChatMessage('You (DM)', message, 'direct');
      }
    }

    input.value = '';
  }

  /**
   * Switch between group and direct chat tabs.
   */
  function switchChatTab(tab) {
    var groupBtn = document.getElementById('btn-chat-group');
    var directBtn = document.getElementById('btn-chat-direct');
    var recipientSelector = document.getElementById('dm-recipient-selector');

    if (tab === 'group') {
      if (groupBtn) {
        groupBtn.style.background = AWS_ORANGE;
        groupBtn.style.color = '#000';
        groupBtn.style.borderColor = AWS_ORANGE;
      }
      if (directBtn) {
        directBtn.style.background = 'transparent';
        directBtn.style.color = '#8b949e';
        directBtn.style.borderColor = '#30363d';
      }
      if (recipientSelector) recipientSelector.style.display = 'none';
    } else {
      if (directBtn) {
        directBtn.style.background = AWS_ORANGE;
        directBtn.style.color = '#000';
        directBtn.style.borderColor = AWS_ORANGE;
      }
      if (groupBtn) {
        groupBtn.style.background = 'transparent';
        groupBtn.style.color = '#8b949e';
        groupBtn.style.borderColor = '#30363d';
      }
      // Show recipient selector only for presenters
      if (recipientSelector && userRole === 'presenter') {
        recipientSelector.style.display = 'block';
        updateDmRecipientList();
      }
    }

    // Clear messages and show appropriate tab
    var messagesEl = document.getElementById('chat-messages');
    if (messagesEl) {
      messagesEl.setAttribute('data-tab', tab);
      // Filter messages by tab
      var messages = messagesEl.querySelectorAll('[data-msg-type]');
      for (var i = 0; i < messages.length; i++) {
        var msgType = messages[i].getAttribute('data-msg-type');
        messages[i].style.display = (tab === 'group' && msgType === 'group') || (tab === 'direct' && msgType === 'direct') ? '' : 'none';
      }
    }
  }

  function getCurrentChatTab() {
    var messagesEl = document.getElementById('chat-messages');
    return (messagesEl && messagesEl.getAttribute('data-tab')) || 'group';
  }

  /**
   * Update the DM recipient dropdown with current attendees.
   */
  function updateDmRecipientList() {
    var select = document.getElementById('dm-recipient');
    if (!select) return;

    var currentValue = select.value;
    select.innerHTML = '<option value="">Select recipient...</option>';

    dashboardAttendees.forEach(function(attendee) {
      if (attendee.role !== 'presenter') {
        var option = document.createElement('option');
        option.value = attendee.connectionId;
        option.textContent = (attendee.displayName || attendee.email || attendee.userId) + (attendee.email ? ' (' + attendee.email + ')' : '');
        select.appendChild(option);
      }
    });

    // Restore previous selection if still valid
    if (currentValue) select.value = currentValue;
  }

  /**
   * Linkify plain text — converts URLs to clickable links that open in a new tab.
   * Safely handles HTML entities already escaped.
   */
  function linkifyText(text) {
    var escaped = escapeHtml(text);
    return escaped.replace(/(https?:\/\/[^\s<>"']+)/g, function(url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" style="color: ' + AWS_ORANGE + '; text-decoration: underline;">' + url + '</a>';
    });
  }

  /**
   * Append a chat message to the messages container.
   */
  function appendChatMessage(sender, text, type) {
    var messagesEl = document.getElementById('chat-messages');
    if (!messagesEl) return;

    var currentTab = getCurrentChatTab();
    var msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = '8px';
    msgDiv.setAttribute('data-msg-type', type);
    // Hide if not matching current tab
    if (type !== currentTab && currentTab !== 'all') {
      msgDiv.style.display = 'none';
    }
    var prefix = type === 'direct' ? '[DM] ' : '';
    msgDiv.innerHTML = '<span style="color: ' + AWS_ORANGE + '; font-weight: 600;">' + prefix + escapeHtml(sender) + '</span>: ' + linkifyText(text);
    messagesEl.appendChild(msgDiv);
    // Use requestAnimationFrame so the DOM has updated before measuring scrollHeight
    requestAnimationFrame(function() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    // Notification sound for messages not from self (Fix #2)
    var isSelf = (sender === currentUserEmail || sender === currentUserId || sender === 'You (DM)');
    if (!isSelf) {
      playNotificationSound();
      // Show unread badge if document is hidden
      if (document.hidden) {
        unreadMessageCount++;
        showUnreadBadge();
      }
    }
  }

  /**
   * Append a system message to chat.
   */
  function appendSystemMessage(text) {
    var messagesEl = document.getElementById('chat-messages');
    if (!messagesEl) return;

    var msgDiv = document.createElement('div');
    msgDiv.style.cssText = 'margin-bottom: 8px; color: #8b949e; font-style: italic; font-size: 12px;';
    msgDiv.textContent = text;
    messagesEl.appendChild(msgDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /**
   * Show/hide unread message badge on chat panel header (Fix #2).
   */
  function showUnreadBadge() {
    var chatPanel = document.getElementById('chat-panel');
    if (!chatPanel) return;
    var badge = document.getElementById('chat-unread-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'chat-unread-badge';
      badge.style.cssText = 'display: inline-block; width: 10px; height: 10px; background: #e63946; border-radius: 50%; margin-left: 8px;';
      var header = chatPanel.querySelector('div');
      if (header) header.appendChild(badge);
    }
    badge.style.display = 'inline-block';
  }

  function hideUnreadBadge() {
    var badge = document.getElementById('chat-unread-badge');
    if (badge) badge.style.display = 'none';
    unreadMessageCount = 0;
  }

  // Clear unread badge when page becomes visible (Fix #2)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        hideUnreadBadge();
      }
    });
  }

  /**
   * Handle typing indicator — send typing event debounced (Fix #3).
   */
  function handleTypingInput() {
    var now = Date.now();
    if (now - lastTypingSent > 3000) {
      lastTypingSent = now;
      sendWebSocketMessage('typing', {});
    }
  }

  /**
   * Show "Someone is typing..." indicator (Fix #3).
   */
  function showTypingIndicator(displayName) {
    var messagesEl = document.getElementById('chat-messages');
    if (!messagesEl) return;

    var indicator = document.getElementById('typing-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'typing-indicator';
      indicator.style.cssText = 'color: #8b949e; font-style: italic; font-size: 12px; padding: 4px 0;';
      messagesEl.parentNode.insertBefore(indicator, messagesEl.nextSibling);
    }
    indicator.textContent = (displayName || 'Someone') + ' is typing...';
    indicator.style.display = 'block';

    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(function() {
      indicator.style.display = 'none';
    }, 3000);
  }

  // --- Captions ---

  // Transcription state
  let transcribeWs = null;
  let transcriptionActive = false;
  let audioContext = null;
  let audioProcessor = null;
  let captionSourceStream = null;

  /**
   * Add a "Start Captions" button to the caption area for presenters.
   */
  function addCaptionControlButton() {
    var captionArea = document.getElementById('caption-area');
    if (!captionArea) return;

    var headerDiv = captionArea.querySelector('div');
    if (!headerDiv) return;

    var btn = document.createElement('button');
    btn.id = 'btn-start-captions';
    btn.textContent = '▶ Start Captions';
    btn.style.cssText = 'padding: 4px 12px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #fff; font-size: 12px; cursor: pointer; margin-left: 8px;';
    btn.onclick = function() {
      if (transcriptionActive) {
        stopTranscription();
      } else {
        startTranscription();
      }
    };
    headerDiv.appendChild(btn);
  }

  /**
   * Start live transcription.
   * 1. Calls the backend to get a pre-signed Transcribe Streaming URL
   * 2. Connects to Transcribe via WebSocket
   * 3. Captures mic audio, encodes as PCM, streams to Transcribe
   * 4. Receives transcripts and broadcasts to all attendees
   */
  async function startTranscription() {
    var btn = document.getElementById('btn-start-captions');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting...';
    }

    try {
      var apiBase = window.API_BASE_URL || '/api';
      var token = Auth.getIdToken();

      // Get the source language from the caption language selector
      var langSelect = document.getElementById('caption-language-select');
      var selectedLang = langSelect ? langSelect.value : 'en';
      // Map short code to Transcribe language code
      var transcribeLangMap = {
        'en': 'en-US', 'es': 'es-US', 'fr': 'fr-FR', 'de': 'de-DE',
        'pt': 'pt-BR', 'ja': 'ja-JP', 'ko': 'ko-KR', 'zh': 'zh-CN'
      };
      var sourceLanguage = transcribeLangMap[selectedLang] || 'en-US';

      var res = await fetch(apiBase + '/events/' + encodeURIComponent(eventId) + '/transcription/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({
          sourceLanguage: sourceLanguage,
          sampleRate: 16000,
          mediaEncoding: 'pcm',
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to get transcription URL (' + res.status + ')');
      }

      var data = await res.json();
      var presignedUrl = data.presignedUrl;

      // Connect to Amazon Transcribe Streaming via WebSocket
      await connectToTranscribe(presignedUrl);

      transcriptionActive = true;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⏹ Stop Captions';
        btn.style.background = '#e63946';
        btn.style.borderColor = '#e63946';
      }

      var captionEl = document.getElementById('caption-text');
      if (captionEl) {
        captionEl.textContent = '';
        captionEl.style.fontStyle = 'normal';
        captionEl.style.color = '#e6edf3';
      }
    } catch (err) {
      console.error('Failed to start transcription:', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '▶ Start Captions';
      }
      showNotification('Failed to start captions: ' + (err.message || 'Unknown error'));
    }
  }

  /**
   * Connect to Amazon Transcribe Streaming WebSocket and start audio capture.
   * @param {string} presignedUrl - The pre-signed WebSocket URL for Transcribe.
   */
  async function connectToTranscribe(presignedUrl) {
    // Set up audio capture from the presenter's microphone.
    // Do NOT request a specific sampleRate in getUserMedia — it's ignored
    // on most platforms and causes "operation is insecure" errors on some.
    // We capture at the browser's native rate and resample to 16kHz in the
    // onaudioprocess callback.
    var stream;
    if (localStreams.mic) {
      stream = new MediaStream([localStreams.mic]);
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
    }
    captionSourceStream = stream;

    // Use the browser's native sample rate — forcing 16000 on AudioContext
    // causes NotSupportedError / "operation is insecure" on many platforms.
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var nativeSampleRate = audioContext.sampleRate;
    var source = audioContext.createMediaStreamSource(stream);

    var bufferSize = 4096;
    audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    // Connect to Transcribe WebSocket
    transcribeWs = new WebSocket(presignedUrl);
    transcribeWs.binaryType = 'arraybuffer';

    var partialTranscript = '';

    transcribeWs.onopen = function() {
      console.log('Transcribe WebSocket connected');
      // Route through silent gain so mic audio doesn't feed back to speakers.
      var silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(audioContext.destination);
      source.connect(audioProcessor);
      audioProcessor.connect(silentGain);
    };

    transcribeWs.onmessage = function(event) {
      try {
        // Transcribe Streaming returns event-stream encoded messages
        var message = decodeTranscribeMessage(event.data);
        if (message && message.Transcript && message.Transcript.Results) {
          message.Transcript.Results.forEach(function(result) {
            if (result.Alternatives && result.Alternatives.length > 0) {
              var transcript = result.Alternatives[0].Transcript;
              if (result.IsPartial) {
                // Show partial transcript locally
                partialTranscript = transcript;
                displayCaption(transcript);
              } else {
                // Final transcript — broadcast to all attendees
                partialTranscript = '';
                displayCaption(transcript);
                broadcastCaptionToAttendees(transcript, captionLanguage);
              }
            }
          });
        }
      } catch (err) {
        // Some messages may not be JSON (binary event stream)
        // Try the event-stream binary decoder
        try {
          var decoded = decodeEventStreamMessage(event.data);
          if (decoded) {
            if (decoded.Transcript && decoded.Transcript.Results) {
              decoded.Transcript.Results.forEach(function(result) {
                if (result.Alternatives && result.Alternatives.length > 0) {
                  var transcript = result.Alternatives[0].Transcript;
                  if (!result.IsPartial) {
                    displayCaption(transcript);
                    broadcastCaptionToAttendees(transcript, captionLanguage);
                  } else {
                    displayCaption(transcript);
                  }
                }
              });
            }
          }
        } catch (e2) {
          // Ignore decode errors for non-transcript messages
        }
      }
    };

    transcribeWs.onerror = function(err) {
      console.error('Transcribe WebSocket error:', err);
    };

    transcribeWs.onclose = function() {
      console.log('Transcribe WebSocket closed');
    };

    // Send audio frames to Transcribe — resample to 16kHz if needed
    audioProcessor.onaudioprocess = function(e) {
      if (!transcribeWs || transcribeWs.readyState !== WebSocket.OPEN) return;

      var inputData = e.inputBuffer.getChannelData(0);

      // Resample from native browser rate to 16kHz (required by Transcribe)
      var samples;
      if (nativeSampleRate !== 16000) {
        var ratio = nativeSampleRate / 16000;
        var newLength = Math.round(inputData.length / ratio);
        samples = new Float32Array(newLength);
        for (var i = 0; i < newLength; i++) {
          samples[i] = inputData[Math.round(i * ratio)] || 0;
        }
      } else {
        samples = inputData;
      }

      var pcmData = float32ToInt16(samples);
      var frame = encodeAudioEvent(pcmData);
      transcribeWs.send(frame);
    };
  }

  /**
   * Stop live transcription and clean up resources.
   */
  function stopTranscription() {
    transcriptionActive = false;

    if (audioProcessor) {
      audioProcessor.disconnect();
      audioProcessor = null;
    }
    if (audioContext) {
      audioContext.close().catch(function() {});
      audioContext = null;
    }
    if (transcribeWs) {
      transcribeWs.close();
      transcribeWs = null;
    }
    // Don't stop captionSourceStream if it's the shared mic track
    if (captionSourceStream && !localStreams.mic) {
      captionSourceStream.getTracks().forEach(function(t) { t.stop(); });
    }
    captionSourceStream = null;

    var btn = document.getElementById('btn-start-captions');
    if (btn) {
      btn.textContent = '▶ Start Captions';
      btn.style.background = '#21262d';
      btn.style.borderColor = '#30363d';
    }

    var captionEl = document.getElementById('caption-text');
    if (captionEl) {
      captionEl.textContent = 'Captions stopped';
      captionEl.style.fontStyle = 'italic';
      captionEl.style.color = '#8b949e';
    }
  }

  /**
   * Broadcast a caption to all attendees via WebSocket.
   * @param {string} text - The transcribed text.
   * @param {string} language - The language code.
   */
  function broadcastCaptionToAttendees(text, language) {
    sendWebSocketMessage('broadcastCaption', {
      text: text,
      language: language || 'en',
      isFinal: true,
    });
  }

  /**
   * Convert Float32Array audio samples to Int16 PCM.
   * @param {Float32Array} float32Array - Input audio samples (-1.0 to 1.0).
   * @returns {ArrayBuffer} Int16 PCM encoded audio.
   */
  function float32ToInt16(float32Array) {
    var buffer = new ArrayBuffer(float32Array.length * 2);
    var view = new DataView(buffer);
    for (var i = 0; i < float32Array.length; i++) {
      var s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  /**
   * Encode audio data into an AWS event-stream frame for Transcribe Streaming.
   * The event-stream format requires specific headers and framing.
   * @param {ArrayBuffer} pcmData - The PCM audio data.
   * @returns {ArrayBuffer} The encoded event-stream frame.
   */
  function encodeAudioEvent(pcmData) {
    // Event stream message format:
    // [total_length:4][headers_length:4][prelude_crc:4][headers][payload][message_crc:4]
    var contentType = ':content-type';
    var contentTypeValue = 'application/octet-stream';
    var eventType = ':event-type';
    var eventTypeValue = 'AudioEvent';
    var messageType = ':message-type';
    var messageTypeValue = 'event';

    // Build headers
    var headers = [];
    headers.push(buildHeader(contentType, 7, contentTypeValue));
    headers.push(buildHeader(eventType, 7, eventTypeValue));
    headers.push(buildHeader(messageType, 7, messageTypeValue));

    var headersBuffer = concatArrayBuffers(headers);
    var headersLength = headersBuffer.byteLength;
    var payloadLength = pcmData.byteLength;
    var totalLength = 4 + 4 + 4 + headersLength + payloadLength + 4; // prelude + headers + payload + message_crc

    var message = new ArrayBuffer(totalLength);
    var view = new DataView(message);
    var offset = 0;

    // Total byte length
    view.setUint32(offset, totalLength, false); offset += 4;
    // Headers byte length
    view.setUint32(offset, headersLength, false); offset += 4;
    // Prelude CRC (CRC of first 8 bytes)
    var preludeCrc = crc32(new Uint8Array(message, 0, 8));
    view.setUint32(offset, preludeCrc, false); offset += 4;

    // Headers
    new Uint8Array(message, offset, headersLength).set(new Uint8Array(headersBuffer));
    offset += headersLength;

    // Payload
    new Uint8Array(message, offset, payloadLength).set(new Uint8Array(pcmData));
    offset += payloadLength;

    // Message CRC (CRC of everything except last 4 bytes)
    var messageCrc = crc32(new Uint8Array(message, 0, offset));
    view.setUint32(offset, messageCrc, false);

    return message;
  }

  /**
   * Build a single event-stream header.
   * @param {string} name - Header name.
   * @param {number} type - Header value type (7 = string).
   * @param {string} value - Header value.
   * @returns {ArrayBuffer} Encoded header.
   */
  function buildHeader(name, type, value) {
    var nameBytes = new TextEncoder().encode(name);
    var valueBytes = new TextEncoder().encode(value);
    var buffer = new ArrayBuffer(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    var view = new DataView(buffer);
    var offset = 0;

    // Header name length (1 byte)
    view.setUint8(offset, nameBytes.length); offset += 1;
    // Header name
    new Uint8Array(buffer, offset, nameBytes.length).set(nameBytes); offset += nameBytes.length;
    // Header value type (1 byte)
    view.setUint8(offset, type); offset += 1;
    // Value string length (2 bytes, big-endian)
    view.setUint16(offset, valueBytes.length, false); offset += 2;
    // Value string
    new Uint8Array(buffer, offset, valueBytes.length).set(valueBytes);

    return buffer;
  }

  /**
   * Concatenate multiple ArrayBuffers.
   * @param {ArrayBuffer[]} buffers - Array of buffers to concatenate.
   * @returns {ArrayBuffer} Combined buffer.
   */
  function concatArrayBuffers(buffers) {
    var totalLength = buffers.reduce(function(sum, buf) { return sum + buf.byteLength; }, 0);
    var result = new ArrayBuffer(totalLength);
    var view = new Uint8Array(result);
    var offset = 0;
    buffers.forEach(function(buf) {
      view.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    });
    return result;
  }

  /**
   * CRC-32 implementation for event-stream framing.
   * @param {Uint8Array} data - Data to compute CRC for.
   * @returns {number} CRC-32 value.
   */
  function crc32(data) {
    var table = crc32.table;
    if (!table) {
      table = [];
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var j = 0; j < 8; j++) {
          if (c & 1) {
            c = 0xEDB88320 ^ (c >>> 1);
          } else {
            c = c >>> 1;
          }
        }
        table.push(c >>> 0);
      }
      crc32.table = table;
    }
    var crc = 0xFFFFFFFF;
    for (var k = 0; k < data.length; k++) {
      crc = table[(crc ^ data[k]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Decode an event-stream message from Transcribe Streaming.
   * @param {ArrayBuffer} buffer - The raw WebSocket message.
   * @returns {Object|null} Parsed transcript message or null.
   */
  function decodeEventStreamMessage(buffer) {
    try {
      var view = new DataView(buffer);
      var totalLength = view.getUint32(0, false);
      var headersLength = view.getUint32(4, false);
      // Skip prelude CRC (4 bytes at offset 8)
      var headersStart = 12;
      var payloadStart = headersStart + headersLength;
      var payloadEnd = totalLength - 4; // Exclude message CRC

      if (payloadEnd <= payloadStart) return null;

      var payloadBytes = new Uint8Array(buffer, payloadStart, payloadEnd - payloadStart);
      var payloadStr = new TextDecoder().decode(payloadBytes);
      return JSON.parse(payloadStr);
    } catch (e) {
      return null;
    }
  }

  /**
   * Decode a Transcribe message (try JSON first, then event-stream).
   * @param {*} data - WebSocket message data.
   * @returns {Object|null} Parsed message or null.
   */
  function decodeTranscribeMessage(data) {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    return decodeEventStreamMessage(data);
  }

  /**
   * Set the caption language.
   * Req 19.2: Provide translated captions in selected language.
   */
  function setCaptionLanguage(langCode) {
    captionLanguage = langCode;
    // Notify backend of language preference via WebSocket
    sendWebSocketMessage('setCaptionLanguage', { language: langCode });
  }

  /**
   * Display a caption line.
   * Req 19.3: Display captions with no more than 5 seconds delay.
   */
  function displayCaption(text) {
    var captionEl = document.getElementById('caption-text');
    if (captionEl) {
      captionEl.textContent = text;
      captionEl.style.fontStyle = 'normal';
      captionEl.style.color = '#e6edf3';
    }
  }

  // --- Presenter Dashboard ---

  /**
   * Switch the active tab in the presenter dashboard.
   */
  function switchDashboardTab(tab) {
    dashboardActiveTab = tab;
    var tabs = ['attendees', 'questions', 'hands'];
    tabs.forEach(function(t) {
      var btn = document.getElementById('dashboard-tab-' + t);
      var panel = document.getElementById('dashboard-panel-' + t);
      if (btn && panel) {
        if (t === tab) {
          btn.style.background = AWS_ORANGE;
          btn.style.color = '#000';
          btn.style.fontWeight = '600';
          panel.style.display = 'block';
        } else {
          btn.style.background = '#21262d';
          btn.style.color = '#8b949e';
          btn.style.fontWeight = 'normal';
          panel.style.display = 'none';
        }
      }
    });
  }

  /**
   * Render the attendees list in the dashboard panel.
   * Shows two sections: registered users (top) and anonymous users (bottom).
   * Req 4.1: Display anonymous users visually separated from registered users.
   * Req 4.3: Display anonymous users with "Anon-{6 hex chars}" labels.
   * Req 4.4: Display total count of currently connected anonymous users.
   */
  function renderDashboardAttendees() {
    var panel = document.getElementById('dashboard-panel-attendees');
    if (!panel) return;

    var totalCount = dashboardAttendees.length + dashboardAnonymousAttendees.length;
    var countEl = document.getElementById('dashboard-count-attendees');
    if (countEl) countEl.textContent = totalCount;

    var html = '';

    // --- Registered Users Section (top) ---
    html += '<div style="margin-bottom: 8px; font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase;">Registered Users (' + dashboardAttendees.length + ')</div>';

    if (dashboardAttendees.length === 0) {
      html += '<p style="color: #8b949e; font-size: 13px; margin: 0 0 16px 0;">No registered attendees connected</p>';
    } else {
      dashboardAttendees.forEach(function(attendee) {
        var roleBadge = attendee.role === 'presenter'
          ? '<span style="background: ' + AWS_ORANGE + '; color: #000; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600;">PRESENTER</span>'
          : '<span style="background: #21262d; color: #8b949e; padding: 2px 6px; border-radius: 3px; font-size: 10px;">' + escapeHtml(attendee.role || 'attendee') + '</span>';

        var promoteHtml = '';
        if (attendee.role !== 'presenter' && attendee.role !== 'co-presenter') {
          promoteHtml = '<button onclick="LiveSession.promoteUser(\'' + escapeHtml(attendee.connectionId) + '\', \'' + escapeHtml(attendee.userId) + '\')" style="padding: 2px 6px; border-radius: 3px; border: none; background: #238636; color: #fff; font-size: 10px; cursor: pointer;" title="Promote to co-presenter">Promote</button>';
        } else if (attendee.role === 'co-presenter') {
          promoteHtml = '<button onclick="LiveSession.demoteUser(\'' + escapeHtml(attendee.connectionId) + '\', \'' + escapeHtml(attendee.userId) + '\')" style="padding: 2px 6px; border-radius: 3px; border: none; background: #6e7681; color: #fff; font-size: 10px; cursor: pointer;" title="Demote to attendee">Demote</button>';
        }

        var moderationHtml = '';
        if (attendee.role !== 'presenter') {
          moderationHtml = '<div style="display: flex; gap: 2px; margin-top: 4px;">'
            + '<button onclick="LiveSession.muteUser(\'' + escapeHtml(attendee.connectionId) + '\', \'' + escapeHtml(attendee.userId) + '\')" style="padding: 2px 6px; border-radius: 3px; border: none; background: #6e7681; color: #fff; font-size: 10px; cursor: pointer;" title="Mute audio">🔇</button>'
            + '<button onclick="LiveSession.restrictUserChat(\'' + escapeHtml(attendee.connectionId) + '\', \'' + escapeHtml(attendee.userId) + '\')" style="padding: 2px 6px; border-radius: 3px; border: none; background: #6e7681; color: #fff; font-size: 10px; cursor: pointer;" title="Restrict chat">💬</button>'
            + '<button onclick="LiveSession.kickUser(\'' + escapeHtml(attendee.connectionId) + '\', \'' + escapeHtml(attendee.userId) + '\')" style="padding: 2px 6px; border-radius: 3px; border: none; background: #da3633; color: #fff; font-size: 10px; cursor: pointer;" title="Kick">❌</button>'
            + '<button onclick="LiveSession.banUser(\'' + escapeHtml(attendee.connectionId) + '\', \'' + escapeHtml(attendee.userId) + '\')" style="padding: 2px 6px; border-radius: 3px; border: none; background: #8b0000; color: #fff; font-size: 10px; cursor: pointer;" title="Ban">🚫</button>'
            + '</div>';
        }

        html += '<div class="registered-attendee-entry" data-user-id="' + escapeHtml(attendee.userId) + '" style="padding: 8px 0; border-bottom: 1px solid #21262d; position: relative; cursor: pointer;">'
          + '<div style="display: flex; align-items: center; justify-content: space-between;">'
          + '<div>'
          + '<span style="color: #e6edf3; font-size: 13px; font-weight: 500;">' + escapeHtml(attendee.displayName || 'Unknown') + '</span>'
          + '<span style="color: #8b949e; font-size: 12px; margin-left: 8px;">' + escapeHtml(attendee.email || '') + '</span>'
          + '</div>'
          + '<div style="display: flex; gap: 4px; align-items: center;">'
          + promoteHtml
          + roleBadge
          + '</div>'
          + '</div>'
          + moderationHtml
          + '</div>';
      });
    }

    // --- Anonymous Users Section (bottom) ---
    html += '<div style="margin-top: 16px; margin-bottom: 8px; font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase;">Anonymous Viewers (<span id="dashboard-anonymous-count">' + dashboardAnonymousAttendees.length + '</span>)</div>';

    if (dashboardAnonymousAttendees.length === 0) {
      html += '<p style="color: #8b949e; font-size: 13px; margin: 0;">No anonymous viewers connected</p>';
    } else {
      dashboardAnonymousAttendees.forEach(function(anon) {
        html += '<div style="padding: 8px 0; border-bottom: 1px solid #21262d;">'
          + '<div style="display: flex; align-items: center; justify-content: space-between;">'
          + '<div>'
          + '<span style="color: #e6edf3; font-size: 13px; font-weight: 500;">👤 ' + escapeHtml(anon.displayLabel) + '</span>'
          + '</div>'
          + '<span style="background: #21262d; color: #8b949e; padding: 2px 6px; border-radius: 3px; font-size: 10px;">viewer</span>'
          + '</div>'
          + '</div>';
      });
    }

    panel.innerHTML = html;

    // Attach hover event listeners to registered user entries for profile popover
    var registeredEntries = panel.querySelectorAll('.registered-attendee-entry[data-user-id]');
    registeredEntries.forEach(function(entry) {
      var userId = entry.getAttribute('data-user-id');
      entry.addEventListener('mouseenter', function() {
        showUserProfilePopover(userId, entry);
      });
      entry.addEventListener('mouseleave', function() {
        dismissProfilePopover();
      });
    });
  }

  /**
   * Render the questions queue in the dashboard panel.
   * Shows two sections: "Pending" and "Answered".
   */
  function renderDashboardQuestions() {
    var panel = document.getElementById('dashboard-panel-questions');
    if (!panel) return;

    var countEl = document.getElementById('dashboard-count-questions');
    if (countEl) countEl.textContent = dashboardQuestions.length;

    var html = '';

    // Pending section
    html += '<div style="margin-bottom: 8px; font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase;">Pending</div>';
    if (dashboardQuestions.length === 0) {
      html += '<p style="color: #8b949e; font-size: 13px; margin: 0 0 16px 0;">No pending questions</p>';
    } else {
      dashboardQuestions.forEach(function(q) {
        var timeStr = q.submittedAt ? new Date(q.submittedAt).toLocaleTimeString() : '';
        html += '<div style="padding: 10px 0; border-bottom: 1px solid #21262d;">'
          + '<div style="display: flex; align-items: flex-start; justify-content: space-between;">'
          + '<div style="flex: 1;">'
          + '<p style="margin: 0 0 4px 0; color: #e6edf3; font-size: 13px;">' + escapeHtml(q.text) + '</p>'
          + '<span style="color: #8b949e; font-size: 11px;">' + escapeHtml(q.displayName || 'Anonymous') + ' · ' + timeStr + '</span>'
          + '</div>'
          + '<div style="display: flex; gap: 4px; margin-left: 8px;">'
          + '<button onclick="LiveSession.answerQuestion(\'' + escapeHtml(q.questionId) + '\', \'' + escapeHtml(q.submittedAt || q.timestamp || '') + '\')" style="padding: 4px 8px; border-radius: 3px; border: none; background: #238636; color: #fff; font-size: 11px; cursor: pointer;">Answer</button>'
          + '<button onclick="LiveSession.pinQuestion(\'' + escapeHtml(q.questionId) + '\', \'' + escapeHtml(q.text) + '\', \'' + escapeHtml(q.displayName || 'Anonymous') + '\')" style="padding: 4px 8px; border-radius: 3px; border: none; background: #1f6feb; color: #fff; font-size: 11px; cursor: pointer;">Pin</button>'
          + '<button onclick="LiveSession.dismissQuestion(\'' + escapeHtml(q.questionId) + '\', \'' + escapeHtml(q.submittedAt || q.timestamp || '') + '\')" style="padding: 4px 8px; border-radius: 3px; border: none; background: #6e7681; color: #fff; font-size: 11px; cursor: pointer;">Dismiss</button>'
          + '</div>'
          + '</div>'
          + '</div>';
      });
    }

    // Answered section
    if (dashboardAnsweredQuestions.length > 0) {
      html += '<div style="margin-top: 16px; margin-bottom: 8px; font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase;">Answered</div>';
      dashboardAnsweredQuestions.forEach(function(q) {
        var timeStr = q.submittedAt ? new Date(q.submittedAt).toLocaleTimeString() : '';
        var answerHtml = q.answer ? '<p style="margin: 4px 0 0 0; color: #7AA116; font-size: 12px;"><strong>A:</strong> ' + escapeHtml(q.answer) + '</p>' : '';
        html += '<div style="padding: 10px 0; border-bottom: 1px solid #21262d; opacity: 0.85;">'
          + '<div style="display: flex; align-items: flex-start; justify-content: space-between;">'
          + '<div style="flex: 1;">'
          + '<p style="margin: 0 0 4px 0; color: #e6edf3; font-size: 13px;">Q: ' + escapeHtml(q.text) + '</p>'
          + answerHtml
          + '<span style="color: #8b949e; font-size: 11px;">' + escapeHtml(q.displayName || 'Anonymous') + ' · ' + timeStr + '</span>'
          + '</div>'
          + '<span style="padding: 4px 8px; border-radius: 3px; background: #238636; color: #fff; font-size: 11px;">✓ Answered</span>'
          + '</div>'
          + '</div>';
      });
    }

    panel.innerHTML = html;
  }

  /**
   * Render the raised hands list in the dashboard panel.
   */
  function renderDashboardHands() {
    var panel = document.getElementById('dashboard-panel-hands');
    if (!panel) return;

    var countEl = document.getElementById('dashboard-count-hands');
    if (countEl) countEl.textContent = dashboardHands.length;

    if (dashboardHands.length === 0) {
      panel.innerHTML = '<p style="color: #8b949e; font-size: 13px; margin: 0;">No raised hands</p>';
      return;
    }

    var html = '';
    dashboardHands.forEach(function(h) {
      var timeStr = h.timestamp ? new Date(h.timestamp).toLocaleTimeString() : '';
      html += '<div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #21262d;">'
        + '<div>'
        + '<span style="color: #e6edf3; font-size: 13px;">✋ ' + escapeHtml(h.displayName || 'Unknown') + '</span>'
        + '<span style="color: #8b949e; font-size: 11px; margin-left: 8px;">' + timeStr + '</span>'
        + '</div>'
        + '<div style="display: flex; gap: 4px;">'
        + '<button onclick="LiveSession.acknowledgeHand(\'' + escapeHtml(h.userId) + '\', \'' + escapeHtml(h.timestamp || '') + '\')" style="padding: 4px 8px; border-radius: 3px; border: none; background: #238636; color: #fff; font-size: 11px; cursor: pointer;">Acknowledge</button>'
        + '<button onclick="LiveSession.dismissHand(\'' + escapeHtml(h.userId) + '\', \'' + escapeHtml(h.timestamp || '') + '\')" style="padding: 4px 8px; border-radius: 3px; border: none; background: #6e7681; color: #fff; font-size: 11px; cursor: pointer;">Dismiss</button>'
        + '</div>'
        + '</div>';
    });
    panel.innerHTML = html;
  }

  // --- Presenter Action Functions ---

  /**
   * Acknowledge a raised hand — grants speak permission.
   * Req 4.2: Remove hand record, broadcast HAND_LOWERED, grant speak.
   */
  function acknowledgeHand(userId, timestamp) {
    sendWebSocketMessage('acknowledgeHand', { userId: userId, timestamp: timestamp });
  }

  /**
   * Dismiss a raised hand — no speak permission granted.
   * Req 4.3: Remove hand record, broadcast HAND_LOWERED, no speak grant.
   */
  function dismissHand(userId, timestamp) {
    sendWebSocketMessage('dismissHand', { userId: userId, timestamp: timestamp });
  }

  /**
   * Mark a question as answered.
   * Req 3.2: Update status to "answered", broadcast QUESTION_ANSWERED.
   */
  function answerQuestion(questionId, timestamp) {
    var answer = prompt('Type your answer:');
    if (answer === null) return; // cancelled
    sendWebSocketMessage('answerQuestion', { questionId: questionId, timestamp: timestamp, answer: answer });
  }

  /**
   * Dismiss a question from the queue.
   * Req 3.3: Update status to "dismissed", broadcast QUESTION_DISMISSED.
   */
  function dismissQuestion(questionId, timestamp) {
    sendWebSocketMessage('dismissQuestion', { questionId: questionId, timestamp: timestamp });
  }

  /**
   * Pin a question so it's visible to all participants.
   * Prompts the presenter for an answer before pinning.
   */
  function pinQuestion(questionId, text, displayName) {
    var answer = prompt('Type your answer (or leave blank to pin without answer):') || '';
    sendWebSocketMessage('pinQuestion', { questionId: questionId, text: text, displayName: displayName, answer: answer });
  }

  /**
   * Unpin the currently pinned question.
   */
  function unpinQuestion(questionId) {
    sendWebSocketMessage('unpinQuestion', { questionId: questionId });
  }

  /**
   * Render the pinned question banner above the video area.
   * Visible to all users (presenter and attendees).
   * Shows answer if provided.
   */
  function renderPinnedQuestion() {
    var existing = document.getElementById('pinned-question-banner');
    if (existing) existing.remove();

    if (!pinnedQuestion) return;

    var container = document.getElementById('stage-video-container');
    if (!container) return;

    var banner = document.createElement('div');
    banner.id = 'pinned-question-banner';
    banner.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; z-index: 10; background: rgba(31, 111, 235, 0.95); color: #fff; padding: 10px 16px; font-size: 13px; display: flex; align-items: center; justify-content: space-between;';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');

    var textContent = '';
    if (pinnedQuestion.answer) {
      textContent = '📌 Q: ' + escapeHtml(pinnedQuestion.text) + ' — A: ' + escapeHtml(pinnedQuestion.answer);
    } else {
      textContent = '📌 ' + escapeHtml(pinnedQuestion.text);
    }

    var textHtml = '<div style="flex: 1;"><span>' + textContent + '</span>'
      + '<span style="margin-left: 8px; opacity: 0.8; font-size: 11px;">— ' + escapeHtml(pinnedQuestion.displayName || 'Anonymous') + '</span></div>';

    var unpinHtml = '';
    if (userRole === 'presenter') {
      unpinHtml = '<button onclick="LiveSession.unpinQuestion(\'' + escapeHtml(pinnedQuestion.questionId) + '\')" style="padding: 4px 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.4); background: transparent; color: #fff; font-size: 11px; cursor: pointer; margin-left: 8px;">Unpin</button>';
    }

    banner.innerHTML = textHtml + unpinHtml;
    container.insertBefore(banner, container.firstChild);
  }

  /**
   * Request initial dashboard state from the server.
   * Called when dashboard renders and on WebSocket reconnect.
   */
  function requestDashboardState() {
    sendWebSocketMessage('getAttendeeList', {});
    sendWebSocketMessage('getQuestionQueue', {});
    sendWebSocketMessage('getHandsList', {});
  }

  // --- Countdown Timer ---

  /**
   * Initialize the countdown timer from session state.
   * Req 7.1: Include scheduledEnd in session state for client-side countdown.
   * Req 7.5: Hide countdown for open-ended events.
   * @param {string|null} endTime - ISO 8601 scheduledEnd or null for open-ended.
   */
  function initCountdown(endTime) {
    scheduledEnd = endTime || null;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    var timerEl = document.getElementById('countdown-timer');
    if (!timerEl) return;

    if (!scheduledEnd) {
      timerEl.style.display = 'none';
      return;
    }

    timerEl.style.display = 'inline-block';
    updateCountdownDisplay();
    countdownInterval = setInterval(updateCountdownDisplay, 1000);
  }

  /**
   * Update the countdown display element with remaining time.
   * Format: "Xh Ym Zs remaining" or "Ym Zs remaining" if under 1 hour.
   */
  function updateCountdownDisplay() {
    var timerEl = document.getElementById('countdown-timer');
    if (!timerEl || !scheduledEnd) return;

    var now = Date.now();
    var endMs = new Date(scheduledEnd).getTime();
    var remainingMs = endMs - now;

    if (remainingMs <= 0) {
      timerEl.textContent = '0s remaining';
      timerEl.style.background = '#e63946';
      timerEl.style.color = '#fff';
      timerEl.style.borderColor = '#e63946';
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      return;
    }

    var totalSeconds = Math.floor(remainingMs / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    var display = '';
    if (hours > 0) {
      display = hours + 'h ' + minutes + 'm ' + seconds + 's remaining';
    } else {
      display = minutes + 'm ' + seconds + 's remaining';
    }

    timerEl.textContent = display;

    // Visual styling based on remaining time
    if (totalSeconds <= 60) {
      timerEl.style.background = '#e63946';
      timerEl.style.color = '#fff';
      timerEl.style.borderColor = '#e63946';
    } else if (totalSeconds <= 300) {
      timerEl.style.background = '#d4880f';
      timerEl.style.color = '#fff';
      timerEl.style.borderColor = '#d4880f';
    } else {
      timerEl.style.background = '#21262d';
      timerEl.style.color = '#e6edf3';
      timerEl.style.borderColor = '#30363d';
    }
  }

  /**
   * Show a time warning alert banner.
   * Req 7.3: TIME_WARNING at 5 minutes.
   * Req 7.4: FINAL_WARNING at 1 minute.
   * @param {string} type - 'TIME_WARNING' or 'FINAL_WARNING'
   * @param {object} data - { remainingSeconds, scheduledEnd, message }
   */
  function showTimeWarning(type, data) {
    var container = document.getElementById('live-session-container');
    if (!container) return;

    var alertEl = document.createElement('div');
    alertEl.setAttribute('role', 'alert');
    alertEl.setAttribute('aria-live', 'assertive');

    if (type === 'FINAL_WARNING') {
      alertEl.style.cssText = 'position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #e63946; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; z-index: 1001; box-shadow: 0 4px 12px rgba(230,57,70,0.4); text-align: center;';
      alertEl.textContent = data.message || 'Event ending in 1 minute';
    } else {
      alertEl.style.cssText = 'position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #d4880f; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; z-index: 1001; box-shadow: 0 4px 12px rgba(212,136,15,0.4); text-align: center;';
      alertEl.textContent = data.message || 'Event ending in 5 minutes';
    }

    document.body.appendChild(alertEl);

    setTimeout(function() {
      alertEl.remove();
    }, 8000);
  }

  /**
   * Handle DURATION_EXTENDED message: update scheduledEnd and reset countdown.
   * Req 6.4: Broadcast DURATION_EXTENDED to update clients.
   * @param {object} data - { newScheduledEnd, additionalMinutes, remainingSeconds, newDurationMinutes }
   */
  function handleDurationExtended(data) {
    if (data.newScheduledEnd) {
      scheduledEnd = data.newScheduledEnd;
      if (countdownInterval) {
        clearInterval(countdownInterval);
      }
      var timerEl = document.getElementById('countdown-timer');
      if (timerEl) {
        timerEl.style.display = 'inline-block';
      }
      updateCountdownDisplay();
      countdownInterval = setInterval(updateCountdownDisplay, 1000);
      showNotification('Event extended by ' + data.additionalMinutes + ' minutes');
    }
  }

  /**
   * Handle EVENT_ENDED — clear the video container and show an ended message.
   * If a recording URL is available, show a link to it.
   */
  function handleEventEnded(data) {
    // Stop countdown
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    // Clear all video/audio elements from the stage container
    var videoContainer = document.getElementById('stage-video-container');
    if (videoContainer) {
      // Remove all video and audio children
      var media = videoContainer.querySelectorAll('video, audio');
      media.forEach(function(el) { el.srcObject = null; el.remove(); });

      // Show ended message
      var recordingHtml = '';
      if (data && data.hlsPlaybackUrl) {
        recordingHtml = '<a href="#/events/' + escapeHtml(eventId) + '" class="btn btn--outline" style="margin-top: 12px; display: inline-block;">View Recording</a>';
      } else {
        recordingHtml = '<p style="color: #8b949e; font-size: 13px; margin-top: 8px;">A recording will be available shortly.</p>';
      }

      videoContainer.innerHTML =
        '<div style="text-align: center; padding: 40px;">' +
          '<div style="font-size: 48px; margin-bottom: 16px;">📺</div>' +
          '<h3 style="color: #e6edf3; margin: 0 0 8px 0;">This event has ended</h3>' +
          '<p style="color: #8b949e;">Thanks for joining!</p>' +
          recordingHtml +
        '</div>';
    }

    // Show notification to all participants
    if (userRole !== 'presenter') {
      showNotification('The event has ended. Thank you for attending!');
    }

    // Fetch the event detail page to get the recording URL if not in the WS message
    if (eventId && (!data || !data.hlsPlaybackUrl)) {
      var apiBase = window.API_BASE_URL || '/api';
      fetch(apiBase + '/events/' + encodeURIComponent(eventId))
        .then(function(r) { return r.json(); })
        .then(function(evt) {
          if (evt.hlsPlaybackUrl || evt.recordingUrl) {
            var url = evt.hlsPlaybackUrl || evt.recordingUrl;
            var recordingBtn = videoContainer && videoContainer.querySelector('a.btn--outline');
            if (!recordingBtn && videoContainer) {
              var p = videoContainer.querySelector('p:last-child');
              if (p) {
                p.innerHTML = '<a href="#/events/' + escapeHtml(eventId) + '" class="btn btn--outline" style="margin-top: 12px; display: inline-block;">View Recording</a>';
              }
            }
          }
        })
        .catch(function() {});
    }
  }

  // --- WebSocket Connection ---

  /**
   * Connect to the signaling WebSocket for hand-raising, questions, etc.
   */
  function connectWebSocket(wsUrl) {
    if (!wsUrl) return;

    try {
      websocket = new WebSocket(wsUrl);

      websocket.onopen = function() {
        console.log('LiveSession: WebSocket connected');
        // Re-request dashboard state on reconnect (Task 7.4)
        if (userRole === 'presenter') {
          requestDashboardState();
        }
      };

      websocket.onmessage = function(event) {
        handleWebSocketMessage(event.data);
      };

      websocket.onclose = function() {
        console.log('LiveSession: WebSocket disconnected');
        // Only reconnect if not intentionally disconnected
        if (websocket !== null) {
          setTimeout(function() {
            connectWebSocket(wsUrl);
          }, 3000);
        }
      };

      websocket.onerror = function(err) {
        console.error('LiveSession: WebSocket error', err);
      };
    } catch (err) {
      console.error('LiveSession: Failed to connect WebSocket', err);
    }
  }

  /**
   * Send a message over the signaling WebSocket.
   */
  function sendWebSocketMessage(action, data) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      console.warn('LiveSession: WebSocket not connected');
      return;
    }
    websocket.send(JSON.stringify({
      action: action,
      eventId: eventId,
      data: data
    }));
  }

  /**
   * Handle incoming WebSocket messages.
   */
  function handleWebSocketMessage(rawData) {
    try {
      var msg = JSON.parse(rawData);
      switch (msg.type) {
        case 'ATTENDEE_JOINED':
          if (msg.data && userRole === 'presenter') {
            dashboardAttendees.push({
              userId: msg.data.userId,
              displayName: msg.data.displayName,
              email: msg.data.email,
              role: msg.data.role,
              connectionId: msg.data.connectionId
            });
            renderDashboardAttendees();
          }
          break;
        case 'ATTENDEE_LEFT':
          if (msg.data && userRole === 'presenter') {
            dashboardAttendees = dashboardAttendees.filter(function(a) {
              return a.userId !== msg.data.userId;
            });
            renderDashboardAttendees();
          }
          break;
        case 'ATTENDEE_LIST':
          if (msg.data && userRole === 'presenter') {
            dashboardAttendees = msg.data.attendees || [];
            renderDashboardAttendees();
          }
          break;
        case 'ANON_JOINED':
          if (msg.data && userRole === 'presenter') {
            dashboardAnonymousAttendees.push({
              fingerprint: msg.data.fingerprint,
              displayLabel: msg.data.label || ('Anon-' + (msg.data.fingerprint || '').substring(0, 6)),
              sessionId: msg.data.sessionId,
              joinedAt: msg.data.joinedAt || new Date().toISOString()
            });
            renderDashboardAttendees();
          }
          break;
        case 'ANON_LEFT':
          if (msg.data && userRole === 'presenter') {
            dashboardAnonymousAttendees = dashboardAnonymousAttendees.filter(function(a) {
              return a.fingerprint !== msg.data.fingerprint;
            });
            renderDashboardAttendees();
          }
          break;
        case 'ANON_LIST':
          if (msg.data && userRole === 'presenter') {
            dashboardAnonymousAttendees = (msg.data.anonymous || []).map(function(a) {
              return {
                fingerprint: a.fingerprint,
                displayLabel: a.label || ('Anon-' + (a.fingerprint || '').substring(0, 6)),
                sessionId: a.sessionId,
                joinedAt: a.joinedAt
              };
            });
            renderDashboardAttendees();
          }
          break;
        case 'QUESTION_SUBMITTED':
          if (msg.data && userRole === 'presenter') {
            dashboardQuestions.push({
              questionId: msg.data.questionId,
              userId: msg.data.userId,
              displayName: msg.data.displayName,
              text: msg.data.text,
              submittedAt: msg.data.submittedAt || msg.data.timestamp
            });
            renderDashboardQuestions();
          }
          break;
        case 'QUESTION_ANSWERED':
          if (msg.data && userRole === 'presenter') {
            var answeredQ = dashboardQuestions.find(function(q) {
              return q.questionId === msg.data.questionId;
            });
            dashboardQuestions = dashboardQuestions.filter(function(q) {
              return q.questionId !== msg.data.questionId;
            });
            if (answeredQ) {
              answeredQ.answer = msg.data.answer || '';
              dashboardAnsweredQuestions.push(answeredQ);
            }
            renderDashboardQuestions();
          } else {
            // Update mySubmittedQuestions if this is our question (Fix #1)
            var myQ = mySubmittedQuestions.find(function(q) { return q.status === 'queued'; });
            if (myQ) {
              myQ.status = 'answered';
              myQ.answer = msg.data.answer || '';
              renderMyQuestions();
            }
            var answerText = msg.data.answer ? ': ' + msg.data.answer : '';
            showNotification('Your question has been answered' + answerText);
          }
          break;
        case 'QUESTION_DISMISSED':
          if (msg.data && userRole === 'presenter') {
            dashboardQuestions = dashboardQuestions.filter(function(q) {
              return q.questionId !== msg.data.questionId;
            });
            renderDashboardQuestions();
          } else {
            // Update mySubmittedQuestions (Fix #1)
            var myDismissedQ = mySubmittedQuestions.find(function(q) { return q.status === 'queued'; });
            if (myDismissedQ) {
              myDismissedQ.status = 'dismissed';
              renderMyQuestions();
            }
            showNotification('Your question was dismissed.');
          }
          break;
        case 'QUESTION_QUEUE':
          if (msg.data && userRole === 'presenter') {
            dashboardQuestions = msg.data.questions || [];
            dashboardAnsweredQuestions = msg.data.answered || [];
            renderDashboardQuestions();
          }
          break;
        case 'QUESTION_PINNED':
          if (msg.data) {
            pinnedQuestion = {
              questionId: msg.data.questionId,
              text: msg.data.text,
              displayName: msg.data.displayName,
              answer: msg.data.answer || ''
            };
            renderPinnedQuestion();
          }
          break;
        case 'QUESTION_UNPINNED':
          pinnedQuestion = null;
          renderPinnedQuestion();
          break;
        case 'HAND_RAISED':
          if (msg.data && userRole === 'presenter') {
            dashboardHands.push({
              userId: msg.data.userId,
              displayName: msg.data.displayName,
              timestamp: msg.data.timestamp
            });
            renderDashboardHands();
          }
          break;
        case 'HAND_LOWERED':
          if (msg.data && userRole === 'presenter') {
            dashboardHands = dashboardHands.filter(function(h) {
              return h.userId !== msg.data.userId;
            });
            renderDashboardHands();
          }
          break;
        case 'HANDS_LIST':
          if (msg.data && userRole === 'presenter') {
            dashboardHands = msg.data.hands || [];
            renderDashboardHands();
          }
          break;
        case 'CAPTION':
          if (msg.data && msg.data.language === captionLanguage) {
            displayCaption(msg.data.text);
          }
          break;
        case 'ROLE_CHANGED':
          if (msg.data && msg.data.role) {
            userRole = msg.data.role;
            renderUI();
          }
          break;
        case 'MUTED_BY_PRESENTER':
          stopMic();
          showNotification('You have been muted by the presenter.');
          break;
        case 'SPEAK_GRANTED':
          showNotification('You have been granted speaking permission.');
          break;
        case 'SPEAK_REVOKED':
          stopMic();
          showNotification('Speaking permission revoked.');
          break;
        case 'TIME_WARNING':
          showTimeWarning('TIME_WARNING', msg.data || {});
          break;
        case 'FINAL_WARNING':
          showTimeWarning('FINAL_WARNING', msg.data || {});
          break;
        case 'EVENT_ENDED':
          handleEventEnded(msg.data || {});
          break;
        case 'DURATION_EXTENDED':
          handleDurationExtended(msg.data || {});
          break;
        case 'DIRECT_MESSAGE':
          if (msg.data) {
            var dmSender = msg.data.displayName || msg.data.userId || 'Unknown';
            appendChatMessage(dmSender + ' (DM)', msg.data.message, 'direct');
          }
          break;
        case 'DIRECT_MESSAGE_CONFIRMED':
          // Already shown locally when sent
          break;
        case 'KICKED':
          showNotification('You have been removed from this session.');
          disconnect();
          break;
        case 'TYPING':
          if (msg.data && msg.data.userId !== currentUserId) {
            showTypingIndicator(msg.data.displayName);
          }
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('LiveSession: Failed to parse WebSocket message', err);
    }
  }


  // --- Utilities ---

  /**
   * Update a control button's text and active state.
   */
  function updateControlButton(btnId, text, active) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.textContent = text;
    if (active) {
      btn.style.background = AWS_ORANGE;
      btn.style.color = '#000';
      btn.style.borderColor = AWS_ORANGE;
    } else {
      btn.style.background = '#21262d';
      btn.style.color = '#fff';
      btn.style.borderColor = '#30363d';
    }
  }

  /**
   * Show a notification message to the user.
   */
  function showNotification(message) {
    var container = document.getElementById('live-session-container');
    if (!container) return;

    var notif = document.createElement('div');
    notif.style.cssText = 'position: fixed; top: 80px; right: 24px; background: ' + SQUID_INK + '; color: #fff; padding: 12px 20px; border-radius: 8px; border: 1px solid #30363d; font-size: 14px; z-index: 1000; max-width: 360px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
    notif.textContent = message;
    notif.setAttribute('role', 'alert');
    document.body.appendChild(notif);

    setTimeout(function() {
      notif.remove();
    }, 5000);
  }

  // --- User Profile Popover ---

  // Cache for fetched user profiles to avoid redundant API calls
  var profileCache = {};
  // Reference to the currently active popover element
  var activePopover = null;
  // Timeout for dismissing the popover
  var popoverDismissTimeout = null;
  // Timeout for showing the popover (debounce rapid hovers)
  var popoverShowTimeout = null;

  /**
   * Show a hover popover with registered user profile details.
   * Fetches user profile from the API and displays it in a tooltip/popover within 1 second.
   * Does NOT trigger for anonymous user entries.
   * Works during both live meetings and recorded playback.
   * Req 9.1, 9.2, 9.3, 9.4
   *
   * @param {string} userId - The registered user's ID
   * @param {HTMLElement} targetEl - The element being hovered
   */
  function showUserProfilePopover(userId, targetEl) {
    if (!userId || !targetEl) return;

    // Clear any pending dismiss
    if (popoverDismissTimeout) {
      clearTimeout(popoverDismissTimeout);
      popoverDismissTimeout = null;
    }

    // Clear any pending show from a previous hover
    if (popoverShowTimeout) {
      clearTimeout(popoverShowTimeout);
      popoverShowTimeout = null;
    }

    // Dismiss any existing popover first
    removeActivePopover();

    // Check cache first for instant display
    if (profileCache[userId]) {
      renderPopover(profileCache[userId], targetEl);
      return;
    }

    // Fetch profile from API (must display within 1 second per Req 9.1)
    popoverShowTimeout = setTimeout(function() {}, 0);
    fetchUserProfile(userId).then(function(profile) {
      // Only render if the user is still hovering over the same element
      if (targetEl.matches(':hover')) {
        profileCache[userId] = profile;
        renderPopover(profile, targetEl);
      }
    }).catch(function(err) {
      // Req 9.7: On failure, show display name only with "details unavailable" indicator
      if (targetEl.matches(':hover')) {
        var fallbackProfile = { displayName: getFallbackDisplayName(userId, targetEl), loadFailed: true };
        renderPopover(fallbackProfile, targetEl);
      }
    });
  }

  /**
   * Fetch user profile from the API.
   * @param {string} userId - The user ID to fetch profile for
   * @returns {Promise<Object>} Profile data
   */
  function fetchUserProfile(userId) {
    var apiBase = window.API_BASE_URL || '/api';
    var token = typeof Auth !== 'undefined' && Auth.getIdToken ? Auth.getIdToken() : null;

    var headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    return fetch(apiBase + '/users/' + encodeURIComponent(userId) + '/profile', {
      method: 'GET',
      headers: headers,
    }).then(function(res) {
      if (!res.ok) {
        throw new Error('Profile fetch failed: ' + res.status);
      }
      return res.json();
    });
  }

  /**
   * Get a fallback display name from the attendee data or the target element text.
   * @param {string} userId - The user ID
   * @param {HTMLElement} targetEl - The hovered element
   * @returns {string} Display name fallback
   */
  function getFallbackDisplayName(userId, targetEl) {
    // Try to find the display name from the dashboardAttendees array
    for (var i = 0; i < dashboardAttendees.length; i++) {
      if (dashboardAttendees[i].userId === userId) {
        return dashboardAttendees[i].displayName || 'Unknown';
      }
    }
    // Fallback to text content of the element
    var nameSpan = targetEl.querySelector('span[style*="font-weight: 500"]');
    return nameSpan ? nameSpan.textContent : 'Unknown';
  }

  /**
   * Render the profile popover positioned relative to the target element.
   * Req 9.2: Display name, avatar, and other publicly available profile fields.
   *
   * @param {Object} profile - Profile data { displayName, email, avatar, role, loadFailed }
   * @param {HTMLElement} targetEl - The element to position the popover near
   */
  function renderPopover(profile, targetEl) {
    removeActivePopover();

    var popover = document.createElement('div');
    popover.id = 'user-profile-popover';
    popover.setAttribute('role', 'tooltip');
    popover.setAttribute('aria-label', 'User profile: ' + escapeHtml(profile.displayName || 'Unknown'));
    popover.style.cssText = 'position: absolute; z-index: 1500; background: ' + SQUID_INK + '; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; min-width: 220px; max-width: 300px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); color: #fff; font-size: 13px; pointer-events: none;';

    var html = '';

    // Avatar and display name header
    html += '<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">';
    if (profile.avatar) {
      html += '<img src="' + escapeHtml(profile.avatar) + '" alt="" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; border: 2px solid #30363d;">';
    } else {
      // Default avatar placeholder
      html += '<div style="width: 36px; height: 36px; border-radius: 50%; background: #21262d; display: flex; align-items: center; justify-content: center; font-size: 16px; border: 2px solid #30363d;">👤</div>';
    }
    html += '<div>';
    html += '<div style="font-weight: 600; color: #e6edf3;">' + escapeHtml(profile.displayName || 'Unknown') + '</div>';
    if (profile.email && !profile.loadFailed) {
      html += '<div style="font-size: 11px; color: #8b949e;">' + escapeHtml(profile.email) + '</div>';
    }
    html += '</div>';
    html += '</div>';

    if (profile.loadFailed) {
      // Req 9.7: Show "details unavailable" indicator on failure
      html += '<div style="font-size: 12px; color: #d29922; font-style: italic;">⚠ Profile details unavailable</div>';
    } else {
      // Show additional profile fields if available
      if (profile.role) {
        html += '<div style="margin-top: 4px; font-size: 12px; color: #8b949e;">Role: <span style="color: #e6edf3; text-transform: capitalize;">' + escapeHtml(profile.role) + '</span></div>';
      }
      if (profile.memberSince) {
        html += '<div style="margin-top: 2px; font-size: 12px; color: #8b949e;">Member since: <span style="color: #e6edf3;">' + escapeHtml(profile.memberSince) + '</span></div>';
      }
      if (profile.bio) {
        html += '<div style="margin-top: 6px; font-size: 12px; color: #8b949e; line-height: 1.4;">' + escapeHtml(profile.bio) + '</div>';
      }
    }

    popover.innerHTML = html;

    // Position the popover relative to the target element
    targetEl.style.position = 'relative';
    var rect = targetEl.getBoundingClientRect();
    var panelEl = document.getElementById('dashboard-panel-attendees');
    var panelRect = panelEl ? panelEl.getBoundingClientRect() : { top: 0, left: 0 };

    popover.style.left = '0px';
    popover.style.top = (targetEl.offsetHeight + 4) + 'px';

    targetEl.appendChild(popover);
    activePopover = popover;
  }

  /**
   * Dismiss the profile popover within 500ms when cursor moves away.
   * Req 9.5: Dismiss within 500 milliseconds.
   */
  function dismissProfilePopover() {
    if (popoverShowTimeout) {
      clearTimeout(popoverShowTimeout);
      popoverShowTimeout = null;
    }

    // Dismiss within 500ms as per requirement
    popoverDismissTimeout = setTimeout(function() {
      removeActivePopover();
    }, 300);
  }

  /**
   * Immediately remove the active popover element from the DOM.
   */
  function removeActivePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  function setPlaceholder(text) {
    var el = document.getElementById('stage-placeholder');
    if (el) {
      el.textContent = text;
      el.style.display = text ? 'block' : 'none';
    }
  }

  function showElement(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'block';
  }

  function hideElement(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  function escapeHtml(str) {
    // Escapes all five HTML/attr-significant chars so the result is safe to
    // interpolate into both element text and attribute contexts (incl.
    // single- or double-quoted onclick="...").
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Cleanup ---

  /**
   * Promote an attendee to co-presenter.
   */
  function promoteUser(connectionId, userId) {
    sendWebSocketMessage('promoteUser', { targetConnectionId: connectionId, userId: userId });
  }

  /**
   * Demote a co-presenter back to attendee.
   */
  function demoteUser(connectionId, userId) {
    sendWebSocketMessage('demoteUser', { targetConnectionId: connectionId, userId: userId });
  }

  /**
   * Mute a user's audio.
   */
  function muteUser(connectionId, userId) {
    sendWebSocketMessage('muteAudio', { targetConnectionId: connectionId, userId: userId });
    showNotification('User muted');
  }

  /**
   * Restrict a user's chat participation.
   */
  function restrictUserChat(connectionId, userId) {
    sendWebSocketMessage('restrictChat', { targetConnectionId: connectionId, userId: userId });
    showNotification('Chat restricted for user');
  }

  /**
   * Kick a user from the session.
   */
  function kickUser(connectionId, userId) {
    if (!confirm('Kick this user from the session?')) return;
    sendWebSocketMessage('kickUser', { targetConnectionId: connectionId, userId: userId });
    showNotification('User kicked');
  }

  /**
   * Ban a user from the session.
   */
  function banUser(connectionId, userId) {
    if (!confirm('Ban this user? They will not be able to rejoin.')) return;
    sendWebSocketMessage('banUser', { targetConnectionId: connectionId, userId: userId });
    showNotification('User banned');
  }

  /**
   * Disconnect from stage, chat, and WebSocket.
   */
  function disconnect() {
    // Stop transcription if active
    if (transcriptionActive) {
      stopTranscription();
    }
    if (stage) {
      stage.leave();
      stage = null;
    }
    if (chatRoom) {
      chatRoom.disconnect();
      chatRoom = null;
    }
    if (websocket) {
      var ws = websocket;
      websocket = null; // null first so onclose doesn't trigger reconnect
      ws.close();
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    scheduledEnd = null;
    // Stop all local streams
    Object.keys(localStreams).forEach(function(key) {
      if (localStreams[key]) {
        localStreams[key].stop();
        localStreams[key] = null;
      }
    });
    isScreenSharing = false;
    isCameraEnabled = false;
    isMicEnabled = false;
    isDeviceAudioEnabled = false;
    isHandRaised = false;
  }

  // --- Public API ---
  return {
    init: init,
    renderPage: renderPage,
    initCountdown: initCountdown,
    showDevicePicker: showDevicePicker,
    toggleScreenShare: toggleScreenShare,
    toggleWebcam: toggleWebcam,
    toggleMic: toggleMic,
    toggleDeviceAudio: toggleDeviceAudio,
    toggleHandRaise: toggleHandRaise,
    toggleQuestionForm: toggleQuestionForm,
    submitQuestion: submitQuestion,
    sendChatMessage: sendChatMessage,
    switchChatTab: switchChatTab,
    setCaptionLanguage: setCaptionLanguage,
    switchDashboardTab: switchDashboardTab,
    acknowledgeHand: acknowledgeHand,
    dismissHand: dismissHand,
    answerQuestion: answerQuestion,
    dismissQuestion: dismissQuestion,
    pinQuestion: pinQuestion,
    unpinQuestion: unpinQuestion,
    promoteUser: promoteUser,
    demoteUser: demoteUser,
    muteUser: muteUser,
    restrictUserChat: restrictUserChat,
    kickUser: kickUser,
    banUser: banUser,
    goLive: goLive,
    showUserProfilePopover: showUserProfilePopover,
    dismissProfilePopover: dismissProfilePopover,
    disconnect: disconnect
  };
})();
