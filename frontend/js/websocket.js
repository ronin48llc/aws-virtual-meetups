/**
 * WebSocket Client Module — Real-Time Signaling
 *
 * Manages WebSocket connection to API Gateway for real-time event signaling:
 * - Connection management with auto-reconnect (exponential backoff)
 * - Incoming message handling for all signaling events
 * - Send actions for hand-raising, questions, roles, chat control
 *
 * Validates: Requirements 5.1, 5.2, 7.1, 7.2, 8.1, 8.2, 8.3,
 *            12.1, 12.2, 13.1, 13.2, 13.3
 */

const WebSocketClient = (() => {
  'use strict';

  // --- State ---
  let socket = null;
  let wsUrl = '';
  let eventId = '';
  let token = '';
  let isConnected = false;
  let isIntentionalClose = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  const listeners = {};

  // --- Configuration ---
  const MAX_RECONNECT_ATTEMPTS = 10;
  const BASE_RECONNECT_DELAY_MS = 1000;
  const MAX_RECONNECT_DELAY_MS = 30000;

  // --- Incoming message types ---
  const MESSAGE_TYPES = [
    'HAND_RAISED',
    'HAND_LOWERED',
    'HANDS_CLEARED',
    'QUESTION_SUBMITTED',
    'QUESTION_ANSWERED',
    'QUESTION_DISMISSED',
    'ROLE_CHANGED',
    'SPEAK_PERMISSION_CHANGED',
    'CHAT_STATE_CHANGED',
    'EVENT_STARTED',
    'EVENT_ENDED'
  ];

  // --- Connection Management ---

  /**
   * Connect to the signaling WebSocket.
   * @param {object} config - { url, eventId, token }
   */
  function connect(config) {
    if (!config || !config.url) {
      console.error('WebSocketClient: url is required');
      return;
    }

    wsUrl = config.url;
    eventId = config.eventId || '';
    token = config.token || '';
    isIntentionalClose = false;
    reconnectAttempts = 0;

    _openConnection();
  }

  /**
   * Disconnect from the WebSocket (no auto-reconnect).
   */
  function disconnect() {
    isIntentionalClose = true;
    _clearReconnectTimer();

    if (socket) {
      socket.close(1000, 'Client disconnect');
      socket = null;
    }

    isConnected = false;
    _emit('disconnected', { intentional: true });
  }

  /**
   * Check if the WebSocket is currently connected.
   * @returns {boolean}
   */
  function getIsConnected() {
    return isConnected;
  }

  // --- Send Actions ---

  /**
   * Raise hand for the current user.
   * Req 12.1: Display raised-hand indicator visible to Presenter.
   */
  function raiseHand() {
    _send('raiseHand', {});
  }

  /**
   * Lower hand for the current user.
   * Req 12.2: Remove raised-hand indicator.
   */
  function lowerHand() {
    _send('lowerHand', {});
  }

  /**
   * Submit a question to the queue.
   * Req 13.1: Add question to queue in submission order.
   * @param {string} text - The question text.
   */
  function submitQuestion(text) {
    if (!text || !text.trim()) {
      console.warn('WebSocketClient: question text is required');
      return;
    }
    _send('submitQuestion', { text: text.trim() });
  }

  /**
   * Promote a user to co-presenter.
   * Req 7.1: Grant Presenter-level streaming and moderation privileges.
   * @param {string} userId - The user to promote.
   */
  function promoteUser(userId) {
    if (!userId) return;
    _send('promoteUser', { userId: userId });
  }

  /**
   * Demote a co-presenter back to attendee.
   * Req 7.2: Revoke Presenter-level privileges.
   * @param {string} userId - The user to demote.
   */
  function demoteUser(userId) {
    if (!userId) return;
    _send('demoteUser', { userId: userId });
  }

  /**
   * Grant speaking permission to an attendee.
   * @param {string} userId - The user to grant speak.
   */
  function grantSpeak(userId) {
    if (!userId) return;
    _send('grantSpeak', { userId: userId });
  }

  /**
   * Revoke speaking permission from an attendee.
   * @param {string} userId - The user to revoke speak.
   */
  function revokeSpeak(userId) {
    if (!userId) return;
    _send('revokeSpeak', { userId: userId });
  }

  /**
   * Toggle group chat enabled/disabled.
   * @param {boolean} enabled - Whether chat should be enabled.
   */
  function toggleChat(enabled) {
    _send('toggleChat', { enabled: !!enabled });
  }

  /**
   * Answer a question from the queue.
   * Req 8.2: Move question out of active queue.
   * @param {string} questionId - The question to mark as answered.
   */
  function answerQuestion(questionId) {
    if (!questionId) return;
    _send('answerQuestion', { questionId: questionId });
  }

  /**
   * Dismiss a question from the queue.
   * Req 8.3: Remove question from queue.
   * @param {string} questionId - The question to dismiss.
   */
  function dismissQuestion(questionId) {
    if (!questionId) return;
    _send('dismissQuestion', { questionId: questionId });
  }

  /**
   * Lower all raised hands (presenter action).
   * Req 5.2: Remove all raised-hand indicators.
   */
  function lowerAllHands() {
    _send('lowerAllHands', {});
  }

  // --- Event Listener API ---

  /**
   * Register a listener for a specific message type or connection event.
   * @param {string} type - Message type or 'connected'/'disconnected'/'reconnecting'/'error'
   * @param {function} callback - Handler function
   */
  function on(type, callback) {
    if (typeof callback !== 'function') return;
    if (!listeners[type]) {
      listeners[type] = [];
    }
    listeners[type].push(callback);
  }

  /**
   * Remove a listener.
   * @param {string} type - Message type
   * @param {function} callback - Handler to remove
   */
  function off(type, callback) {
    if (!listeners[type]) return;
    var idx = listeners[type].indexOf(callback);
    if (idx > -1) {
      listeners[type].splice(idx, 1);
    }
  }

  // --- Private Methods ---

  /**
   * Open the WebSocket connection.
   */
  function _openConnection() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }

    var url = wsUrl;
    // Append token as query param for authentication
    if (token) {
      var separator = url.indexOf('?') === -1 ? '?' : '&';
      url = url + separator + 'token=' + encodeURIComponent(token);
    }

    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error('WebSocketClient: Failed to create WebSocket', err);
      _scheduleReconnect();
      return;
    }

    socket.onopen = function() {
      isConnected = true;
      reconnectAttempts = 0;
      console.log('WebSocketClient: Connected');
      _emit('connected', {});
    };

    socket.onmessage = function(event) {
      _handleMessage(event.data);
    };

    socket.onclose = function(event) {
      isConnected = false;
      console.log('WebSocketClient: Closed', { code: event.code, reason: event.reason });

      if (!isIntentionalClose) {
        _emit('disconnected', { intentional: false, code: event.code });
        _scheduleReconnect();
      }
    };

    socket.onerror = function(err) {
      console.error('WebSocketClient: Error', err);
      _emit('error', { error: err });
    };
  }

  /**
   * Handle an incoming WebSocket message.
   * @param {string} rawData - Raw message string
   */
  function _handleMessage(rawData) {
    var msg;
    try {
      msg = JSON.parse(rawData);
    } catch (err) {
      console.warn('WebSocketClient: Invalid JSON message', rawData);
      return;
    }

    var type = msg.type;
    if (!type) {
      console.warn('WebSocketClient: Message missing type', msg);
      return;
    }

    // Emit to type-specific listeners
    _emit(type, msg.data || {}, msg);

    // Also emit a generic 'message' event
    _emit('message', msg);
  }

  /**
   * Send a message over the WebSocket.
   * @param {string} action - Action name
   * @param {object} data - Payload data
   */
  function _send(action, data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('WebSocketClient: Cannot send, not connected. Action:', action);
      return;
    }

    var message = JSON.stringify({
      action: action,
      eventId: eventId,
      data: data || {}
    });

    socket.send(message);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  function _scheduleReconnect() {
    if (isIntentionalClose) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('WebSocketClient: Max reconnect attempts reached');
      _emit('reconnect_failed', { attempts: reconnectAttempts });
      return;
    }

    reconnectAttempts++;
    // Exponential backoff with jitter
    var delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );
    // Add jitter (±25%)
    var jitter = delay * 0.25 * (Math.random() * 2 - 1);
    delay = Math.round(delay + jitter);

    console.log('WebSocketClient: Reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempts + ')');
    _emit('reconnecting', { attempt: reconnectAttempts, delay: delay });

    _clearReconnectTimer();
    reconnectTimer = setTimeout(function() {
      _openConnection();
    }, delay);
  }

  /**
   * Clear any pending reconnect timer.
   */
  function _clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Emit an event to registered listeners.
   * @param {string} type - Event type
   * @param {object} data - Event data
   * @param {object} [fullMessage] - Full message object (optional)
   */
  function _emit(type, data, fullMessage) {
    var handlers = listeners[type];
    if (!handlers || handlers.length === 0) return;

    for (var i = 0; i < handlers.length; i++) {
      try {
        handlers[i](data, fullMessage);
      } catch (err) {
        console.error('WebSocketClient: Listener error for ' + type, err);
      }
    }
  }

  // --- Public API ---
  return {
    connect: connect,
    disconnect: disconnect,
    isConnected: getIsConnected,
    raiseHand: raiseHand,
    lowerHand: lowerHand,
    submitQuestion: submitQuestion,
    promoteUser: promoteUser,
    demoteUser: demoteUser,
    grantSpeak: grantSpeak,
    revokeSpeak: revokeSpeak,
    toggleChat: toggleChat,
    answerQuestion: answerQuestion,
    dismissQuestion: dismissQuestion,
    lowerAllHands: lowerAllHands,
    on: on,
    off: off,
    MESSAGE_TYPES: MESSAGE_TYPES
  };
})();
